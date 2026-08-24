/**
 * Límite de peticiones para las rutas públicas.
 *
 * QUÉ PROTEGE, concretamente:
 *
 * 1. **Enumeración de pedidos.** La referencia `COCO-7F3K2M` es la única credencial
 *    del seguimiento público. Sus 28⁶ combinaciones lo hacen costoso a fuerza bruta,
 *    pero ese argumento asume que no se pueden probar miles por segundo. Este módulo
 *    es la mitad que faltaba de esa afirmación.
 *
 * 2. **Agotamiento de los céntimos identificadores.** Solo hay 99. Un bot creando
 *    pedidos en bucle los ocupa todos y deja el checkout inservible para clientes
 *    reales, sin necesidad de tumbar nada. Es la denegación de servicio más barata
 *    contra este diseño.
 *
 * 3. **Inundación de la lista de espera** y de la subida de comprobantes.
 *
 * IMPLEMENTACIÓN Y SU LÍMITE, dicho claramente: el contador vive en memoria del
 * proceso. En un despliegue con varias instancias, cada una lleva su propia cuenta,
 * así que el límite efectivo se multiplica por el número de instancias. Para el
 * volumen de esta tienda es suficiente y no añade dependencias; cuando haga falta
 * precisión, la sustitución natural es Upstash Redis y solo cambia el cuerpo de
 * `consumir()`.
 *
 * Se implementa como ventana deslizante y no como contador por intervalo fijo: con
 * intervalos fijos, alguien puede gastar el cupo entero al final de una ventana y
 * otra vez al principio de la siguiente, duplicando el límite real en el peor
 * momento.
 */

export type ResultadoLimite = {
  permitido: boolean;
  /** Cuántas peticiones quedan en la ventana. */
  restantes: number;
  /** Segundos que hay que esperar. Solo tiene sentido si `permitido` es false. */
  esperaSegundos: number;
};

export type ReglaLimite = {
  /** Peticiones permitidas dentro de la ventana. */
  maximo: number;
  ventanaMs: number;
};

/**
 * Reglas por operación.
 *
 * Los números salen de lo que hace una persona real, con margen: nadie consulta su
 * pedido 30 veces por minuto, pero sí puede refrescar unas cuantas veces mientras
 * espera la validación de su pago.
 */
export const REGLAS = {
  /** Consultar seguimiento. El más restrictivo: es el que protege de enumerar. */
  seguimiento: { maximo: 20, ventanaMs: 60_000 },
  /** Crear pedido. Un cliente legítimo crea uno, quizá dos si se equivocó. */
  crearPedido: { maximo: 5, ventanaMs: 10 * 60_000 },
  /** Subir comprobante. Puede reintentar si la primera captura salió mal. */
  comprobante: { maximo: 10, ventanaMs: 10 * 60_000 },
  /** Pedir aviso de restock. */
  listaEspera: { maximo: 10, ventanaMs: 60_000 },
  /** Añadir al carrito. Generoso: navegar y probar tallas es normal. */
  carrito: { maximo: 60, ventanaMs: 60_000 },
  /** Intentos de login del panel. Frena el ataque de fuerza bruta por contraseña. */
  login: { maximo: 8, ventanaMs: 10 * 60_000 },
} as const satisfies Record<string, ReglaLimite>;

export type NombreRegla = keyof typeof REGLAS;

/** Marcas de tiempo de las peticiones recientes, por clave. */
const registro = new Map<string, number[]>();

/**
 * Última limpieza del mapa.
 *
 * Sin purga, el mapa crece con cada IP que visita el sitio y no baja nunca: una
 * fuga de memoria lenta que en un proceso de larga vida acaba importando.
 */
let ultimaPurga = Date.now();
const INTERVALO_PURGA_MS = 5 * 60_000;

function purgar(ahora: number): void {
  if (ahora - ultimaPurga < INTERVALO_PURGA_MS) return;
  ultimaPurga = ahora;
  // La ventana más larga define cuándo una entrada deja de ser útil.
  const ventanaMaxima = Math.max(...Object.values(REGLAS).map((r) => r.ventanaMs));
  for (const [clave, marcas] of registro) {
    const vivas = marcas.filter((t) => ahora - t < ventanaMaxima);
    if (vivas.length === 0) registro.delete(clave);
    else registro.set(clave, vivas);
  }
}

/**
 * Consume una unidad del cupo.
 *
 * @param regla Qué operación se está limitando.
 * @param identificador Quién la pide: normalmente la IP. Ver `identificarPeticion`.
 */
export function consumir(
  regla: NombreRegla,
  identificador: string,
  ahora = Date.now(),
): ResultadoLimite {
  purgar(ahora);

  const { maximo, ventanaMs } = REGLAS[regla];
  const clave = `${regla}:${identificador}`;
  const previas = registro.get(clave) ?? [];

  // Ventana deslizante: solo cuentan las peticiones dentro del intervalo.
  const dentro = previas.filter((t) => ahora - t < ventanaMs);

  if (dentro.length >= maximo) {
    const masAntigua = Math.min(...dentro);
    // No se registra este intento: si se contara, un cliente insistente nunca
    // saldría del bloqueo porque cada reintento renovaría la ventana.
    registro.set(clave, dentro);
    return {
      permitido: false,
      restantes: 0,
      esperaSegundos: Math.max(1, Math.ceil((ventanaMs - (ahora - masAntigua)) / 1000)),
    };
  }

  dentro.push(ahora);
  registro.set(clave, dentro);
  return { permitido: true, restantes: maximo - dentro.length, esperaSegundos: 0 };
}

/**
 * Identifica al solicitante a partir de las cabeceras.
 *
 * En Vercel la IP real llega en `x-forwarded-for`, cuya primera entrada es el
 * cliente y el resto los proxies intermedios. Se toma solo la primera: usar la
 * cabecera completa permitiría a alguien añadir valores propios y obtener una
 * identidad nueva en cada petición, saltándose el límite.
 *
 * Cuando no hay ninguna cabecera (desarrollo local), se devuelve `"local"`. Eso
 * significa que en local todo el tráfico comparte cupo, lo cual es correcto: es un
 * solo desarrollador.
 */
export function identificarPeticion(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded !== null && forwarded.trim() !== "") {
    const primera = forwarded.split(",")[0]?.trim();
    if (primera !== undefined && primera !== "") return primera;
  }
  const real = headers.get("x-real-ip");
  if (real !== null && real.trim() !== "") return real.trim();
  return "local";
}

/** Mensaje para el cliente. Sin jerga técnica y con el tiempo concreto. */
export function mensajeLimite(esperaSegundos: number): string {
  const minutos = Math.ceil(esperaSegundos / 60);
  return esperaSegundos <= 90
    ? `Demasiados intentos. Espera unos segundos y vuelve a probar.`
    : `Demasiados intentos. Vuelve a probar en ${minutos} ${minutos === 1 ? "minuto" : "minutos"}.`;
}

/** Solo para tests: vacía el registro entre casos. */
export function reiniciarLimites(): void {
  registro.clear();
  ultimaPurga = Date.now();
}
