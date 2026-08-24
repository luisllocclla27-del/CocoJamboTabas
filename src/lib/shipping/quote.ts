/**
 * Costo de envío para el checkout, en céntimos enteros.
 *
 * Los precios NO están hardcodeados: viven en configuración (tabla `settings`) y
 * los define el comerciante. La tabla de abajo es solo un punto de partida
 * razonable para arrancar, y va a quedar desactualizada en cuanto suba el
 * combustible o cambie el motorizado. Hardcodearlos obligaría a un despliegue
 * para cambiar un precio, que es exactamente el tipo de fricción que hace que un
 * negocio pequeño acabe cobrando el envío "a ojo" por WhatsApp.
 *
 * Todo lo de este archivo es puro: recibe configuración y destino, devuelve un
 * importe. Sin red y sin base de datos, para que el precio que se muestra en el
 * checkout se pueda testear y auditar.
 */

import type { Cents } from "@/lib/money";
import { casoImposible, type ShippingQuote, type ShippingQuoteRequest } from "./types";

/** Costo de envío para una zona de Lima. */
export type ZonaLima = {
  /** Nombre canónico de la zona, para el panel. */
  readonly nombre: string;
  readonly costoCents: Cents;
  /** Distritos que la componen, en minúsculas y sin tildes. */
  readonly distritos: readonly string[];
  readonly plazo: string;
};

export type ShippingConfig = {
  /** Zonas de Lima, en orden de búsqueda. */
  readonly zonasLima: readonly ZonaLima[];
  /** Costo cuando el distrito no está en ninguna zona conocida. */
  readonly limaFallback: { readonly costoCents: Cents; readonly plazo: string };
  /**
   * Costo estimado del envío a provincia por agencia.
   *
   * Es un estimado y se marca como tal en la cotización: el precio real lo pone
   * el mostrador de Shalom según la medida de la caja. Cotizar contra la API en
   * el checkout no es viable porque esa ruta puede tardar hasta 150 s.
   */
  readonly provinciaEstimadoCents: Cents;
  readonly provinciaPlazo: string;
  /**
   * Umbral de envío gratis. `null` desactiva la promoción.
   *
   * Se compara contra el subtotal de mercadería, NO contra el total con envío:
   * incluir el envío haría que el umbral se alcanzara gracias al propio envío que
   * se quiere regalar, y el margen real no cuadraría.
   */
  readonly umbralEnvioGratisCents: Cents | null;
  /**
   * Si `true`, el envío gratis también aplica a provincia.
   *
   * Por defecto `false`: el flete a provincia es bastante más caro que un
   * motorizado en Lima y regalarlo con el mismo umbral se come el margen de una
   * venta completa.
   */
  readonly envioGratisAplicaProvincia: boolean;
  readonly direccionTienda: string;
};

/**
 * Tabla por defecto. LOS VALORES LOS DEFINE EL COMERCIANTE: esto es solo un
 * arranque coherente con lo que se cobra hoy por WhatsApp en Lima, no una
 * recomendación de precios. Al conectar la tabla `settings`, estos números deben
 * quedar como último recurso.
 */
export const CONFIG_ENVIO_DEFECTO: ShippingConfig = {
  zonasLima: [
    {
      nombre: "Lima Centro",
      costoCents: 1000,
      plazo: "24 horas",
      distritos: [
        "lima",
        "cercado de lima",
        "brena",
        "la victoria",
        "lince",
        "jesus maria",
        "san miguel",
        "magdalena del mar",
        "pueblo libre",
        "san isidro",
        "miraflores",
        "surquillo",
        "barranco",
        "san borja",
        "santiago de surco",
      ],
    },
    {
      nombre: "Lima Moderna extendida",
      costoCents: 1500,
      plazo: "24 a 48 horas",
      distritos: [
        "la molina",
        "ate",
        "santa anita",
        "el agustino",
        "san luis",
        "rimac",
        "los olivos",
        "independencia",
        "san martin de porres",
        "chorrillos",
        "san juan de miraflores",
      ],
    },
    {
      nombre: "Lima periferia",
      costoCents: 2000,
      plazo: "48 horas",
      distritos: [
        "comas",
        "carabayllo",
        "puente piedra",
        "villa el salvador",
        "villa maria del triunfo",
        "san juan de lurigancho",
        "lurin",
        "pachacamac",
        "chaclacayo",
        "lurigancho",
        "chosica",
        "ventanilla",
        "callao",
        "bellavista",
        "la perla",
        "carmen de la legua",
      ],
    },
  ],
  // Un distrito desconocido no debe bloquear la venta: se cobra la tarifa alta y
  // el admin ajusta al coordinar. Rechazar el pedido perdería la venta por un
  // nombre mal escrito.
  limaFallback: { costoCents: 2500, plazo: "48 a 72 horas" },
  provinciaEstimadoCents: 2000,
  provinciaPlazo: "2 a 5 días hábiles",
  umbralEnvioGratisCents: 25_000,
  envioGratisAplicaProvincia: false,
  direccionTienda: "Coordinamos la dirección exacta por WhatsApp",
};

/**
 * Normaliza un nombre de distrito para comparar.
 *
 * Quita tildes, pasa a minúsculas y colapsa espacios. Sin esto, "Breña",
 * "BREÑA" y "brena " serían tres distritos distintos y dos de ellos caerían al
 * fallback caro, que el cliente lee como un sobreprecio arbitrario.
 */
export function normalizarDistrito(distrito: string): string {
  return distrito
    .normalize("NFD")
    // Combining marks: quita los diacríticos ya separados por NFD.
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function buscarZonaLima(
  distrito: string,
  config: ShippingConfig = CONFIG_ENVIO_DEFECTO,
): ZonaLima | null {
  const buscado = normalizarDistrito(distrito);
  if (buscado === "") return null;
  for (const zona of config.zonasLima) {
    if (zona.distritos.some((d) => normalizarDistrito(d) === buscado)) return zona;
  }
  return null;
}

/**
 * ¿Aplica el envío gratis a este pedido?
 *
 * Se compara `>=` y contra el subtotal de mercadería. La comparación es de
 * enteros porque todo son céntimos: con floats, un subtotal de 249.99 + 0.01
 * podría quedarse a un microcéntimo del umbral y el cliente vería el envío
 * cobrado sin entender por qué.
 */
export function aplicaEnvioGratis(
  request: ShippingQuoteRequest,
  config: ShippingConfig = CONFIG_ENVIO_DEFECTO,
): boolean {
  const umbral = config.umbralEnvioGratisCents;
  if (umbral === null) return false;
  if (request.subtotalCents < umbral) return false;
  if (request.destino.modo === "provincia_agencia") return config.envioGratisAplicaProvincia;
  return request.destino.modo === "lima_domicilio";
}

/**
 * Cotiza el envío.
 *
 * Función pura y total: hay una rama por modalidad y el compilador lo verifica
 * con `casoImposible`. Si mañana se añade "envío express", falla la compilación
 * aquí en vez de devolver `undefined` al checkout.
 */
export function calcularCotizacion(
  request: ShippingQuoteRequest,
  config: ShippingConfig = CONFIG_ENVIO_DEFECTO,
): ShippingQuote {
  const destino = request.destino;

  switch (destino.modo) {
    case "recojo_tienda":
      // Gratis y sin umbral: no hay envío que cobrar. Tampoco es "estimado":
      // cero es exacto.
      return {
        modo: "recojo_tienda",
        costoCents: 0,
        costoBaseCents: 0,
        gratis: true,
        plazoEstimado: "Listo el mismo día",
        detalle: `Recoges tu pedido sin costo. ${config.direccionTienda}.`,
        estimado: false,
      };

    case "lima_domicilio": {
      const zona = buscarZonaLima(destino.distrito, config);
      const costoBaseCents = zona?.costoCents ?? config.limaFallback.costoCents;
      const plazoEstimado = zona?.plazo ?? config.limaFallback.plazo;
      const gratis = aplicaEnvioGratis(request, config);
      return {
        modo: "lima_domicilio",
        costoCents: gratis ? 0 : costoBaseCents,
        costoBaseCents,
        gratis,
        plazoEstimado,
        detalle: gratis
          ? "Envío gratis a domicilio por el monto de tu compra."
          : zona === null
            ? "Envío a domicilio en Lima. Confirmamos el costo exacto por WhatsApp."
            : `Envío a domicilio en ${zona.nombre}.`,
        // Sin zona reconocida el precio es una aproximación que el admin ajusta.
        estimado: zona === null && !gratis,
      };
    }

    case "provincia_agencia": {
      const costoBaseCents = config.provinciaEstimadoCents;
      const gratis = aplicaEnvioGratis(request, config);
      return {
        modo: "provincia_agencia",
        costoCents: gratis ? 0 : costoBaseCents,
        costoBaseCents,
        gratis,
        plazoEstimado: config.provinciaPlazo,
        detalle: gratis
          ? `Envío gratis a la agencia Shalom de ${destino.provincia}.`
          : `Envío a la agencia Shalom de ${destino.provincia}, ${destino.departamento}. Recoges con tu DNI y la clave de retiro.`,
        // Siempre estimado salvo que sea gratis: el flete real lo fija Shalom
        // según la medida de la caja en el mostrador.
        estimado: !gratis,
      };
    }
  }

  return casoImposible(destino);
}

/**
 * Cuánto le falta al cliente para el envío gratis, en céntimos.
 *
 * Devuelve `null` si no hay promoción o si ya la alcanzó. Se expone porque
 * mostrar "te faltan S/ 30 para el envío gratis" sube el ticket medio, y el
 * cálculo debe salir de la misma configuración que decide la gratuidad para que
 * no puedan contradecirse.
 */
export function faltaParaEnvioGratis(
  subtotalCents: Cents,
  config: ShippingConfig = CONFIG_ENVIO_DEFECTO,
): Cents | null {
  const umbral = config.umbralEnvioGratisCents;
  if (umbral === null || subtotalCents >= umbral) return null;
  return umbral - subtotalCents;
}
