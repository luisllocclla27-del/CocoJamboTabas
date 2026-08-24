/**
 * Cliente HTTP de Tupay (`POST /v3/deposits`).
 *
 * RESTRICCIÓN DE ARQUITECTURA — LEER ANTES DE DESPLEGAR:
 * Tupay exige whitelisting de la IP de salida del servidor que la llama. Una
 * función serverless (Vercel, Lambda, Cloud Run) sale por una IP dinámica del
 * pool del proveedor, así que **este cliente no puede ejecutarse desde ahí**:
 * devolvería `202 INVALID_IP` de forma intermitente, que es el peor modo de
 * fallo posible (funciona en pruebas, falla en producción a ratos). Las opciones
 * son un host con IP fija (VPS, EC2, Fly.io con IP dedicada) o un NAT/proxy de
 * salida estático delante. Mientras eso no exista, el método por defecto del
 * checkout es el Yape manual, que no depende de terceros.
 *
 * Decisiones que este archivo materializa:
 *
 * - Se serializa el body UNA sola vez y ese string se firma y se envía. Ver
 *   `signature.ts`.
 * - La `X-Idempotency-Key` es determinista a partir del `invoice_id`, no un
 *   UUID por intento.
 * - Nada de secretos ni PII en los logs ni en los mensajes de error.
 */

import { z } from "zod";
import type { Cents } from "@/lib/money";
import { buildAuthorizationHeader, formatTupayDate } from "./signature";
import { createHash } from "node:crypto";

/** Códigos de método de pago de Tupay. */
export const TUPAY_PAYMENT_METHODS = {
  TODOS: "XA",
  QR_TODOS: "XAQR",
  YAPE: "XAYP",
  PLIN: "XAPL",
  TARJETA: "XACC",
  EFECTIVO: "XABT",
  TRANSFERENCIA: "XAIN",
} as const;

export type TupayPaymentMethodCode =
  (typeof TUPAY_PAYMENT_METHODS)[keyof typeof TUPAY_PAYMENT_METHODS];

/**
 * Mínimo que acepta Tupay: USD 2 o equivalente (error 400 INVALID_AMOUNT).
 * Se fija en S/ 8.00 con holgura sobre el tipo de cambio para no depender de él;
 * ninguna zapatilla cuesta tan poco, así que el margen no molesta.
 */
export const TUPAY_MONTO_MINIMO_CENTS: Cents = 800;

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------

const configSchema = z.object({
  apiKey: z.string().min(1, "TUPAY_API_KEY vacía"),
  apiSecret: z.string().min(1, "TUPAY_API_SECRET vacía"),
  baseUrl: z
    .string()
    .url("TUPAY_BASE_URL no es una URL válida")
    // Se normaliza la barra final: `${baseUrl}/v3/deposits` con baseUrl
    // terminada en `/` produciría `//v3/deposits`, que algunos gateways
    // rechazan con un 404 desconcertante.
    .transform((u) => u.replace(/\/+$/, "")),
  /**
   * Modo prueba. Viaja como campo `test` en el body: en STG hay que mandarlo
   * para que Tupay no intente cobrar de verdad.
   */
  testMode: z.boolean(),
});

export type TupayConfig = z.infer<typeof configSchema>;

/**
 * Vista mínima del entorno.
 *
 * No se usa `NodeJS.ProcessEnv` porque Next declara `NODE_ENV` como obligatorio
 * en ese tipo, lo que impediría pasar un objeto parcial desde los tests sin un
 * cast. `process.env` es asignable a esto.
 */
export type EnvVars = Readonly<Record<string, string | undefined>>;

export class TupayConfigError extends Error {
  readonly code = "TUPAY_CONFIG_INVALIDA";
  constructor(readonly problemas: readonly string[]) {
    super(
      `Configuración de Tupay incompleta o inválida:\n- ${problemas.join(
        "\n- ",
      )}\nDefine estas variables en el entorno del servidor (nunca con prefijo NEXT_PUBLIC_).`,
    );
    this.name = "TupayConfigError";
  }
}

/** Lo que se considera "true" en una variable de entorno. */
function parseBooleanEnv(valor: string | undefined, porDefecto: boolean): boolean {
  if (valor === undefined || valor.trim() === "") return porDefecto;
  return ["1", "true", "yes", "si", "sí", "on"].includes(valor.trim().toLowerCase());
}

/**
 * Lee y valida la configuración del entorno.
 *
 * Falla ruidosamente y con el nombre de la variable que falta: el modo de fallo
 * alternativo es una firma inválida en producción, que desde fuera parece un
 * problema de Tupay y cuesta horas de diagnóstico.
 *
 * `env` es inyectable para poder testear sin ensuciar `process.env`.
 */
export function loadTupayConfig(env: EnvVars = process.env): TupayConfig {
  const candidato = {
    apiKey: env.TUPAY_API_KEY ?? "",
    apiSecret: env.TUPAY_API_SECRET ?? "",
    baseUrl: env.TUPAY_BASE_URL ?? "",
    testMode: parseBooleanEnv(env.TUPAY_TEST_MODE, true),
  };
  const parsed = configSchema.safeParse(candidato);
  if (!parsed.success) {
    const problemas = parsed.error.issues.map((i) => {
      const variable = NOMBRE_VARIABLE[String(i.path[0])] ?? String(i.path[0]);
      return `${variable}: ${i.message}`;
    });
    throw new TupayConfigError(problemas);
  }
  return parsed.data;
}

const NOMBRE_VARIABLE: Readonly<Record<string, string>> = {
  apiKey: "TUPAY_API_KEY",
  apiSecret: "TUPAY_API_SECRET",
  baseUrl: "TUPAY_BASE_URL",
  testMode: "TUPAY_TEST_MODE",
};

/** ¿Está Tupay configurada? Para decidir si ofrecerla sin lanzar. */
export function tupayEstaConfigurada(env: EnvVars = process.env): boolean {
  try {
    loadTupayConfig(env);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Redacción para logs
// ---------------------------------------------------------------------------

const CAMPOS_SENSIBLES = new Set([
  "document",
  "email",
  "phone",
  "address",
  "first_name",
  "last_name",
  "device_id",
  "client_ip",
]);

/**
 * Elimina cualquier aparición del secreto de un texto.
 *
 * Se aplica a TODO lo que salga hacia un log o hacia un mensaje de error. El
 * riesgo real no es que alguien haga `console.log(secret)` a propósito, sino que
 * un `error.message` de `fetch` o un stack incluya la URL o la cabecera y acabe
 * en un servicio de observabilidad de terceros.
 */
export function redactSecret(texto: string, secret: string): string {
  if (secret.length === 0) return texto;
  return texto.split(secret).join("[REDACTED]");
}

/**
 * Versión del payload apta para logs: conserva la forma (útil para depurar) y
 * sustituye el contenido de los campos con datos personales.
 *
 * Loguear el payload entero sería filtrar DNI, email y teléfono del cliente a
 * cualquiera con acceso a los logs, que es un incidente de protección de datos
 * aunque el sistema funcione perfectamente.
 */
export function redactPayload(payload: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return "[payload no serializable: omitido]";
  }
  return JSON.stringify(redactValue(parsed));
}

function redactValue(valor: unknown): unknown {
  if (Array.isArray(valor)) return valor.map(redactValue);
  if (valor !== null && typeof valor === "object") {
    const salida: Record<string, unknown> = {};
    for (const [clave, v] of Object.entries(valor as Record<string, unknown>)) {
      salida[clave] = CAMPOS_SENSIBLES.has(clave) ? "[REDACTED]" : redactValue(v);
    }
    return salida;
  }
  return valor;
}

// ---------------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------------

/** Código sintético para fallos que no vienen de Tupay (red, timeout, parseo). */
export const TUPAY_CODIGO_RED = 0;

const CODIGOS_REINTENTABLES = new Set<number>([
  404, // ERROR_CREATING_PAYMENT: fallo transitorio creando el depósito.
  412, // PAYMENT_METHOD_UNAVAILABLE: el canal puede volver en segundos.
  500, // GENERIC_ERROR.
  TUPAY_CODIGO_RED, // Timeout o corte de conexión.
]);

export class TupayError extends Error {
  readonly name = "TupayError";
  constructor(
    /** Código de negocio de Tupay (`code` del JSON de error), o 0 si es de red. */
    readonly code: number,
    readonly type: string,
    /** Status HTTP. `null` cuando la petición nunca llegó a completarse. */
    readonly httpStatus: number | null,
    /** Mensaje técnico, ya redactado. Va a los logs. */
    mensajeTecnico: string,
    /** `details` de un BEAN_VALIDATION_ERROR, si vino. */
    readonly details: readonly string[] = [],
  ) {
    super(mensajeTecnico);
  }

  /**
   * ¿Merece la pena reintentar con la MISMA idempotency key?
   *
   * Los errores de validación (201, 400, 410) y de firma/credenciales (100,
   * 102, 103, 202) son deterministas: reintentarlos gasta cuota y retrasa el
   * mensaje al cliente. El 203 VELOCITY_CHECK tampoco se reintenta aunque sea un
   * 429, porque reintentar es exactamente lo que dispara el control de
   * velocidad.
   */
  get esReintentable(): boolean {
    return CODIGOS_REINTENTABLES.has(this.code);
  }

  /** Texto para la pantalla del cliente. Sin códigos ni jerga. */
  get mensajeCliente(): string {
    return MENSAJE_CLIENTE[this.code] ?? MENSAJE_CLIENTE_GENERICO;
  }
}

const MENSAJE_CLIENTE_GENERICO =
  "No pudimos iniciar el pago con la pasarela. Puedes intentarlo de nuevo o pagar por Yape directo.";

/**
 * Mensajes al cliente. Los fallos que son culpa nuestra (credenciales, firma,
 * IP no whitelisteada) no se explican: al comprador no le sirve saberlo y
 * revelaría detalles de la integración. Se le ofrece la alternativa que siempre
 * funciona.
 */
const MENSAJE_CLIENTE: Readonly<Record<number, string>> = {
  [TUPAY_CODIGO_RED]:
    "La pasarela de pago no respondió a tiempo. Intenta otra vez o paga por Yape directo.",
  100: MENSAJE_CLIENTE_GENERICO,
  102: MENSAJE_CLIENTE_GENERICO,
  103: MENSAJE_CLIENTE_GENERICO,
  104: "Este pedido ya tiene un pago iniciado. Revisa tu pedido antes de volver a intentar.",
  201: "Revisa tus datos: el nombre, el documento o el correo no tienen un formato válido.",
  202: MENSAJE_CLIENTE_GENERICO,
  203: "Demasiados intentos de pago seguidos. Espera unos minutos antes de volver a intentar.",
  208: MENSAJE_CLIENTE_GENERICO,
  400: "El monto del pedido no es válido para esta forma de pago.",
  402: "Este pedido ya tiene un pago registrado. Revisa el estado de tu pedido.",
  404: "La pasarela tuvo un problema al crear el pago. Vuelve a intentarlo.",
  408: "Este medio de pago superó su límite. Prueba con otro medio o paga por Yape directo.",
  410: "El monto es menor al mínimo que acepta este medio de pago.",
  412: "Ese medio de pago no está disponible ahora mismo. Prueba con otro.",
  500: MENSAJE_CLIENTE_GENERICO,
};

const errorResponseSchema = z
  .object({
    code: z.union([z.number(), z.string()]).optional(),
    description: z.string().optional(),
    type: z.string().optional(),
    details: z.array(z.unknown()).optional(),
  })
  .passthrough();

function construirError(
  httpStatus: number,
  cuerpo: string,
  secret: string,
): TupayError {
  let parsed: z.infer<typeof errorResponseSchema> | null = null;
  try {
    const json: unknown = JSON.parse(cuerpo);
    const r = errorResponseSchema.safeParse(json);
    if (r.success) parsed = r.data;
  } catch {
    parsed = null;
  }
  const code = Number(parsed?.code ?? httpStatus);
  const type = parsed?.type ?? `HTTP_${httpStatus}`;
  const details = (parsed?.details ?? []).map((d) =>
    typeof d === "string" ? d : JSON.stringify(d),
  );
  // El cuerpo de error de Tupay no lleva PII, pero se redacta el secreto por si
  // el gateway hiciera eco de una cabecera.
  const descripcion = redactSecret(
    parsed?.description ?? cuerpo.slice(0, 500) ?? "sin descripción",
    secret,
  );
  return new TupayError(
    Number.isFinite(code) ? code : httpStatus,
    type,
    httpStatus,
    `Tupay ${type} (code ${code}, HTTP ${httpStatus}): ${descripcion}`,
    details.map((d) => redactSecret(d, secret)),
  );
}

// ---------------------------------------------------------------------------
// Petición
// ---------------------------------------------------------------------------

/** Body de `POST /v3/deposits`. Nombres en snake_case porque son de Tupay. */
export type TupayDepositRequest = {
  country: "PE";
  currency: "PEN";
  /** En SOLES decimales, no en céntimos. Ver `centsToSoles`. */
  amount: number;
  payment_method: TupayPaymentMethodCode;
  invoice_id: string;
  success_url: string;
  notification_url: string;
  payer: {
    first_name: string;
    last_name: string;
    document: string;
    email: string;
    document_type?: string;
    phone?: string;
    address?: string;
  };
  back_url?: string;
  error_url?: string;
  expiration?: number;
  test?: boolean;
  mobile?: boolean;
  fee_on_payer?: boolean;
  client_ip?: string;
  device_id?: string;
  description?: string;
};

/**
 * Céntimos → soles decimales, sin error de coma flotante.
 *
 * `cents / 100` en IEEE 754 no siempre da el decimal exacto, y aunque
 * `JSON.stringify` imprime la representación más corta que round-trippea (que
 * casi siempre coincide), construir el decimal como texto y convertirlo una sola
 * vez elimina la duda por completo: el double resultante es el más cercano al
 * decimal exacto, y su repr JSON vuelve a ser ese mismo decimal.
 *
 * No se usa `(cents/100).toFixed(2)` como string en el body porque Tupay espera
 * un number JSON, y `"249.37"` con comillas es un 201 BEAN_VALIDATION_ERROR.
 */
export function centsToSoles(cents: Cents): number {
  if (!Number.isInteger(cents) || cents < 0) {
    throw new Error(`monto en céntimos inválido: ${String(cents)}`);
  }
  const soles = Math.floor(cents / 100);
  const centimos = cents % 100;
  return Number(`${soles}.${String(centimos).padStart(2, "0")}`);
}

/** Soles decimales → céntimos. Para leer los importes que Tupay devuelve. */
export function solesToCents(soles: number): Cents {
  // `soles * 100` arrastra error binario (1.005*100 = 100.49999999999999).
  // Se normaliza en decimal antes de redondear.
  return Math.round(Number((soles * 100).toFixed(4)));
}

/**
 * `invoice_id` válido para Tupay: `^[A-Za-z0-9-_]*$`, máximo 128.
 *
 * Nuestra referencia (`COCO-7F3K2M`) ya cumple, pero se sanea igualmente porque
 * un `invoice_id` inválido es un 201 y el `invoice_id` es el nexo entre pedido y
 * depósito: si se corrompe, la conciliación se vuelve manual.
 */
export function normalizarInvoiceId(reference: string): string {
  const limpio = reference.trim().replace(/[^A-Za-z0-9\-_]/g, "-");
  if (limpio.length === 0) throw new Error("invoice_id vacío tras sanear la referencia");
  return limpio.slice(0, 128);
}

/**
 * Idempotency key DETERMINISTA derivada del `invoice_id`.
 *
 * Este es el punto delicado de todo el cliente. Si nuestro servidor hace la
 * petición, Tupay crea el depósito y la respuesta se pierde por un timeout, el
 * reintento debe llevar la MISMA key para que Tupay devuelva el depósito ya
 * creado en vez de crear un segundo. Un `randomUUID()` por intento derrotaría
 * literalmente el propósito de la idempotencia: el cliente vería dos cobros por
 * el mismo pedido y nosotros tendríamos que devolver uno a mano.
 *
 * Se hashea en lugar de usar el `invoice_id` tal cual para no filtrar la
 * referencia del pedido en una cabecera y para tener longitud fija.
 */
export function idempotencyKeyFor(invoiceId: string): string {
  return createHash("sha256").update(`coco-jambo:deposit:${invoiceId}`, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Respuesta
// ---------------------------------------------------------------------------

/**
 * Los esquemas usan `.passthrough()`: las pasarelas añaden campos sin avisar y
 * un `.strict()` convertiría una mejora suya en una caída nuestra. A cambio, los
 * campos que SÍ usamos están tipados de forma estricta, porque un `redirect_url`
 * ausente o un `deposit_id` numérico deben fallar aquí y no tres capas más
 * arriba.
 */
const qrMetadataSchema = z
  .object({
    paymentMethodType: z.literal("QR_CODE"),
    /** `data:image/png;base64,...` */
    qrCode: z.string().min(1),
    paymentMethod: z.string().optional(),
    expirationDate: z.string().optional(),
  })
  .passthrough();

const cardMetadataSchema = z
  .object({
    paymentMethodType: z.literal("CREDIT_CARD"),
    redirectUrl: z.string().min(1),
    paymentMethod: z.string().optional(),
  })
  .passthrough();

const transferMetadataSchema = z
  .object({
    paymentMethodType: z.literal("BANK_TRANSFER"),
    agreement: z.string().optional(),
    reference: z.string().optional(),
    paymentMethod: z.string().optional(),
  })
  .passthrough();

/** Entrada de tipo desconocido: se conserva en vez de invalidar la respuesta. */
const otraMetadataSchema = z
  .object({ paymentMethodType: z.string() })
  .passthrough();

const multigatewayEntrySchema = z.union([
  qrMetadataSchema,
  cardMetadataSchema,
  transferMetadataSchema,
  otraMetadataSchema,
]);

export type TupayMultigatewayEntry = z.infer<typeof multigatewayEntrySchema>;

const paymentInfoSchema = z
  .object({
    amount: z.number().optional(),
    currency: z.string().optional(),
    expiration_date: z.string().optional().nullable(),
    created_at: z.string().optional().nullable(),
    payment_method: z.string().optional(),
    metadata: z.unknown().optional(),
    multigateway_metadata: z.array(multigatewayEntrySchema).optional().default([]),
  })
  .passthrough();

const depositResponseSchema = z
  .object({
    checkout_type: z.enum(["ONE_SHOT", "HOSTED"]),
    redirect_url: z.string().optional().nullable(),
    // Se ha visto tanto booleano como string; se normaliza para que el resto del
    // código no tenga que dudar.
    iframe: z
      .union([z.boolean(), z.string()])
      .optional()
      .transform((v) => (typeof v === "string" ? v.toLowerCase() === "true" : v === true)),
    deposit_id: z.string().min(1),
    merchant_invoice_id: z.string().optional(),
    payment_info: paymentInfoSchema.optional(),
  })
  .passthrough();

export type TupayDepositResponse = z.infer<typeof depositResponseSchema>;

const statusResponseSchema = z
  .object({
    deposit_id: z.string().min(1),
    status: z.string().optional(),
    amount: z.number().optional(),
    updated_at: z.string().optional().nullable(),
    description: z.string().optional().nullable(),
    payment_info: paymentInfoSchema.optional(),
  })
  .passthrough();

export type TupayStatusResponse = z.infer<typeof statusResponseSchema>;

// ---------------------------------------------------------------------------
// Cliente
// ---------------------------------------------------------------------------

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type TupayLogger = {
  /** Recibe texto ya redactado. */
  warn(mensaje: string): void;
  info(mensaje: string): void;
};

export type TupayClientOptions = {
  readonly config: TupayConfig;
  /** Inyectable para testear sin red. Por defecto el `fetch` global. */
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
  /** Reintentos ADICIONALES sobre el primer intento. */
  readonly maxReintentos?: number;
  /** Inyectable para que los tests no esperen de verdad. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Inyectable para poder fijar `X-Date` en los tests. */
  readonly now?: () => Date;
  readonly logger?: TupayLogger;
};

const TIMEOUT_DEFECTO_MS = 15_000;
const REINTENTOS_DEFECTO = 2;

export class TupayClient {
  private readonly config: TupayConfig;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxReintentos: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;
  private readonly logger: TupayLogger | undefined;

  constructor(options: TupayClientOptions) {
    this.config = options.config;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? TIMEOUT_DEFECTO_MS;
    this.maxReintentos = options.maxReintentos ?? REINTENTOS_DEFECTO;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger;
  }

  get testMode(): boolean {
    return this.config.testMode;
  }

  /**
   * Crea un depósito. Reintenta sólo los fallos reintentables, reusando la misma
   * idempotency key.
   */
  async createDeposit(body: TupayDepositRequest): Promise<TupayDepositResponse> {
    const idempotencyKey = idempotencyKeyFor(body.invoice_id);
    // Una sola serialización: este string se firma y este string se envía.
    const payload = JSON.stringify(body);

    let ultimoError: TupayError | null = null;
    for (let intento = 0; intento <= this.maxReintentos; intento++) {
      try {
        const raw = await this.request("POST", "/v3/deposits", payload, idempotencyKey);
        const parsed = depositResponseSchema.safeParse(raw);
        if (!parsed.success) {
          // Una respuesta 201 que no entendemos es peor que un error: el depósito
          // pudo crearse. No se reintenta (crearía ruido) y se pide revisión.
          throw new TupayError(
            208,
            "RESPONSE_SHAPE_UNEXPECTED",
            201,
            `respuesta de Tupay con forma inesperada: ${parsed.error.issues
              .map((i) => `${i.path.join(".")}: ${i.message}`)
              .join("; ")}`,
          );
        }
        return parsed.data;
      } catch (error) {
        const tupayError = this.aTupayError(error);
        ultimoError = tupayError;
        if (!tupayError.esReintentable || intento === this.maxReintentos) throw tupayError;
        // Backoff exponencial corto: el cliente está esperando en la pantalla de
        // pago, así que no tiene sentido pasar de unos cientos de milisegundos.
        const esperaMs = 200 * 2 ** intento;
        this.logger?.warn(
          `Tupay reintentable (${tupayError.type}, code ${tupayError.code}); reintento ${
            intento + 1
          }/${this.maxReintentos} en ${esperaMs}ms con la misma idempotency key`,
        );
        await this.sleep(esperaMs);
      }
    }
    /* c8 ignore next */
    throw ultimoError ?? new TupayError(500, "GENERIC_ERROR", null, "fallo desconocido");
  }

  /**
   * Consulta el estado de un depósito.
   *
   * Existe porque una notificación puede perderse (o llegar antes de que hayamos
   * terminado de escribir el pedido): sin consulta activa, un pago cobrado
   * quedaría eternamente `pendiente_pago`.
   */
  async getDeposit(depositId: string): Promise<TupayStatusResponse> {
    // Un GET no lleva body, pero la firma se calcula sobre `xDate + xLogin + ""`:
    // el payload vacío es parte del contrato, no un olvido.
    const raw = await this.request(
      "GET",
      `/v3/deposits/${encodeURIComponent(depositId)}`,
      "",
      idempotencyKeyFor(`status:${depositId}`),
    );
    const parsed = statusResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new TupayError(
        208,
        "RESPONSE_SHAPE_UNEXPECTED",
        200,
        `respuesta de estado con forma inesperada para el depósito consultado`,
      );
    }
    return parsed.data;
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    payload: string,
    idempotencyKey: string,
  ): Promise<unknown> {
    // `X-Date` se formatea UNA vez y se usa tanto para firmar como para la
    // cabecera. Formatearlo dos veces podría cruzar un segundo y producir un
    // 102 INVALID_SIGNATURE intermitente, imposible de reproducir.
    const xDate = formatTupayDate(this.now());
    const authorization = buildAuthorizationHeader({
      xDate,
      xLogin: this.config.apiKey,
      payload,
      secret: this.config.apiSecret,
    });

    const url = `${this.config.baseUrl}${path}`;
    const init: RequestInit = {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Login": this.config.apiKey,
        "X-Date": xDate,
        Authorization: authorization,
        "X-Idempotency-Key": idempotencyKey,
      },
      // `AbortSignal.timeout` evita que una pasarela colgada mantenga ocupada la
      // petición del checkout hasta el timeout del runtime.
      signal: AbortSignal.timeout(this.timeoutMs),
    };
    if (method !== "GET") init.body = payload;

    this.logger?.info(
      `Tupay ${method} ${path} idem=${idempotencyKey.slice(0, 12)}… payload=${redactPayload(
        payload === "" ? "{}" : payload,
      )}`,
    );

    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (error) {
      // El mensaje de `fetch` puede incluir la URL y, con ella, cabeceras en
      // algunos runtimes: se redacta antes de propagarlo.
      const detalle = redactSecret(
        error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        this.config.apiSecret,
      );
      throw new TupayError(
        TUPAY_CODIGO_RED,
        "NETWORK_ERROR",
        null,
        `fallo de red hablando con Tupay: ${detalle}`,
      );
    }

    const texto = await response.text();
    if (!response.ok) {
      throw construirError(response.status, texto, this.config.apiSecret);
    }
    try {
      return JSON.parse(texto) as unknown;
    } catch {
      throw new TupayError(
        208,
        "RESPONSE_NOT_JSON",
        response.status,
        "Tupay respondió 2xx con un cuerpo que no es JSON",
      );
    }
  }

  private aTupayError(error: unknown): TupayError {
    if (error instanceof TupayError) return error;
    const detalle = redactSecret(
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      this.config.apiSecret,
    );
    return new TupayError(TUPAY_CODIGO_RED, "UNEXPECTED", null, detalle);
  }
}
