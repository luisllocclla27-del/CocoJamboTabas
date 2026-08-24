/**
 * Contrato común de los métodos de envío.
 *
 * Por qué existe: los envíos a provincia se hacen por Shalom, y Shalom no
 * publica API oficial. Lo único que existe es un wrapper de terceros que raspa
 * `pro.shalom.pe`, así que el día en que Shalom cambie su web el proveedor
 * automático deja de funcionar. El negocio no puede detenerse por eso: hoy el
 * admin ya emite la guía a mano en el mostrador de la agencia y copia el número
 * al pedido, y ese flujo tiene que seguir siendo válido para siempre.
 *
 * De ahí que ambos caminos (manual y automático) implementen la MISMA interfaz:
 * el checkout y el panel no preguntan "¿estoy hablando con Shalom?", piden un
 * `ShippingProvider` al registry y usan sus capacidades declaradas
 * (`puedeEmitirGuia`, `soportaTrackingAutomatico`). Apagar Shalom es una
 * variable de entorno, no un despliegue de código.
 *
 * Todos los importes son `Cents` enteros. La API de Shalom devuelve soles
 * decimales; la conversión ocurre únicamente en el borde HTTP
 * (`shalom-client.ts`), nunca aquí.
 */

import type { Cents } from "@/lib/money";

/**
 * Modalidad de entrega elegida en el checkout.
 *
 * Son tres y no dos porque el costo, los datos que hay que pedir y quién
 * ejecuta la entrega son distintos en cada una: a domicilio en Lima lo hace un
 * motorizado propio, a provincia lo hace la agencia (y el cliente recoge allá),
 * y el recojo en tienda no genera envío alguno.
 */
export type ShippingMode = "lima_domicilio" | "provincia_agencia" | "recojo_tienda";

export type ShippingProviderId = "manual" | "shalom";

/**
 * Los 7 hitos que reporta Shalom, con sus nombres originales en español.
 *
 * Se conservan tal cual llegan del proveedor en lugar de traducirlos a un
 * vocabulario propio: cuando el cliente llame preguntando, el admin va a ver
 * en la web de Shalom exactamente estas palabras, y un mapeo intermedio solo
 * añadiría una traducción que mantener.
 */
export type TrackingMilestone =
  | "registrado"
  | "origen"
  | "transito"
  | "demora"
  | "destino"
  | "entregado"
  | "reparto";

/**
 * Orden canónico del flujo, usado como desempate cuando dos hitos comparten
 * fecha y hora exactas (Shalom reporta a segundo, y registrar/origen suelen
 * caer en el mismo segundo).
 *
 * `demora` va después de `transito` porque es una excepción que ocurre durante
 * el traslado, y `reparto` antes de `entregado` porque el reparto a domicilio
 * precede a la entrega.
 */
export const ORDEN_HITOS: readonly TrackingMilestone[] = [
  "registrado",
  "origen",
  "transito",
  "demora",
  "destino",
  "reparto",
  "entregado",
];

export type TrackingEvent = {
  readonly milestone: TrackingMilestone;
  /** Instante absoluto. Shalom lo manda en hora de Perú; ver `tracking-normalizer.ts`. */
  readonly fecha: Date;
  /** Texto para mostrar al cliente. Si Shalom no manda uno, se deriva del hito. */
  readonly descripcion: string;
  /**
   * Shalom marca `completo` solo en algunos hitos (`transito`, `destino`).
   * Cuando no lo manda se asume `true`: el hito llegó con fecha, así que
   * ocurrió; asumir `false` pintaría la línea de tiempo como si estuviera a
   * medias sin ninguna evidencia de que lo esté.
   */
  readonly completo: boolean;
};

export type TrackingState = {
  readonly entregado: boolean;
  readonly enReparto: boolean;
  readonly conDemora: boolean;
  /** Hito más avanzado con fecha, o `null` si Shalom no reportó ninguno. */
  readonly ultimoHito: TrackingMilestone | null;
  /** Eventos ordenados cronológicamente ascendente. */
  readonly eventos: readonly TrackingEvent[];
};

// ---------------------------------------------------------------------------
// Referencia de rastreo
// ---------------------------------------------------------------------------

/**
 * Cómo identificar un envío ante Shalom.
 *
 * Es una unión discriminada y no `{ numero?, codigo?, oseId? }` porque las
 * combinaciones válidas no son arbitrarias: la web pública pide `numero` +
 * `codigo` juntos (el código es el secreto que evita que cualquiera rastree una
 * guía ajena sabiendo solo su número), mientras el `ose_id` identifica el envío
 * por sí solo. Con campos opcionales sueltos, un llamador podría construir
 * `{ numero }` a secas y el fallo aparecería como un 404 en producción en vez de
 * como un error de compilación.
 */
export type TrackingRef =
  | { readonly tipo: "guia"; readonly numero: string; readonly codigo: string }
  | { readonly tipo: "ose"; readonly oseId: string };

/** Aplana la referencia a los parámetros de query que espera el wrapper. */
export function refAQuery(ref: TrackingRef): Record<string, string> {
  return ref.tipo === "guia"
    ? { numero: ref.numero, codigo: ref.codigo }
    : { ose_id: ref.oseId };
}

// ---------------------------------------------------------------------------
// Cotización
// ---------------------------------------------------------------------------

/**
 * Destino a cotizar. Discriminado por modalidad porque cada una necesita datos
 * distintos y ninguno de ellos es opcional dentro de su variante: un envío a
 * Lima sin distrito no se puede tarifar, y uno a provincia sin agencia no se
 * puede emitir.
 */
export type ShippingDestination =
  | { readonly modo: "lima_domicilio"; readonly distrito: string }
  | {
      readonly modo: "provincia_agencia";
      readonly departamento: string;
      readonly provincia: string;
      /** Terminal de destino de Shalom. La elige el cliente en el checkout. */
      readonly agenciaId: string;
    }
  | { readonly modo: "recojo_tienda" };

/** Dimensiones y peso del paquete. Shalom tarifa por caja, no por peso exacto. */
export type PackageDimensions = {
  readonly pesoKg: number;
  readonly altoM: number;
  readonly largoM: number;
  readonly anchoM: number;
};

export type ShippingQuoteRequest = {
  readonly destino: ShippingDestination;
  /** Subtotal de la mercadería, para aplicar el umbral de envío gratis. */
  readonly subtotalCents: Cents;
  readonly dimensiones?: PackageDimensions;
};

export type ShippingQuote = {
  readonly modo: ShippingMode;
  readonly costoCents: Cents;
  /** Costo antes del umbral de envío gratis, para poder mostrar el ahorro. */
  readonly costoBaseCents: Cents;
  readonly gratis: boolean;
  /** Texto para el checkout: "2 a 4 días hábiles". */
  readonly plazoEstimado: string;
  /** Explica el precio o la gratuidad. Se muestra tal cual. */
  readonly detalle: string;
  /**
   * `true` cuando el precio es una estimación de tabla y no una cotización real
   * de Shalom. La UI debe advertirlo para no comprometer un precio que después
   * cambie en el mostrador.
   */
  readonly estimado: boolean;
};

// ---------------------------------------------------------------------------
// Emisión de guía
// ---------------------------------------------------------------------------

export type TipoDocumentoShalom = "DNI" | "RUC" | "CE";

/**
 * Declaración jurada del contenido. Shalom la exige y la rechaza si falta.
 * Para zapatillas el valor correcto es `ropa`; se deja el resto porque el mismo
 * módulo emite guías de devolución y de documentos.
 */
export type DeclaracionJurada = "docs" | "ropa" | "art" | "electro";

export type Destinatario = {
  readonly tipoDocumento: TipoDocumentoShalom;
  readonly documento: string;
  readonly nombre: string;
  readonly apellidoPaterno?: string;
  readonly apellidoMaterno?: string;
  readonly telefono?: string;
};

export type EmitirGuiaRequest = {
  readonly terminalOrigenId: string;
  readonly terminalDestinoId: string;
  readonly productoId: string;
  readonly destinatario: Destinatario;
  /** 4 dígitos. Ver `pickup-code.ts`: Shalom rechaza repetidos y consecutivos. */
  readonly claveRetiro: string;
  readonly declaracionJurada: DeclaracionJurada;
  readonly cantidad?: number;
  /** Quién paga el flete. Por defecto lo asume el remitente (la tienda). */
  readonly pagador?: "sender" | "receiver";
  readonly dimensiones?: PackageDimensions;
  readonly aereo?: boolean;
  /** Si `true`, Shalom crea además la suscripción de rastreo. */
  readonly rastrear?: boolean;
};

export type GuiaEmitida = {
  readonly guia: string;
  readonly serie: string;
  /** Código de rastreo. Junto con `guia` permite consultar el estado. */
  readonly codigo: string;
  readonly oseId: string;
};

/**
 * Datos que el admin transcribe cuando la guía se emitió en el mostrador.
 *
 * Existe para que el camino manual produzca exactamente la misma información
 * que el automático y el resto del sistema no tenga que distinguirlos.
 */
export type GuiaManual = {
  readonly guia: string;
  readonly codigo: string;
  readonly agencia: string;
  readonly claveRetiro: string;
};

/**
 * Resultado de emitir. Los fallos viajan como dato y no como excepción porque
 * un rechazo de Shalom (agencia inválida, documento mal, servicio de cobranza no
 * habilitado) es un resultado esperado del flujo del panel y debe llegar a la
 * pantalla con un texto en español, no como un 500.
 */
export type EmitirGuiaResult =
  | { readonly ok: true; readonly guia: GuiaEmitida }
  | {
      readonly ok: false;
      readonly mensajeCliente: string;
      readonly mensajeTecnico: string;
      /**
       * Nunca es `true` para un timeout de emisión: un timeout NO significa que
       * la guía no se creó, y reintentar a ciegas duplica un cargo real. Ver
       * `shalom-client.ts`.
       */
      readonly reintentable: boolean;
      readonly requiereRevisionManual: boolean;
    };

// ---------------------------------------------------------------------------
// Proveedor
// ---------------------------------------------------------------------------

export interface ShippingProvider {
  readonly id: ShippingProviderId;
  readonly nombre: string;
  /** Si `false`, el estado del envío solo avanza cuando un humano lo actualiza. */
  readonly soportaTrackingAutomatico: boolean;
  /** Si `false`, la guía se genera fuera del sistema y se transcribe. */
  readonly puedeEmitirGuia: boolean;

  /**
   * Estado del envío, o `null` cuando este proveedor no puede consultarlo.
   *
   * Devuelve `null` en vez de lanzar para que el llamador pueda preguntar
   * siempre, sin ramificar por proveedor. Es la misma decisión que en
   * `PaymentProvider.consultarEstado`.
   */
  consultarTracking(ref: TrackingRef): Promise<TrackingState | null>;

  /** URL pública de rastreo que se le manda al cliente por WhatsApp. */
  urlRastreo(ref: TrackingRef): string;

  /**
   * Cotiza el envío. Los proveedores sin API resuelven con la tabla de
   * configuración y marcan `estimado: true`.
   */
  cotizar(request: ShippingQuoteRequest): Promise<ShippingQuote>;
}

/**
 * Capacidad separada de la interfaz base a propósito.
 *
 * Si `emitirGuia` viviera en `ShippingProvider`, el proveedor manual tendría que
 * implementarla lanzando "no soportado", y cualquier llamador podría invocarla
 * sin comprobar nada. Como capacidad aparte, el compilador obliga a estrechar el
 * tipo antes de emitir, y emitir es justo la operación que cuesta dinero real.
 */
export interface GuiaIssuer {
  emitirGuia(
    request: EmitirGuiaRequest,
    /**
     * Salvaguarda: el llamador tiene que afirmar explícitamente que quiere
     * crear una guía cobrable. No hay sandbox en Shalom.
     */
    confirmacionExplicita: true,
  ): Promise<EmitirGuiaResult>;
}

export function puedeEmitir(
  provider: ShippingProvider,
): provider is ShippingProvider & GuiaIssuer {
  return provider.puedeEmitirGuia && typeof (provider as Partial<GuiaIssuer>).emitirGuia === "function";
}

/**
 * Ayuda a que los `switch` sobre las uniones sean exhaustivos: si se añade una
 * variante y falta una rama, falla el compilador en vez de el runtime.
 */
export function casoImposible(valor: never): never {
  throw new Error(`caso no manejado: ${JSON.stringify(valor)}`);
}
