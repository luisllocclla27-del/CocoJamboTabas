/**
 * Score de riesgo de un pago Yape validado por comprobante.
 *
 * Qué es y qué no es este módulo:
 *
 * - **No decide.** Devuelve una recomendación con las razones explícitas. El
 *   nivel `'rechazar'` es lo que el admin ve resaltado en rojo, no una acción
 *   que el sistema ejecute. Un rechazo automático equivocado le niega el pedido
 *   a un cliente que ya pagó, y eso cuesta más caro que revisar a mano.
 * - **No aprueba salvo certeza total.** `autoAprobable` exige score 0 y cero
 *   señales de advertencia o crítico. Aprobar un pago mueve mercadería: es una
 *   decisión con consecuencia monetaria irreversible en la práctica, así que
 *   ante cualquier duda decide una persona.
 *
 * En resumen, el sistema es asimétrico a propósito: automatiza solo el camino
 * feliz e inequívoco, y todo lo demás lo escala a un humano.
 */

export type RiskSignal = {
  codigo: string;
  severidad: "info" | "advertencia" | "critico";
  mensaje: string;
  puntos: number;
};

export type RiskInput = {
  montoEsperadoCents: number;
  montoVoucherCents: number | null;
  operationNumberYaUsado: boolean;
  phashDuplicado: boolean;
  distanciaPhashMinima: number | null;
  fechaVoucher: Date | null;
  pedidoCreadoEn: Date;
  ahora: Date;
  ocrConfidence: number | null;
  destinatarioVoucher: string | null;
  destinatarioEsperado: string | null;
  tieneExifDeEditor: boolean;
  esPrimeraCompraDelCliente: boolean;
};

export type RiskAssessment = {
  score: number;
  nivel: "limpio" | "revisar" | "sospechoso" | "rechazar";
  signals: RiskSignal[];
  autoAprobable: boolean;
};

/**
 * Puntos por señal.
 *
 * Los cuatro críticos valen por sí solos el umbral de 'rechazar': cada uno
 * describe una imposibilidad, no un indicio. Los de advertencia están calibrados
 * para que uno solo lleve a 'revisar' y dos o tres a 'sospechoso', porque las
 * advertencias son individualmente débiles pero se refuerzan entre sí: OCR malo
 * *y* nombre distinto *y* voucher viejo, juntos, ya no parecen mala suerte.
 */
const PUNTOS = {
  OPERACION_DUPLICADA: 100,
  PHASH_DUPLICADO: 60,
  MONTO_NO_COINCIDE: 60,
  FECHA_ANTERIOR_AL_PEDIDO: 60,
  MONTO_ILEGIBLE: 25,
  DESTINATARIO_NO_COINCIDE: 20,
  VOUCHER_ANTIGUO: 15,
  EXIF_EDITOR: 15,
  FECHA_ILEGIBLE: 10,
  OCR_BAJA_CONFIANZA: 10,
  PRIMERA_COMPRA: 3,
} as const;

const UMBRAL_RECHAZAR = 60;
const UMBRAL_SOSPECHOSO = 30;

/** Por debajo de esto el texto del OCR no es de fiar aunque haya parseado. */
const CONFIANZA_OCR_MINIMA = 0.6;

/** Antigüedad a partir de la cual el voucher merece una mirada. */
const HORAS_VOUCHER_ANTIGUO = 48;

/**
 * Margen para el desfase de relojes antes de gritar "pago anterior al pedido".
 *
 * Yape muestra la hora al minuto, sin segundos, así que un pago hecho en el
 * mismo minuto en que se creó el pedido puede leerse hasta 59 segundos antes de
 * él. A eso se suma que el reloj del celular del cliente y el del servidor no
 * están sincronizados. Sin este margen, un cliente rapidísimo y honesto
 * dispararía la señal más grave del sistema.
 */
const TOLERANCIA_RELOJ_MS = 3 * 60 * 1000;

const MS_POR_HORA = 3_600_000;

const ORDEN_SEVERIDAD: Readonly<Record<RiskSignal["severidad"], number>> = {
  critico: 0,
  advertencia: 1,
  info: 2,
};

export function assessRisk(input: RiskInput): RiskAssessment {
  const signals: RiskSignal[] = [];

  // --- Señal más dura del sistema -----------------------------------------
  // Un número de operación identifica una transacción única en Yape/Plin. Si ya
  // pagó otro pedido, este comprobante no representa dinero nuevo: es el mismo
  // pago presentado dos veces. No hay explicación inocente, y por eso es la
  // única señal que no comparte el peso con nada.
  if (input.operationNumberYaUsado) {
    signals.push({
      codigo: "OPERACION_DUPLICADA",
      severidad: "critico",
      mensaje:
        "El número de operación del voucher ya fue usado para validar otro pedido. Un mismo pago no puede cubrir dos pedidos.",
      puntos: PUNTOS.OPERACION_DUPLICADA,
    });
  }

  // El pHash es la red de seguridad para cuando el OCR no pudo leer el número
  // de operación. Es crítico porque reenviar la imagen de otro pago es
  // exactamente el fraude que este flujo tiene que detener, pero se acompaña de
  // la distancia para que el admin pueda juzgar: los vouchers de Yape comparten
  // plantilla y eso hace posible el falso positivo (ver phash.ts).
  if (input.phashDuplicado) {
    const detalleDistancia =
      input.distanciaPhashMinima === null
        ? ""
        : ` Distancia perceptual: ${input.distanciaPhashMinima} de 64${
            input.distanciaPhashMinima === 0 ? " (imagen idéntica)" : ""
          }.`;
    signals.push({
      codigo: "PHASH_DUPLICADO",
      severidad: "critico",
      mensaje: `La imagen del comprobante coincide con otra ya recibida.${detalleDistancia}`,
      puntos: PUNTOS.PHASH_DUPLICADO,
    });
  }

  // --- Monto ---------------------------------------------------------------
  if (input.montoVoucherCents === null) {
    // No leer el monto es una limitación nuestra, no una conducta del cliente.
    // Manda a revisión humana; rechazar por esto sería castigar al cliente por
    // la calidad de nuestro OCR.
    signals.push({
      codigo: "MONTO_ILEGIBLE",
      severidad: "advertencia",
      mensaje:
        "No se pudo leer el monto del comprobante. Requiere que una persona lo verifique a ojo.",
      puntos: PUNTOS.MONTO_ILEGIBLE,
    });
  } else if (input.montoVoucherCents !== input.montoEsperadoCents) {
    // Coincidencia exacta, sin tolerancia: los céntimos del total son el
    // identificador que conecta el pago con el pedido (ver payment-cents.ts).
    // Aceptar una diferencia de céntimos rompería ese mecanismo y volvería
    // ambiguo a qué pedido pertenece cada Yape.
    signals.push({
      codigo: "MONTO_NO_COINCIDE",
      severidad: "critico",
      mensaje: `El monto del voucher (${formatearCents(input.montoVoucherCents)}) no coincide con el esperado (${formatearCents(input.montoEsperadoCents)}).`,
      puntos: PUNTOS.MONTO_NO_COINCIDE,
    });
  }

  // --- Cronología ----------------------------------------------------------
  if (input.fechaVoucher === null) {
    signals.push({
      codigo: "FECHA_ILEGIBLE",
      severidad: "advertencia",
      mensaje:
        "No se pudo leer la fecha del comprobante, así que no se verificó que el pago sea posterior al pedido.",
      puntos: PUNTOS.FECHA_ILEGIBLE,
    });
  } else {
    const desfaseMs = input.pedidoCreadoEn.getTime() - input.fechaVoucher.getTime();
    if (desfaseMs > TOLERANCIA_RELOJ_MS) {
      // Imposibilidad lógica: el pago es anterior al pedido que supuestamente
      // paga. El caso típico es reciclar un voucher viejo de otra compra.
      signals.push({
        codigo: "FECHA_ANTERIOR_AL_PEDIDO",
        severidad: "critico",
        mensaje: `El voucher es de ${formatearFecha(input.fechaVoucher)}, anterior a la creación del pedido (${formatearFecha(input.pedidoCreadoEn)}). Un pago no puede ser previo al pedido que paga.`,
        puntos: PUNTOS.FECHA_ANTERIOR_AL_PEDIDO,
      });
    }

    const antiguedadHoras = (input.ahora.getTime() - input.fechaVoucher.getTime()) / MS_POR_HORA;
    if (antiguedadHoras > HORAS_VOUCHER_ANTIGUO) {
      // Solo advertencia: hay motivos legítimos (el cliente pagó y subió el
      // comprobante días después, o el pedido estuvo esperando stock).
      signals.push({
        codigo: "VOUCHER_ANTIGUO",
        severidad: "advertencia",
        mensaje: `El voucher tiene ${Math.floor(antiguedadHoras)} horas de antigüedad, más de las ${HORAS_VOUCHER_ANTIGUO} esperadas.`,
        puntos: PUNTOS.VOUCHER_ANTIGUO,
      });
    }
  }

  // --- Metadatos -----------------------------------------------------------
  // Advertencia y no crítico porque la señal es ruidosa en ambos sentidos: la
  // mayoría de vouchers llegan por WhatsApp, que borra el EXIF por completo, y
  // muchas apps de galería reescriben el campo Software al rotar o recortar. Un
  // editor en los metadatos es compatible con un cliente que solo tapó su saldo
  // antes de mandar la captura.
  if (input.tieneExifDeEditor) {
    signals.push({
      codigo: "EXIF_EDITOR",
      severidad: "advertencia",
      mensaje:
        "Los metadatos de la imagen nombran un editor. Puede ser edición del comprobante o simplemente un recorte hecho desde la galería.",
      puntos: PUNTOS.EXIF_EDITOR,
    });
  }

  // --- Calidad del reconocimiento -----------------------------------------
  if (input.ocrConfidence !== null && input.ocrConfidence < CONFIANZA_OCR_MINIMA) {
    // Con confianza baja los demás campos leídos pierden valor probatorio,
    // incluso los que coincidieron: pueden haber coincidido por casualidad
    // sobre texto mal reconocido.
    signals.push({
      codigo: "OCR_BAJA_CONFIANZA",
      severidad: "advertencia",
      mensaje: `La confianza del OCR es baja (${input.ocrConfidence.toFixed(2)}). Los datos leídos del voucher no son fiables por sí solos.`,
      puntos: PUNTOS.OCR_BAJA_CONFIANZA,
    });
  }

  // --- Destinatario --------------------------------------------------------
  // Advertencia y no crítico por dos razones concretas: el OCR se equivoca
  // mucho con nombres propios (tildes, apellidos poco frecuentes), y Yape a
  // veces muestra el nombre parcialmente enmascarado, así que la comparación
  // trabaja con información incompleta por diseño de la propia app.
  if (compararDestinatarios(input.destinatarioVoucher, input.destinatarioEsperado) === "distinto") {
    signals.push({
      codigo: "DESTINATARIO_NO_COINCIDE",
      severidad: "advertencia",
      mensaje: `El destinatario del voucher ("${input.destinatarioVoucher}") no coincide con el esperado ("${input.destinatarioEsperado}"). Verificar a ojo: el OCR falla con nombres y Yape los enmascara parcialmente.`,
      puntos: PUNTOS.DESTINATARIO_NO_COINCIDE,
    });
  }

  // --- Contexto del cliente -----------------------------------------------
  // Informativo con muy pocos puntos: ser cliente nuevo no es sospechoso, es el
  // objetivo del negocio. Solo sirve para que el admin sepa que no hay
  // historial que respalde a esta persona si algo más levanta la ceja.
  if (input.esPrimeraCompraDelCliente) {
    signals.push({
      codigo: "PRIMERA_COMPRA",
      severidad: "info",
      mensaje: "Es la primera compra de este cliente: no hay historial previo que la respalde.",
      puntos: PUNTOS.PRIMERA_COMPRA,
    });
  }

  // Orden por severidad descendente y, dentro de la misma severidad, por peso:
  // la pantalla del admin muestra las primeras señales sin hacer scroll y lo
  // que decide tiene que estar arriba.
  signals.sort(
    (a, b) => ORDEN_SEVERIDAD[a.severidad] - ORDEN_SEVERIDAD[b.severidad] || b.puntos - a.puntos,
  );

  const score = signals.reduce((total, s) => total + s.puntos, 0);
  const hayDudas = signals.some((s) => s.severidad !== "info");

  return {
    score,
    nivel: nivelDesdeScore(score),
    signals,
    // Score 0 implica que no hay ninguna señal con puntos, pero se comprueba la
    // severidad además del score para que añadir en el futuro una advertencia de
    // 0 puntos no abra por descuido la puerta a la aprobación automática.
    autoAprobable: score === 0 && !hayDudas,
  };
}

function nivelDesdeScore(score: number): RiskAssessment["nivel"] {
  if (score >= UMBRAL_RECHAZAR) return "rechazar";
  if (score >= UMBRAL_SOSPECHOSO) return "sospechoso";
  if (score > 0) return "revisar";
  return "limpio";
}

/**
 * Compara nombres tolerando lo que el canal degrada.
 *
 * Devuelve `'indeterminado'` en vez de `'distinto'` cuando falta un dato o
 * cuando el enmascarado de Yape deja demasiado poco que comparar: afirmar que
 * los nombres difieren sin haberlos podido leer sería fabricar una señal.
 */
function compararDestinatarios(
  voucher: string | null,
  esperado: string | null,
): "coincide" | "distinto" | "indeterminado" {
  if (voucher === null || esperado === null) return "indeterminado";

  const a = normalizarNombre(voucher);
  const b = normalizarNombre(esperado);
  if (a.length === 0 || b.length === 0) return "indeterminado";
  if (a === b) return "coincide";

  const tokensA = a.split(" ").filter((t) => t.length > 0);
  const tokensB = b.split(" ").filter((t) => t.length > 0);

  // Yape recorta a nombre + inicial ("luis g"), y el nombre del pedido trae los
  // dos apellidos. Basta con que todo lo que el voucher muestra esté contenido
  // en el esperado, comparando la inicial cuando el token es de una letra.
  const contenido = (cortos: string[], largos: string[]) =>
    cortos.every((t) =>
      t.length === 1 ? largos.some((l) => l.startsWith(t)) : largos.includes(t),
    );

  if (contenido(tokensA, tokensB) || contenido(tokensB, tokensA)) return "coincide";
  return "distinto";
}

function normalizarNombre(nombre: string): string {
  return (
    nombre
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      // Los asteriscos del enmascarado y la puntuación de las iniciales no
      // aportan nada a la comparación y sí generan falsos "distinto".
      .replace(/[*.]/g, " ")
      .replace(/[^a-zñ ]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function formatearCents(cents: number): string {
  const soles = Math.floor(Math.abs(cents) / 100);
  const centimos = String(Math.abs(cents) % 100).padStart(2, "0");
  return `${cents < 0 ? "-" : ""}S/ ${soles}.${centimos}`;
}

function formatearFecha(fecha: Date): string {
  return fecha.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}
