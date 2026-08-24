/**
 * Contrato común de los métodos de pago.
 *
 * Por qué existe este archivo: el negocio arranca cobrando por Yape manual
 * (screenshot + validación humana) porque no requiere contrato con nadie, pero
 * la intención es migrar a una pasarela automática (Tupay) cuando el volumen lo
 * justifique. Si el checkout hablara directamente con cada implementación,
 * apagar o encender una de las dos obligaría a tocar rutas, UI y estado del
 * pedido.
 *
 * De ahí la forma de estos tipos:
 *
 * - `PaymentIntent` es lo que el checkout sabe, sin una sola palabra de Tupay.
 * - `PaymentInstruction` es lo que la UI debe pintar, como unión discriminada.
 *   Un único tipo con campos opcionales (`url?`, `qr?`, `numeroYape?`) haría
 *   imposible que el compilador exija manejar todos los casos en la pantalla de
 *   pago, y el fallo se manifestaría como una pantalla en blanco en producción.
 * - Los errores viajan como dato (`PaymentResult` con `ok: false`), no como
 *   excepción, porque un rechazo de la pasarela es un resultado esperado del
 *   flujo de checkout y debe llegar a la UI con un texto en español.
 *
 * Todo importe es `Cents` (entero). La conversión a soles decimales ocurre
 * únicamente en el borde de la petición HTTP de la pasarela que lo exija.
 */

import type { Cents } from "@/lib/money";
import type { OrderStatus } from "@/lib/order-status";

/**
 * `contraentrega` está en la unión desde el principio a propósito: es el tercer
 * método que el negocio ya usa por WhatsApp en Lima, y tenerlo en el tipo
 * fuerza a que cualquier `switch` exhaustivo lo contemple en vez de asumir que
 * "pagar" siempre significa "cobrar ahora".
 */
export type PaymentMethod = "yape_manual" | "tupay" | "contraentrega";

/** Documentos de identidad válidos en Perú, tal como los nombra Tupay. */
export type TipoDocumento = "DNI" | "RUC" | "CE" | "PASS";

/**
 * Reglas de validación del documento del pagador.
 *
 * Viven en el contrato común y no dentro del cliente de Tupay porque el Yape
 * manual también captura el documento (lo necesita la boleta), y duplicar las
 * longitudes en dos sitios garantiza que se desincronicen.
 */
export const REGLAS_DOCUMENTO: Readonly<
  Record<TipoDocumento, { readonly patron: RegExp; readonly descripcion: string }>
> = {
  DNI: { patron: /^\d{8}$/, descripcion: "DNI: 8 dígitos" },
  RUC: { patron: /^\d{11}$/, descripcion: "RUC: 11 dígitos" },
  CE: { patron: /^[A-Za-z0-9]{9,12}$/, descripcion: "Carné de extranjería: 9 a 12 alfanuméricos" },
  PASS: { patron: /^[A-Za-z0-9]{9,12}$/, descripcion: "Pasaporte: 9 a 12 alfanuméricos" },
};

export function documentoEsValido(tipo: TipoDocumento, valor: string): boolean {
  return REGLAS_DOCUMENTO[tipo].patron.test(valor.trim());
}

/**
 * Datos del pagador. `nombres`/`apellidos` van separados porque Tupay pide
 * `first_name` y `last_name` por separado y partir un nombre completo por el
 * primer espacio produce basura con los apellidos compuestos peruanos
 * ("De La Cruz").
 */
export type PaymentCustomer = {
  readonly nombres: string;
  readonly apellidos: string;
  readonly tipoDocumento: TipoDocumento;
  readonly documento: string;
  readonly email: string;
  /** E.164 sin espacios cuando se conoce; Tupay lo usa para prellenar el QR. */
  readonly telefono?: string;
  readonly direccion?: string;
};

/**
 * Preferencia de canal expresada por el cliente en el checkout.
 *
 * Es deliberadamente independiente de los códigos `XA*` de Tupay: la UI habla
 * de "Yape" o "tarjeta", y traducir a códigos de proveedor es trabajo del
 * provider. Así, cambiar de pasarela no cambia la UI.
 */
export type CanalPreferido =
  | "cualquiera"
  | "qr"
  | "yape"
  | "plin"
  | "tarjeta"
  | "efectivo"
  | "transferencia";

export type PaymentIntent = {
  /** UUID interno del pedido. Nunca se expone al cliente. */
  readonly orderId: string;
  /** Referencia pública tipo `COCO-7F3K2M`. Se usa como `invoice_id`. */
  readonly reference: string;
  readonly amountCents: Cents;
  readonly descripcion: string;
  readonly customer: PaymentCustomer;
  readonly urls: {
    readonly success: string;
    readonly error: string;
    readonly back: string;
    readonly notification: string;
  };
  readonly canal?: CanalPreferido;
  /**
   * IP del comprador. Tupay la usa para su scoring antifraude; omitirla no
   * rompe el cobro pero empeora la tasa de aprobación.
   */
  readonly clientIp?: string;
  /** Si el checkout se abrió en móvil, Tupay ofrece deep links a las apps. */
  readonly mobile?: boolean;
  /** Minutos de vida de la reserva de stock; acota también la expiración del cobro. */
  readonly expiraEnMinutos?: number;
};

/**
 * Lo que la UI necesita pintar. Cada variante lleva exactamente sus datos y
 * nada más.
 */
export type PaymentInstruction =
  | {
      readonly tipo: "manual_yape";
      readonly numeroYape: string;
      readonly titular: string;
      /** Total exacto a yapear, ya con los céntimos identificadores aplicados. */
      readonly montoCents: Cents;
      /** Los céntimos que identifican el pedido; la UI los resalta. */
      readonly centimosIdentificadores: number;
      readonly montoFormateado: string;
      readonly expiraEn: Date;
      /** Textos de los pasos, en el orden en que el cliente debe seguirlos. */
      readonly pasos: readonly string[];
      /** El flujo no termina en la UI: el admin debe validar el screenshot. */
      readonly requiereComprobante: true;
    }
  | {
      readonly tipo: "redirect";
      readonly url: string;
      /**
       * `true` cuando la pasarela permite embeber el checkout. Se decide aquí y
       * no en la UI porque depende de la respuesta del proveedor.
       */
      readonly iframe: boolean;
      readonly expiraEn: Date | null;
      /**
       * `HOSTED` significa que faltaron datos del pagador y los pedirá la
       * pasarela. La UI debe advertirlo para que el cliente no se sorprenda con
       * un formulario extra.
       */
      readonly pedirDatosEnPasarela: boolean;
    }
  | {
      readonly tipo: "qr";
      /** `data:image/png;base64,...` tal cual lo devuelve la pasarela. */
      readonly dataUri: string;
      readonly montoCents: Cents;
      readonly montoFormateado: string;
      readonly canal: Exclude<CanalPreferido, "cualquiera" | "tarjeta">;
      readonly expiraEn: Date | null;
      /** Alternativa por si el cliente no puede escanear (otro dispositivo). */
      readonly urlAlternativa: string | null;
    }
  | {
      readonly tipo: "transferencia";
      readonly convenio: string;
      readonly referencia: string;
      readonly montoCents: Cents;
      readonly montoFormateado: string;
      readonly expiraEn: Date | null;
    }
  | {
      readonly tipo: "contraentrega";
      readonly montoCents: Cents;
      readonly montoFormateado: string;
      readonly zonaCobertura: string;
      readonly aviso: string;
    };

/** Códigos de fallo normalizados, independientes de la pasarela. */
export type PaymentErrorCode =
  | "CONFIGURACION_INVALIDA"
  | "DATOS_PAGADOR_INVALIDOS"
  | "MONTO_INVALIDO"
  | "METODO_NO_DISPONIBLE"
  | "REFERENCIA_DUPLICADA"
  | "LIMITE_EXCEDIDO"
  | "CREDENCIALES"
  | "RED"
  | "PROVEEDOR";

export type PaymentFailure = {
  readonly codigo: PaymentErrorCode;
  /** Apto para mostrar tal cual en pantalla. Sin datos técnicos. */
  readonly mensajeCliente: string;
  /** Para logs. Puede contener códigos del proveedor, nunca secretos ni PII. */
  readonly mensajeTecnico: string;
  /**
   * Si `true`, ofrecer al cliente reintentar el mismo método; si `false`,
   * ofrecer otro método (típicamente el Yape manual, que nunca depende de un
   * tercero).
   */
  readonly reintentable: boolean;
};

export type PaymentResult =
  | {
      readonly ok: true;
      readonly metodo: PaymentMethod;
      /**
       * Identificador del lado del proveedor (`deposit_id` en Tupay). `null`
       * para los métodos que no crean nada remoto, como el Yape manual.
       * Es la clave con la que después se casan las notificaciones.
       */
      readonly providerRef: string | null;
      readonly instruccion: PaymentInstruction;
      /**
       * Estado al que el pedido debe pasar tras crear el intento. Lo decide el
       * provider porque cambia según el método: el Yape manual sigue
       * `pendiente_pago` esperando el screenshot, mientras contraentrega puede
       * ir directo a `preparando`.
       */
      readonly estadoPedidoSugerido: OrderStatus;
      /** Comisión estimada que se lleva el proveedor, para conciliación. */
      readonly comisionCents: Cents;
    }
  | {
      readonly ok: false;
      readonly metodo: PaymentMethod;
      readonly error: PaymentFailure;
    };

/** Estado del cobro visto desde el proveedor, ya normalizado. */
export type PaymentProviderStatus =
  | "pendiente"
  | "aprobado"
  | "rechazado"
  | "expirado"
  | "reembolsado"
  | "desconocido";

export type PaymentStatusResult = {
  readonly estado: PaymentProviderStatus;
  readonly providerRef: string;
  /**
   * Monto que el proveedor dice haber cobrado. Se compara contra el esperado
   * antes de liberar el pedido: una pasarela puede confirmar un importe menor
   * (pago parcial, conversión) y aprobar a ciegas sería regalar mercadería.
   */
  readonly montoCents: Cents | null;
  readonly actualizadoEn: Date | null;
  /** Motivo del rechazo, para el panel de administración. */
  readonly detalle: string | null;
};

export interface PaymentProvider {
  readonly id: PaymentMethod;
  readonly nombre: string;
  /** Si `true`, el pago no queda confirmado sin intervención de un humano. */
  readonly requiereVerificacionManual: boolean;
  /** Comisión del proveedor en porcentaje sobre el total. 0 para Yape manual. */
  readonly comisionPorcentaje: number;
  crearIntento(intent: PaymentIntent): Promise<PaymentResult>;
  /**
   * Consulta el estado. Los proveedores sin API (Yape manual) devuelven
   * `pendiente`/`desconocido` en vez de lanzar: el llamador no debería
   * ramificar por método para poder preguntar el estado.
   */
  consultarEstado(providerRef: string): Promise<PaymentStatusResult>;
}

/** Estimación de comisión, en céntimos, redondeada al céntimo. */
export function comisionCents(totalCents: Cents, porcentaje: number): Cents {
  return Math.round((totalCents * porcentaje) / 100);
}

/**
 * Ayuda a que los `switch` sobre las uniones sean exhaustivos: si se añade una
 * variante y falta una rama, el compilador falla aquí en vez de en runtime.
 */
export function casoImposible(valor: never): never {
  throw new Error(`caso no manejado: ${JSON.stringify(valor)}`);
}
