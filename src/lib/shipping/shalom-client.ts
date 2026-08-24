/**
 * Cliente HTTP del wrapper no oficial de Shalom (`api.shalom-api-peru.com`).
 *
 * LEER ANTES DE USAR — tres restricciones que no son del código sino del servicio:
 *
 * 1. NO ES UNA API OFICIAL. Shalom no publica ninguna. Este wrapper opera sobre
 *    `pro.shalom.pe` haciendo login real con las credenciales del comercio, así
 *    que puede romperse el día en que Shalom cambie su web, sin aviso ni
 *    versionado. Todo el módulo está diseñado para que apagarlo
 *    (`SHALOM_ENABLED=false`) devuelva el negocio al flujo manual sin tocar
 *    código.
 *
 * 2. NO HAY SANDBOX Y NO HAY IDEMPOTENCIA. Cada `POST /v1/orders` que responde
 *    2xx crea una guía real y cobrable. Un timeout del cliente NO significa que
 *    la guía no se creó: puede haberse creado y haberse perdido la respuesta.
 *    Por eso `emitirGuia` exige confirmación explícita, exige un
 *    `idempotencyGuard` y NUNCA reintenta sola. Ver esa función.
 *
 * 3. LA PRIMERA LLAMADA DE CADA CUENTA TARDA 90 s A 2 MIN, porque hace un login
 *    real contra Shalom. La doc exige timeout de cliente >= 150 s. Eso choca de
 *    frente con el límite de ejecución de una función serverless (10-15 s en el
 *    plan por defecto de Vercel), así que las rutas que tocan la cuenta tienen
 *    que ejecutarse en un worker o job en background, nunca dentro del request
 *    del checkout.
 *
 * Nada de esto se puede descubrir probando: probar cuesta guías reales.
 */

import { z } from "zod";
import type { Cents } from "@/lib/money";
import { isValidPickupCode } from "./pickup-code";
import { normalizarStatus } from "./tracking-normalizer";
import {
  refAQuery,
  type EmitirGuiaRequest,
  type EmitirGuiaResult,
  type GuiaEmitida,
  type PackageDimensions,
  type TrackingRef,
  type TrackingState,
} from "./types";

/** Base por defecto del wrapper. Configurable para poder apuntar a un proxy propio. */
export const SHALOM_BASE_URL_DEFECTO = "https://api.shalom-api-peru.com";

/**
 * Timeout de las rutas que tocan la cuenta del cliente (tracking detallado,
 * tarifas, órdenes, suscripciones).
 *
 * 150 s no es un número conservador por gusto: es el mínimo que exige la doc,
 * porque la primera llamada de cada cuenta arranca una sesión real contra
 * `pro.shalom.pe` y eso tarda entre 90 s y 2 min. Un timeout menor abortaría un
 * login que iba a funcionar, y con `POST /v1/orders` el aborto es peor que la
 * espera: la guía puede haberse creado igual.
 */
export const TIMEOUT_CUENTA_MS = 150_000;

/**
 * Timeout de las rutas públicas (agencias, ubicaciones, tracking en modo
 * estado).
 *
 * Estas no hacen login, así que 15 s es de sobra y mantener el default largo
 * sería dañino: el buscador de agencias se usa DENTRO del checkout, y dejar al
 * cliente 150 s mirando un spinner porque el wrapper está caído es peor que
 * fallar rápido y ofrecerle el catálogo cacheado.
 */
export const TIMEOUT_PUBLICO_MS = 15_000;

/** Tope duro del batch de tracking. El wrapper rechaza el lote entero si se pasa. */
export const MAX_ITEMS_BATCH = 50;

/** Tope de suscripciones activas simultáneas antes del 429 `quota_exceeded`. */
export const MAX_SUSCRIPCIONES_ACTIVAS = 50;

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------

const configSchema = z.object({
  apiKey: z.string().min(1, "SHALOM_API_KEY vacía"),
  /**
   * Credenciales de Shalom Pro. Son las del comercio en `pro.shalom.pe`: con
   * ellas se puede emitir guías cobrables y ver el historial completo de envíos.
   * Nunca deben salir en un log, un mensaje de error ni una traza.
   */
  proEmail: z.string().email("SHALOM_PRO_EMAIL no es un email válido"),
  proPassword: z.string().min(1, "SHALOM_PRO_PASSWORD vacía"),
  /** Se obtiene UNA sola vez al registrar el webhook y no se puede recuperar. */
  webhookSecret: z.string().min(1, "SHALOM_WEBHOOK_SECRET vacío"),
  baseUrl: z
    .string()
    .url("SHALOM_BASE_URL no es una URL válida")
    // Se normaliza la barra final: `${baseUrl}/v1/tracking` con una base
    // terminada en `/` produce `//v1/tracking` y un 404 desconcertante.
    .transform((u) => u.replace(/\/+$/, "")),
  habilitado: z.boolean(),
});

export type ShalomConfig = z.infer<typeof configSchema>;

const NOMBRE_VARIABLE: Readonly<Record<string, string>> = {
  apiKey: "SHALOM_API_KEY",
  proEmail: "SHALOM_PRO_EMAIL",
  proPassword: "SHALOM_PRO_PASSWORD",
  webhookSecret: "SHALOM_WEBHOOK_SECRET",
  baseUrl: "SHALOM_BASE_URL",
  habilitado: "SHALOM_ENABLED",
};

export class ShalomConfigError extends Error {
  readonly code = "SHALOM_CONFIG_INVALIDA";
  constructor(readonly problemas: readonly string[]) {
    super(
      `Configuración de Shalom incompleta o inválida:\n- ${problemas.join(
        "\n- ",
      )}\nDefine estas variables en el entorno del servidor (nunca con prefijo NEXT_PUBLIC_).`,
    );
    this.name = "ShalomConfigError";
  }
}

/** Lo que se considera "true" en una variable de entorno. Mismo criterio que en pagos. */
function parseBooleanEnv(valor: string | undefined, porDefecto: boolean): boolean {
  if (valor === undefined || valor.trim() === "") return porDefecto;
  return ["1", "true", "yes", "si", "sí", "on"].includes(valor.trim().toLowerCase());
}

/**
 * Lee y valida la configuración.
 *
 * Falla ruidosamente nombrando la variable que falta. El modo de fallo
 * alternativo sería un 401 `shalom_auth_failed` en producción, que desde fuera
 * parece un problema del wrapper y cuesta horas de diagnóstico.
 *
 * IMPORTANTE: los mensajes de error de esta función se construyen a partir del
 * NOMBRE de la variable, nunca de su valor. Un `zod` que incluyera el valor
 * recibido (como hace en algunos issues) filtraría la contraseña de Shalom Pro al
 * log de arranque. Por eso se mapea `issue.path` a nombre de variable y se
 * descarta el resto del issue.
 */
export function loadShalomConfig(env: NodeJS.ProcessEnv = process.env): ShalomConfig {
  const candidato = {
    apiKey: env.SHALOM_API_KEY ?? "",
    proEmail: env.SHALOM_PRO_EMAIL ?? "",
    proPassword: env.SHALOM_PRO_PASSWORD ?? "",
    webhookSecret: env.SHALOM_WEBHOOK_SECRET ?? "",
    baseUrl: env.SHALOM_BASE_URL ?? SHALOM_BASE_URL_DEFECTO,
    habilitado: parseBooleanEnv(env.SHALOM_ENABLED, false),
  };
  const parsed = configSchema.safeParse(candidato);
  if (!parsed.success) {
    const problemas = parsed.error.issues.map((i) => {
      const clave = String(i.path[0]);
      const variable = NOMBRE_VARIABLE[clave] ?? clave;
      // El mensaje de zod se sanea igualmente: si alguien añade un `.refine` con
      // un mensaje que interpole el valor, esto evita que la contraseña salga.
      return `${variable}: ${redactar(i.message, candidato.proPassword, candidato.apiKey)}`;
    });
    throw new ShalomConfigError(problemas);
  }
  return parsed.data;
}

/** ¿Está Shalom configurada y encendida? Para decidir sin lanzar. */
export function shalomEstaConfigurada(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return loadShalomConfig(env).habilitado;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Redacción
// ---------------------------------------------------------------------------

/** Marcador visible: si aparece en un log, la redacción funcionó. */
export const MARCADOR_REDACTADO = "[REDACTED]";

/**
 * Elimina de un texto cualquier aparición de los secretos.
 *
 * Se aplica a TODO lo que salga hacia un log o un mensaje de error. El riesgo
 * real no es un `console.log(password)` deliberado, sino que el `error.message`
 * de `fetch`, un stack o el eco de un body de error incluyan la credencial y
 * acaben en un servicio de observabilidad de terceros. Con la contraseña de
 * Shalom Pro filtrada, cualquiera puede emitir guías cobrables a nuestro nombre.
 *
 * Se ignoran los secretos muy cortos (< 4 caracteres) porque reemplazar una
 * cadena de 1-2 caracteres destrozaría el mensaje sin aportar seguridad; una
 * contraseña de esa longitud es un problema distinto.
 */
export function redactar(texto: string, ...secretos: readonly (string | undefined)[]): string {
  let salida = texto;
  for (const secreto of secretos) {
    if (secreto === undefined || secreto.length < 4) continue;
    salida = salida.split(secreto).join(MARCADOR_REDACTADO);
    // El wrapper acepta las credenciales por header, y algunos clientes las
    // codifican en la URL: se limpia también la forma percent-encoded.
    const codificado = encodeURIComponent(secreto);
    if (codificado !== secreto) salida = salida.split(codificado).join(MARCADOR_REDACTADO);
  }
  return salida;
}

/** Headers que jamás deben aparecer en un log, ni con valor truncado. */
const HEADERS_SENSIBLES = new Set([
  "x-api-key",
  "x-shalom-session",
  "x-shalom-email",
  "x-shalom-password",
  "authorization",
]);

/**
 * Versión de los headers apta para logs: conserva los nombres (útiles para
 * depurar qué modo de auth se usó) y borra los valores.
 */
export function redactarHeaders(
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  const salida: Record<string, string> = {};
  for (const [clave, valor] of Object.entries(headers)) {
    salida[clave] = HEADERS_SENSIBLES.has(clave.toLowerCase()) ? MARCADOR_REDACTADO : valor;
  }
  return salida;
}

// ---------------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------------

/** Códigos que documenta el wrapper, más los sintéticos del lado del cliente. */
export const CODIGOS_SHALOM = [
  "bad_request",
  "unauthorized",
  "shalom_auth_failed",
  "not_found",
  "conflict",
  "upstream_rejected",
  "rate_limited",
  "upstream_unavailable",
  "upstream_timeout",
  "internal",
  /** Sintéticos: no vienen del wrapper. */
  "network_error",
  "client_timeout",
  "respuesta_invalida",
  "deshabilitado",
] as const;

export type ShalomErrorCode = (typeof CODIGOS_SHALOM)[number];

/**
 * Fallos que merece la pena reintentar: el servidor no llegó a decidir nada, o
 * dijo explícitamente "vuelve luego".
 *
 * `client_timeout` está DENTRO porque para la mayoría de rutas (tracking,
 * agencias, tarifas) reintentar es inocuo. La excepción es `emitirGuia`, que
 * nunca reintenta sola precisamente porque ahí un timeout puede esconder una
 * guía ya creada. Esa decisión vive en el método, no en la clase de error: el
 * error no sabe qué operación lo produjo.
 */
const CODIGOS_REINTENTABLES = new Set<ShalomErrorCode>([
  "upstream_unavailable",
  "upstream_timeout",
  "rate_limited",
  "internal",
  "network_error",
  "client_timeout",
]);

/**
 * Mensajes para el cliente final. Separados del técnico a propósito: el técnico
 * menciona el wrapper, los códigos y el `request_id`, y nada de eso debe llegar
 * a la pantalla de alguien comprando zapatillas.
 */
const MENSAJE_CLIENTE: Readonly<Record<ShalomErrorCode, string>> = {
  bad_request: "No pudimos procesar los datos del envío. Revisa la dirección y vuelve a intentar.",
  unauthorized: "El servicio de envíos no está disponible en este momento.",
  shalom_auth_failed: "El servicio de envíos no está disponible en este momento.",
  not_found: "No encontramos ese envío. Verifica el número de guía y el código.",
  conflict: "Este envío ya fue registrado.",
  upstream_rejected: "Shalom rechazó los datos del envío. Vamos a coordinarlo contigo por WhatsApp.",
  rate_limited: "Hay muchas consultas en curso. Espera unos segundos y vuelve a intentar.",
  upstream_unavailable: "El sistema de Shalom no responde. Lo intentamos de nuevo en unos minutos.",
  upstream_timeout: "El sistema de Shalom está lento. Lo intentamos de nuevo en unos minutos.",
  internal: "Tuvimos un problema con el servicio de envíos. Ya estamos revisándolo.",
  network_error: "No pudimos conectar con el servicio de envíos.",
  client_timeout: "La consulta al servicio de envíos tardó demasiado.",
  respuesta_invalida: "Tuvimos un problema con el servicio de envíos. Ya estamos revisándolo.",
  deshabilitado: "El seguimiento automático no está activo. Te escribimos con el número de guía.",
};

export class ShalomError extends Error {
  readonly name = "ShalomError";
  constructor(
    readonly code: ShalomErrorCode,
    /** `null` cuando el fallo fue antes de recibir respuesta (red, timeout). */
    readonly httpStatus: number | null,
    /** `request_id` del wrapper. Es lo único que sirve para pedirles soporte. */
    readonly requestId: string | null,
    /** Detalle técnico, ya redactado. Va al log, nunca a la pantalla. */
    readonly detalle: string,
    /** Segundos que pidió esperar el 429, si los mandó. */
    readonly retryAfterSegundos: number | null = null,
  ) {
    super(`shalom ${code}${httpStatus === null ? "" : ` (HTTP ${httpStatus})`}: ${detalle}`);
  }

  get esReintentable(): boolean {
    return CODIGOS_REINTENTABLES.has(this.code);
  }

  get mensajeCliente(): string {
    return MENSAJE_CLIENTE[this.code];
  }

  /**
   * `true` si el fallo deja en duda si la operación se ejecutó del otro lado.
   *
   * Es la distinción que importa para `emitirGuia`: un 422 significa que no se
   * creó nada, pero un timeout no significa nada. Se usa para decidir si hay que
   * verificar antes de reintentar.
   */
  get resultadoIncierto(): boolean {
    return (
      this.code === "client_timeout" ||
      this.code === "upstream_timeout" ||
      this.code === "network_error" ||
      this.code === "upstream_unavailable"
    );
  }
}

const errorBodySchema = z
  .object({
    error: z
      .object({
        code: z.string().nullish(),
        message: z.string().nullish(),
        request_id: z.string().nullish(),
      })
      .passthrough(),
  })
  .passthrough();

function esCodigoConocido(valor: string): valor is ShalomErrorCode {
  return (CODIGOS_SHALOM as readonly string[]).includes(valor);
}

/** Mapa de respaldo cuando el cuerpo del error no trae `code` (un 502 del CDN, por ejemplo). */
function codigoPorStatus(status: number): ShalomErrorCode {
  if (status === 400) return "bad_request";
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 422) return "upstream_rejected";
  if (status === 429) return "rate_limited";
  if (status === 502 || status === 503) return "upstream_unavailable";
  if (status === 504) return "upstream_timeout";
  return "internal";
}

/**
 * Construye el error a partir de la respuesta.
 *
 * Redacta el cuerpo antes de guardarlo: el wrapper hace eco de parte de la
 * petición en algunos 422, y esa petición puede llevar las credenciales.
 */
export function construirShalomError(
  status: number,
  cuerpo: string,
  retryAfter: string | null,
  ...secretos: readonly (string | undefined)[]
): ShalomError {
  let code = codigoPorStatus(status);
  let mensaje = cuerpo.slice(0, 500);
  let requestId: string | null = null;
  try {
    const parsed = errorBodySchema.safeParse(JSON.parse(cuerpo));
    if (parsed.success) {
      const e = parsed.data.error;
      if (typeof e.code === "string" && esCodigoConocido(e.code)) code = e.code;
      if (typeof e.message === "string" && e.message.trim() !== "") mensaje = e.message;
      if (typeof e.request_id === "string") requestId = e.request_id;
    }
  } catch {
    // Un cuerpo que no es JSON (HTML de un balanceador) se conserva truncado:
    // suele ser la única pista de que el fallo no vino del wrapper.
  }
  return new ShalomError(
    code,
    status,
    requestId,
    redactar(mensaje, ...secretos),
    parseRetryAfter(retryAfter),
  );
}

/**
 * `Retry-After` puede venir en segundos o como fecha HTTP. Se soportan los dos
 * porque el wrapper documenta segundos pero un proxy intermedio puede reescribir
 * la cabecera.
 */
export function parseRetryAfter(valor: string | null): number | null {
  if (valor === null || valor.trim() === "") return null;
  const texto = valor.trim();
  if (/^\d+$/.test(texto)) return Number(texto);
  const fecha = Date.parse(texto);
  if (Number.isNaN(fecha)) return null;
  const segundos = Math.ceil((fecha - Date.now()) / 1000);
  return segundos > 0 ? segundos : 0;
}

// ---------------------------------------------------------------------------
// Conversión de dinero
// ---------------------------------------------------------------------------

/**
 * Convierte los soles decimales de la respuesta a céntimos enteros.
 *
 * `Math.round(valor * 100)` es lo intuitivo y está mal: `20.15 * 100` da
 * `2014.9999999999998` en IEEE 754, que redondea bien por casualidad, pero
 * `1.005 * 100` da `100.49999999999999` y redondea a 100 en vez de a 101. Con
 * tarifas de envío el error es de un céntimo, y un céntimo de descalce rompe la
 * conciliación contra el extracto de Shalom.
 *
 * Se opera sobre la representación DECIMAL: se parte por el punto y se leen los
 * dígitos. Acepta string además de number porque el wrapper devuelve algunos
 * montos entrecomillados, y `Number("20.15")` reintroduciría el binario.
 *
 * No se reutiliza `solesToCents` de `@/lib/money` porque esa función solo acepta
 * `number` (está pensada para la entrada del admin) y aquí el dato puede llegar
 * como string desde JSON.
 */
export function solesACents(valor: number | string): Cents {
  const texto = typeof valor === "number" ? String(valor) : valor.trim();
  if (texto === "" || !/^-?\d+(\.\d+)?$/.test(texto)) {
    throw new ShalomError(
      "respuesta_invalida",
      null,
      null,
      `monto no numérico en la respuesta de tarifas: ${JSON.stringify(valor).slice(0, 40)}`,
    );
  }
  const negativo = texto.startsWith("-");
  const sinSigno = negativo ? texto.slice(1) : texto;
  const [enteros, decimales = ""] = sinSigno.split(".");
  const dos = decimales.padEnd(3, "0");
  let cents = Number(enteros) * 100 + Number(dos.slice(0, 2));
  // Redondeo al céntimo más cercano mirando el tercer decimal, sin coma flotante.
  if (Number(dos[2]) >= 5) cents += 1;
  if (!Number.isSafeInteger(cents)) {
    throw new ShalomError(
      "respuesta_invalida",
      null,
      null,
      "monto fuera de rango en la respuesta de tarifas",
    );
  }
  return negativo ? -cents : cents;
}

// ---------------------------------------------------------------------------
// Esquemas de respuesta
// ---------------------------------------------------------------------------

/**
 * Todos los esquemas llevan `passthrough`: el wrapper es de terceros y añade
 * campos sin versionar. Rechazar por un campo nuevo convertiría una mejora suya
 * en una caída nuestra.
 */
const sessionSchema = z
  .object({
    session_token: z.string().min(1),
    /** ISO 8601. El token vive 2 h. */
    expires_at: z.string().min(1),
  })
  .passthrough();

const hitoSchema = z
  .object({
    fecha: z.string().nullish(),
    completo: z.boolean().nullish(),
    carguero: z.string().nullish(),
    cargueros: z.array(z.string()).nullish(),
  })
  .passthrough();

/** Los 7 hitos, todos nulables: los que no ocurrieron llegan en `null`. */
const statusSchema = z
  .object({
    registrado: hitoSchema.nullish(),
    origen: hitoSchema.nullish(),
    transito: hitoSchema.nullish(),
    demora: hitoSchema.nullish(),
    destino: hitoSchema.nullish(),
    entregado: hitoSchema.nullish(),
    reparto: hitoSchema.nullish(),
  })
  .passthrough();

/**
 * Bloque `order` del modo detallado.
 *
 * AVISO DE LA DOC: desde julio de 2026, `origen`, `destino`, `remitente`,
 * `destinatario` y `comprobante` llegan VACÍOS porque Shalom dejó de enviarlos.
 * No están en este esquema a propósito: si estuvieran como campos opcionales,
 * alguien construiría una pantalla sobre ellos y quedaría en blanco en
 * producción. Lo que sí llega es lo de abajo.
 */
const orderSchema = z
  .object({
    guia: z.string().nullish(),
    serie: z.string().nullish(),
    codigo: z.string().nullish(),
    ose_id: z.string().nullish(),
    fecha_registro: z.string().nullish(),
    contenido: z.string().nullish(),
    monto: z.union([z.number(), z.string()]).nullish(),
    tipo_pago: z.string().nullish(),
    estado_pago: z.string().nullish(),
    entregado: z.boolean().nullish(),
    reparto: z.boolean().nullish(),
    aereo: z.boolean().nullish(),
  })
  .passthrough();

const trackingSchema = z
  .object({
    /** `false` en modo estado (solo API key), `true` con credenciales válidas. */
    detailed: z.boolean().nullish(),
    status: statusSchema.nullish(),
    order: orderSchema.nullish(),
  })
  .passthrough();

export type ShalomTrackingRespuesta = z.infer<typeof trackingSchema>;

const batchItemSchema = z
  .object({
    custom_id: z.string().nullish(),
    ok: z.boolean(),
    detailed: z.boolean().nullish(),
    status: statusSchema.nullish(),
    order: orderSchema.nullish(),
    error: z
      .object({ code: z.string().nullish(), message: z.string().nullish() })
      .passthrough()
      .nullish(),
  })
  .passthrough();

const batchSchema = z.object({ results: z.array(batchItemSchema) }).passthrough();

export type ShalomBatchItem = z.infer<typeof batchItemSchema>;

const agenciaSchema = z
  .object({
    id: z.union([z.string(), z.number()]).transform(String),
    nombre: z.string().nullish(),
    departamento: z.string().nullish(),
    provincia: z.string().nullish(),
    distrito: z.string().nullish(),
    direccion: z.string().nullish(),
    telefono: z.string().nullish(),
    aereo: z.boolean().nullish(),
    lat: z.union([z.number(), z.string()]).nullish(),
    lng: z.union([z.number(), z.string()]).nullish(),
    /** Solo presente cuando se consulta con `near`. */
    distancia_km: z.union([z.number(), z.string()]).nullish(),
  })
  .passthrough();

const agenciasSchema = z
  .object({
    data: z.array(agenciaSchema).nullish(),
    results: z.array(agenciaSchema).nullish(),
  })
  .passthrough();

export type ShalomAgencia = z.infer<typeof agenciaSchema>;

const tarifaSchema = z
  .object({
    currency: z.string().nullish(),
    breakdown: z
      .object({
        sobre: z.union([z.number(), z.string()]).nullish(),
        caja_paquete_xxs: z.union([z.number(), z.string()]).nullish(),
        caja_paquete_xs: z.union([z.number(), z.string()]).nullish(),
        caja_paquete_s: z.union([z.number(), z.string()]).nullish(),
        caja_paquete_m: z.union([z.number(), z.string()]).nullish(),
        caja_paquete_l: z.union([z.number(), z.string()]).nullish(),
        otra_medida: z.union([z.number(), z.string()]).nullish(),
      })
      .passthrough(),
    product: z
      .object({
        id: z.union([z.string(), z.number()]).transform(String),
        title: z.string().nullish(),
        price: z.union([z.number(), z.string()]).nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

/** Las 7 medidas de caja de Shalom, ya en céntimos. */
export type TarifaCents = {
  readonly moneda: string;
  readonly desglose: Readonly<Record<string, Cents>>;
  readonly producto: { readonly id: string; readonly titulo: string; readonly precioCents: Cents } | null;
};

const guiaSchema = z
  .object({
    guia: z.union([z.string(), z.number()]).transform(String),
    serie: z.union([z.string(), z.number()]).transform(String),
    codigo: z.union([z.string(), z.number()]).transform(String),
    ose_id: z.union([z.string(), z.number()]).transform(String),
  })
  .passthrough();

const webhookSchema = z
  .object({
    url: z.string().nullish(),
    /** Se devuelve UNA sola vez. Si se pierde, hay que registrar de nuevo. */
    signing_secret: z.string().min(1),
  })
  .passthrough();

const suscripcionSchema = z
  .object({
    id: z.union([z.string(), z.number()]).transform(String).nullish(),
    numero: z.string().nullish(),
    activa: z.boolean().nullish(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Cliente
// ---------------------------------------------------------------------------

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type ShalomLogger = {
  /** Recibe texto YA redactado. */
  warn(mensaje: string): void;
  info(mensaje: string): void;
};

/** Info del rate limit que devuelve el wrapper en cada respuesta. */
export type RateLimitInfo = {
  readonly limite: number | null;
  readonly restantes: number | null;
  readonly resetEn: Date | null;
};

export type ShalomClientOptions = {
  readonly config: ShalomConfig;
  /** Inyectable para testear sin red. Ningún test debe salir a internet. */
  readonly fetchImpl?: FetchLike;
  readonly timeoutCuentaMs?: number;
  readonly timeoutPublicoMs?: number;
  /** Reintentos ADICIONALES al primer intento, solo para operaciones seguras. */
  readonly maxReintentos?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
  readonly logger?: ShalomLogger;
};

type ModoAuth = "publico" | "cuenta";

type PeticionOpciones = {
  readonly metodo: "GET" | "POST" | "PUT";
  readonly ruta: string;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly cuerpo?: unknown;
  readonly modo: ModoAuth;
  /** `false` para operaciones no idempotentes. Ver `emitirGuia`. */
  readonly reintentable?: boolean;
  readonly timeoutMs?: number;
};

const REINTENTOS_DEFECTO = 2;

/** Tope de espera al respetar un `Retry-After`, para no colgar un job media hora. */
const MAX_ESPERA_RETRY_AFTER_MS = 60_000;

export class ShalomClient {
  private readonly config: ShalomConfig;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutCuentaMs: number;
  private readonly timeoutPublicoMs: number;
  private readonly maxReintentos: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;
  private readonly logger: ShalomLogger | undefined;

  /** Sesión vigente cacheada en memoria. */
  private sesion: { token: string; expiraEn: Date } | null = null;
  /**
   * Promesa del login en curso.
   *
   * ESTA es la razón de que exista: el primer login tarda 90 s a 2 min. Si cinco
   * peticiones concurrentes descubren a la vez que no hay token, sin esta promesa
   * compartida se dispararían cinco logins de dos minutos contra `pro.shalom.pe`,
   * quemando cinco de las 60 req/min y arriesgando que Shalom trate la ráfaga de
   * autenticaciones como abuso y bloquee la cuenta. Con la promesa compartida,
   * las cinco esperan el mismo login.
   */
  private loginEnCurso: Promise<string> | null = null;

  /** Último estado de rate limit observado, para que un job pueda autoregularse. */
  private ultimoRateLimit: RateLimitInfo = { limite: null, restantes: null, resetEn: null };

  constructor(options: ShalomClientOptions) {
    this.config = options.config;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.timeoutCuentaMs = options.timeoutCuentaMs ?? TIMEOUT_CUENTA_MS;
    this.timeoutPublicoMs = options.timeoutPublicoMs ?? TIMEOUT_PUBLICO_MS;
    this.maxReintentos = options.maxReintentos ?? REINTENTOS_DEFECTO;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger;
  }

  get rateLimit(): RateLimitInfo {
    return this.ultimoRateLimit;
  }

  // -------------------------------------------------------------------------
  // Sesión
  // -------------------------------------------------------------------------

  /**
   * Token de sesión de Shalom Pro (`ssk_...`), válido 2 h.
   *
   * Se prefiere el token sobre mandar email y contraseña en cada llamada (el
   * wrapper acepta las dos formas) por dos motivos: la contraseña viaja una vez
   * en lugar de en cada request, y solo el primer login paga los 2 minutos.
   */
  async crearSesion(forzar = false): Promise<string> {
    if (!forzar) {
      const vigente = this.sesionVigente();
      if (vigente !== null) return vigente;
      if (this.loginEnCurso !== null) return this.loginEnCurso;
    }

    const promesa = this.ejecutarLogin();
    this.loginEnCurso = promesa;
    try {
      return await promesa;
    } finally {
      // Se limpia gane o falle: si falla y no se limpiara, todas las peticiones
      // siguientes reusarían la promesa rechazada y la sesión nunca se recuperaría.
      if (this.loginEnCurso === promesa) this.loginEnCurso = null;
    }
  }

  private async ejecutarLogin(): Promise<string> {
    this.logger?.info(
      "Shalom: creando sesión Pro (el primer login de la cuenta puede tardar hasta 2 min)",
    );
    const raw = await this.peticion({
      metodo: "POST",
      ruta: "/v1/shalom/sessions",
      // Aquí sí viajan las credenciales, y solo aquí.
      cuerpo: { email: this.config.proEmail, password: this.config.proPassword },
      modo: "publico",
      // El login es idempotente (crea un token nuevo, no cobra nada), así que
      // reintentarlo es seguro.
      reintentable: true,
      timeoutMs: this.timeoutCuentaMs,
    });
    const parsed = sessionSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ShalomError(
        "respuesta_invalida",
        200,
        null,
        "la respuesta de /v1/shalom/sessions no trae session_token",
      );
    }
    const expira = new Date(parsed.data.expires_at);
    this.sesion = {
      token: parsed.data.session_token,
      // Si `expires_at` no parsea, se asume la vida documentada de 2 h en vez de
      // dejar la sesión sin caducidad: un token vencido daría 401 en bucle.
      expiraEn: Number.isNaN(expira.getTime())
        ? new Date(this.now().getTime() + 2 * 60 * 60 * 1000)
        : expira,
    };
    return this.sesion.token;
  }

  /**
   * Token vigente, o `null` si falta o está a punto de vencer.
   *
   * Se renueva 5 minutos ANTES de la expiración porque una petición de cuenta
   * puede durar 150 s: un token con 30 s de vida al empezar llegaría caducado al
   * upstream, y el 401 resultante costaría otro login de dos minutos.
   */
  private sesionVigente(): string | null {
    if (this.sesion === null) return null;
    const margenMs = 5 * 60 * 1000;
    if (this.sesion.expiraEn.getTime() - margenMs <= this.now().getTime()) return null;
    return this.sesion.token;
  }

  /** Descarta la sesión cacheada. Se llama al recibir `shalom_auth_failed`. */
  private invalidarSesion(): void {
    this.sesion = null;
  }

  // -------------------------------------------------------------------------
  // Transporte
  // -------------------------------------------------------------------------

  private async cabeceras(modo: ModoAuth): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      // La API key va en TODAS las rutas, también las públicas.
      "X-API-Key": this.config.apiKey,
    };
    if (modo === "cuenta") {
      headers["X-Shalom-Session"] = await this.crearSesion();
    }
    return headers;
  }

  private url(ruta: string, query?: PeticionOpciones["query"]): string {
    const base = `${this.config.baseUrl}${ruta}`;
    if (query === undefined) return base;
    const params = new URLSearchParams();
    for (const [clave, valor] of Object.entries(query)) {
      if (valor === undefined) continue;
      params.set(clave, String(valor));
    }
    const qs = params.toString();
    return qs === "" ? base : `${base}?${qs}`;
  }

  /**
   * Una petición, con reintentos solo si el llamador lo permite.
   *
   * `reintentable` es opt-in por operación y no una propiedad del error: el mismo
   * `client_timeout` es inocuo en un GET de tracking y peligroso en un POST de
   * órdenes. Dejar que la clase de error decida sería darle la decisión a quien no
   * sabe qué se estaba haciendo.
   */
  private async peticion(opciones: PeticionOpciones): Promise<unknown> {
    const permiteReintento = opciones.reintentable ?? false;
    const maxIntentos = permiteReintento ? this.maxReintentos + 1 : 1;
    let ultimo: ShalomError | null = null;

    for (let intento = 0; intento < maxIntentos; intento++) {
      try {
        return await this.intentar(opciones);
      } catch (error) {
        const e = this.aShalomError(error);
        ultimo = e;
        if (e.code === "shalom_auth_failed" || e.code === "unauthorized") {
          // La sesión cacheada puede haber caducado antes de lo anunciado. Se
          // descarta para que el próximo intento haga login limpio.
          this.invalidarSesion();
        }
        if (!e.esReintentable || intento === maxIntentos - 1) throw e;
        const esperaMs = this.esperaAntesDeReintentar(e, intento);
        this.logger?.warn(
          `Shalom ${opciones.metodo} ${opciones.ruta} falló con ${e.code}; reintento ${
            intento + 1
          }/${this.maxReintentos} en ${esperaMs}ms`,
        );
        await this.sleep(esperaMs);
      }
    }
    /* c8 ignore next */
    throw ultimo ?? new ShalomError("internal", null, null, "fallo desconocido");
  }

  /**
   * Cuánto esperar antes del siguiente intento.
   *
   * Si el wrapper mandó `Retry-After` se respeta: es el único que sabe cuándo se
   * reinicia la ventana de 60 req/min, y reintentar antes solo consume cuota y
   * garantiza otro 429. Se acota a 60 s para que un `Retry-After` disparatado no
   * cuelgue el job.
   */
  private esperaAntesDeReintentar(error: ShalomError, intento: number): number {
    if (error.retryAfterSegundos !== null) {
      return Math.min(error.retryAfterSegundos * 1000, MAX_ESPERA_RETRY_AFTER_MS);
    }
    return 500 * 2 ** intento;
  }

  private async intentar(opciones: PeticionOpciones): Promise<unknown> {
    if (!this.config.habilitado) {
      throw new ShalomError(
        "deshabilitado",
        null,
        null,
        "SHALOM_ENABLED está apagado: el cliente no debe usarse",
      );
    }

    const headers = await this.cabeceras(opciones.modo);
    const timeoutMs =
      opciones.timeoutMs ?? (opciones.modo === "cuenta" ? this.timeoutCuentaMs : this.timeoutPublicoMs);
    const url = this.url(opciones.ruta, opciones.query);

    const init: RequestInit = {
      method: opciones.metodo,
      headers,
      // `AbortSignal.timeout` evita que un upstream colgado retenga el worker
      // indefinidamente. El valor lo decide el modo: ver TIMEOUT_CUENTA_MS.
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (opciones.cuerpo !== undefined) init.body = JSON.stringify(opciones.cuerpo);

    this.logger?.info(
      `Shalom ${opciones.metodo} ${opciones.ruta} timeout=${timeoutMs}ms headers=${JSON.stringify(
        redactarHeaders(headers),
      )}`,
    );

    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (error) {
      const esAbort =
        error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new ShalomError(
        esAbort ? "client_timeout" : "network_error",
        null,
        null,
        this.redactado(error instanceof Error ? `${error.name}: ${error.message}` : String(error)),
      );
    }

    this.leerRateLimit(response);

    const texto = await response.text();
    if (!response.ok) {
      throw construirShalomError(
        response.status,
        texto,
        response.headers.get("retry-after"),
        this.config.proPassword,
        this.config.apiKey,
        this.config.webhookSecret,
      );
    }
    if (texto.trim() === "") return {};
    try {
      return JSON.parse(texto) as unknown;
    } catch {
      throw new ShalomError(
        "respuesta_invalida",
        response.status,
        null,
        "el wrapper respondió 2xx con un cuerpo que no es JSON",
      );
    }
  }

  private leerRateLimit(response: Response): void {
    const num = (nombre: string): number | null => {
      const valor = response.headers.get(nombre);
      return valor !== null && /^\d+$/.test(valor.trim()) ? Number(valor.trim()) : null;
    };
    const reset = num("x-ratelimit-reset");
    this.ultimoRateLimit = {
      limite: num("x-ratelimit-limit"),
      restantes: num("x-ratelimit-remaining"),
      // El header viene como epoch en segundos.
      resetEn: reset === null ? null : new Date(reset * 1000),
    };
  }

  private redactado(texto: string): string {
    return redactar(texto, this.config.proPassword, this.config.apiKey, this.config.webhookSecret);
  }

  private aShalomError(error: unknown): ShalomError {
    if (error instanceof ShalomError) return error;
    return new ShalomError(
      "internal",
      null,
      null,
      this.redactado(error instanceof Error ? `${error.name}: ${error.message}` : String(error)),
    );
  }

  // -------------------------------------------------------------------------
  // Tracking
  // -------------------------------------------------------------------------

  /**
   * Consulta el estado de un envío.
   *
   * `detallado` pide el bloque `order` (exige credenciales). Si la autenticación
   * falla, se DEGRADA al modo estado en lugar de propagar el error: el cliente
   * que espera ver dónde está su paquete no debe quedarse sin respuesta porque
   * nuestra contraseña de Shalom Pro caducó. El fallo sí se loguea, porque hay
   * que arreglarlo.
   *
   * Recordatorio sobre `order`: sus bloques `origen`, `destino`, `remitente`,
   * `destinatario` y `comprobante` llegan vacíos desde julio de 2026. No construir
   * nada sobre ellos.
   */
  async consultarTracking(
    ref: TrackingRef,
    detallado = false,
  ): Promise<{
    readonly tracking: TrackingState;
    readonly detallado: boolean;
    readonly order: z.infer<typeof orderSchema> | null;
  }> {
    const query = refAQuery(ref);
    const pedir = async (modo: ModoAuth): Promise<ShalomTrackingRespuesta> => {
      const raw = await this.peticion({
        metodo: "GET",
        ruta: "/v1/tracking",
        query,
        modo,
        // Un GET de tracking es idempotente: reintentar no tiene coste.
        reintentable: true,
      });
      const parsed = trackingSchema.safeParse(raw);
      if (!parsed.success) {
        throw new ShalomError(
          "respuesta_invalida",
          200,
          null,
          `respuesta de tracking con forma inesperada: ${parsed.error.issues
            .map((i) => i.path.join("."))
            .join(", ")}`,
        );
      }
      return parsed.data;
    };

    let respuesta: ShalomTrackingRespuesta;
    if (detallado) {
      try {
        respuesta = await pedir("cuenta");
      } catch (error) {
        const e = this.aShalomError(error);
        if (e.code !== "shalom_auth_failed" && e.code !== "unauthorized") throw e;
        this.logger?.warn(
          "Shalom: credenciales Pro rechazadas; se degrada el tracking a modo estado. Revisar SHALOM_PRO_*",
        );
        respuesta = await pedir("publico");
      }
    } else {
      respuesta = await pedir("publico");
    }

    return {
      tracking: normalizarStatus(respuesta.status ?? null),
      detallado: respuesta.detailed === true,
      order: respuesta.order ?? null,
    };
  }

  /**
   * Consulta hasta N envíos, troceando en grupos de 50.
   *
   * El troceado es automático porque el límite de 50 es DURO: mandar 51 items no
   * devuelve 50 resultados y un error, rechaza el lote completo. Dejar el troceo
   * al llamador significaría que el primer job nocturno con 137 pedidos fallara
   * entero.
   *
   * Los errores llegan POR ITEM (`ok: false`) con status global 200, así que un
   * envío inexistente no invalida los otros 49. Se preserva el orden de entrada y
   * se hace eco del `custom_id`, que es lo que permite casar cada resultado con su
   * pedido sin depender de la posición.
   */
  async consultarTrackingLote(
    items: readonly ShalomBatchRequestItem[],
  ): Promise<readonly ShalomBatchResultado[]> {
    const salida: ShalomBatchResultado[] = [];
    for (const grupo of trocear(items, MAX_ITEMS_BATCH)) {
      const raw = await this.peticion({
        metodo: "POST",
        ruta: "/v1/tracking/batch",
        cuerpo: {
          items: grupo.map((i) => ({
            ...(i.customId !== undefined ? { custom_id: i.customId } : {}),
            ...(i.ref.tipo === "guia"
              ? { numero: i.ref.numero, codigo: i.ref.codigo }
              : { ose_id: i.ref.oseId }),
          })),
        },
        modo: "cuenta",
        // Consultar es idempotente: no crea ni cobra nada.
        reintentable: true,
      });
      const parsed = batchSchema.safeParse(raw);
      if (!parsed.success) {
        throw new ShalomError(
          "respuesta_invalida",
          200,
          null,
          "respuesta de /v1/tracking/batch sin array `results`",
        );
      }
      // El orden de `results` se corresponde con el de `items`; el índice se usa
      // solo como respaldo cuando el item no llevaba `custom_id`.
      parsed.data.results.forEach((r, i) => {
        const entrada = grupo[i];
        salida.push({
          customId: r.custom_id ?? entrada?.customId ?? null,
          ok: r.ok,
          tracking: r.ok ? normalizarStatus(r.status ?? null) : null,
          error:
            r.ok || r.error === null || r.error === undefined
              ? null
              : {
                  code: r.error.code ?? "desconocido",
                  message: r.error.message ?? "sin detalle",
                },
        });
      });
    }
    return salida;
  }

  // -------------------------------------------------------------------------
  // Agencias
  // -------------------------------------------------------------------------

  /**
   * Busca agencias. Es una ruta pública, así que usa el timeout corto.
   *
   * `perPage` se acota a 500 (el máximo del wrapper) en vez de propagar el valor
   * del llamador: pedir 1000 aquí devolvería un 400 y el buscador del checkout se
   * quedaría vacío.
   */
  async buscarAgencias(filtros: BuscarAgenciasFiltros = {}): Promise<readonly ShalomAgencia[]> {
    const query: Record<string, string | number | boolean | undefined> = {
      q: filtros.texto,
      departamento: filtros.departamento,
      provincia: filtros.provincia,
      aereo: filtros.aereo,
      per_page: Math.min(filtros.perPage ?? 50, 500),
    };
    if (filtros.cerca !== undefined) {
      query.near = `${filtros.cerca.lat},${filtros.cerca.lng}`;
      query.radius_km = filtros.radioKm;
    }
    const raw = await this.peticion({
      metodo: "GET",
      ruta: "/v1/agencies/search",
      query,
      modo: "publico",
      reintentable: true,
    });
    const parsed = agenciasSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ShalomError("respuesta_invalida", 200, null, "respuesta de agencias inesperada");
    }
    // El wrapper usa `data` en unas rutas y `results` en otras; se aceptan ambas
    // para no acoplar el buscador del checkout a ese detalle.
    return parsed.data.data ?? parsed.data.results ?? [];
  }

  /**
   * La agencia más cercana a unas coordenadas.
   *
   * Con `near`, el wrapper ordena por cercanía y añade `distancia_km`, así que
   * basta el primer resultado: calcular distancias aquí sobre el catálogo completo
   * (~546 agencias) sería reimplementar lo que el servidor ya hizo.
   */
  async agenciaMasCercana(lat: number, lng: number, radioKm = 25): Promise<ShalomAgencia | null> {
    const agencias = await this.buscarAgencias({ cerca: { lat, lng }, radioKm, perPage: 5 });
    return agencias[0] ?? null;
  }

  /** Catálogo completo (~546 agencias). Para cachearlo y no consultar en cada checkout. */
  async catalogoAgencias(): Promise<readonly ShalomAgencia[]> {
    const raw = await this.peticion({
      metodo: "GET",
      ruta: "/v1/agencies",
      query: { per_page: 1000 },
      modo: "publico",
      reintentable: true,
      // Esta ruta no hace login, pero devuelve ~546 registros y no es
      // interactiva: se le da más margen que al buscador del checkout.
      timeoutMs: 30_000,
    });
    const parsed = agenciasSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ShalomError("respuesta_invalida", 200, null, "catálogo de agencias inesperado");
    }
    return parsed.data.data ?? parsed.data.results ?? [];
  }

  // -------------------------------------------------------------------------
  // Tarifas
  // -------------------------------------------------------------------------

  /**
   * Cotiza el flete entre dos terminales.
   *
   * La respuesta viene en SOLES DECIMALES (`"currency": "PEN"`, `20.15`) y aquí se
   * convierte a céntimos enteros con `solesACents`, que no pasa por coma flotante.
   * Es el único punto del módulo donde existen soles decimales; de aquí hacia
   * dentro todo es `Cents`.
   */
  async cotizarTarifa(request: CotizarTarifaRequest): Promise<TarifaCents> {
    const raw = await this.peticion({
      metodo: "POST",
      ruta: "/v1/tariff/calculate",
      cuerpo: {
        origin_terminal_id: request.terminalOrigenId,
        destiny_terminal_id: request.terminalDestinoId,
        ...(request.dimensiones !== undefined
          ? {
              dimensions: {
                weight_kg: request.dimensiones.pesoKg,
                height_m: request.dimensiones.altoM,
                length_m: request.dimensiones.largoM,
                width_m: request.dimensiones.anchoM,
              },
            }
          : {}),
        ...(request.productoId !== undefined ? { product_id: request.productoId } : {}),
      },
      modo: "cuenta",
      // Cotizar no crea nada: reintentar es seguro.
      reintentable: true,
    });
    const parsed = tarifaSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ShalomError("respuesta_invalida", 200, null, "respuesta de tarifas inesperada");
    }
    const desglose: Record<string, Cents> = {};
    for (const [medida, precio] of Object.entries(parsed.data.breakdown)) {
      if (typeof precio !== "number" && typeof precio !== "string") continue;
      desglose[medida] = solesACents(precio);
    }
    const producto = parsed.data.product ?? null;
    return {
      moneda: parsed.data.currency ?? "PEN",
      desglose,
      producto:
        producto === null
          ? null
          : {
              id: producto.id,
              titulo: producto.title ?? "",
              precioCents:
                producto.price === null || producto.price === undefined
                  ? 0
                  : solesACents(producto.price),
            },
    };
  }

  // -------------------------------------------------------------------------
  // Webhooks y suscripciones
  // -------------------------------------------------------------------------

  /**
   * Registra la URL del webhook y devuelve el `signing_secret`.
   *
   * OPERATIVA CRÍTICA, en este orden:
   * 1. La URL debe ser https pública y estar YA desplegada y respondiendo.
   * 2. Al registrar, Shalom manda un `webhook.ping` firmado con un `challenge`
   *    que el endpoint debe devolver en el body con un 2xx en ~5 s.
   * 3. Ese ping NO se reintenta. Si el endpoint no responde, el webhook queda
   *    deshabilitado y hay que registrarlo otra vez.
   * 4. El `signing_secret` se muestra UNA sola vez. Hay que guardarlo en el gestor
   *    de secretos antes de cerrar la terminal; no hay forma de recuperarlo.
   *
   * No se reintenta automáticamente: cada registro genera un secreto nuevo e
   * invalida el anterior, así que un reintento a ciegas dejaría el servidor
   * verificando firmas con una clave muerta.
   */
  async registrarWebhook(url: string): Promise<{ readonly signingSecret: string }> {
    if (!url.startsWith("https://")) {
      throw new ShalomError(
        "bad_request",
        null,
        null,
        "la URL del webhook debe ser https pública; Shalom rechaza http y localhost",
      );
    }
    const raw = await this.peticion({
      metodo: "PUT",
      ruta: "/v1/webhooks",
      cuerpo: { url },
      modo: "cuenta",
      reintentable: false,
    });
    const parsed = webhookSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ShalomError(
        "respuesta_invalida",
        200,
        null,
        "el registro del webhook no devolvió signing_secret: comprobar en el panel si quedó registrado antes de reintentar",
      );
    }
    return { signingSecret: parsed.data.signing_secret };
  }

  /**
   * Suscribe un envío a notificaciones.
   *
   * Hay un cupo de 50 suscripciones activas; al superarlo responde `429
   * quota_exceeded`. Los entregados se auto-desuscriben, así que el cupo se libera
   * solo, pero con más de 50 envíos en tránsito hay que caer al sondeo por lotes
   * (`consultarTrackingLote`) para los que no entren. Ese 429 NO se reintenta:
   * esperar no libera una plaza, hace falta que se entregue un paquete.
   */
  async suscribirEnvio(numero: string, codigo: string): Promise<SuscripcionResult> {
    try {
      const raw = await this.peticion({
        metodo: "POST",
        ruta: "/v1/tracking/subscriptions",
        cuerpo: { numero, codigo },
        modo: "cuenta",
        reintentable: false,
      });
      const parsed = suscripcionSchema.safeParse(raw);
      return { ok: true, id: parsed.success ? (parsed.data.id ?? null) : null };
    } catch (error) {
      const e = this.aShalomError(error);
      if (e.code === "rate_limited") {
        // Puede ser el cupo de suscripciones o el rate limit de la API key. Se
        // distingue por el mensaje porque el status HTTP es el mismo, y la
        // respuesta operativa es distinta: una se resuelve esperando, la otra no.
        const cupoAgotado = /quota/i.test(e.detalle);
        return {
          ok: false,
          cupoAgotado,
          motivo: cupoAgotado
            ? `cupo de ${MAX_SUSCRIPCIONES_ACTIVAS} suscripciones activas agotado: usar sondeo por lotes para este envío`
            : e.detalle,
        };
      }
      if (e.code === "conflict") {
        // Ya estaba suscrito: es el resultado deseado, no un fallo.
        return { ok: true, id: null };
      }
      throw e;
    }
  }

  // -------------------------------------------------------------------------
  // Emisión de guía
  // -------------------------------------------------------------------------

  /**
   * Crea una guía REAL Y COBRABLE en Shalom.
   *
   * NO HAY SANDBOX. NO HAY IDEMPOTENCIA DEL LADO DEL SERVIDOR. Cada llamada que
   * llega a Shalom genera una guía que se paga. De ahí las tres salvaguardas:
   *
   * 1. `confirmacionExplicita: true` obligatorio. Convierte un uso accidental (un
   *    `map` sobre pedidos, el reintento de un job) en un error de compilación en
   *    vez de en una factura.
   *
   * 2. `idempotencyGuard` obligatorio. Lo provee el llamador y debe consultar
   *    `GET /v1/orders` (o la tabla local de guías emitidas) para responder si ya
   *    existe una guía para este pedido. Se ejecuta ANTES de emitir y otra vez
   *    DESPUÉS de un fallo de resultado incierto: un timeout del cliente NO
   *    significa que la guía no se creó, y reintentar sin verificar duplica un
   *    cargo real. Es la única defensa que existe, porque el servidor no ofrece
   *    ninguna.
   *
   * 3. `reintentable: false` en la petición. Nunca reintenta sola, ni ante un 503.
   *    Si el guard encuentra la guía tras el fallo, la devuelve; si no, devuelve un
   *    error marcado para revisión humana.
   *
   * La clave de retiro se valida localmente antes de salir: Shalom rechaza los
   * repetidos y los consecutivos con un 422, y descubrirlo del lado del servidor
   * cuesta una llamada de hasta 150 s.
   */
  async emitirGuia(
    request: EmitirGuiaRequest,
    confirmacionExplicita: true,
    idempotencyGuard: IdempotencyGuard,
  ): Promise<EmitirGuiaResult> {
    if (confirmacionExplicita !== true) {
      // Defensa en runtime además de la del tipo: el llamador puede venir de una
      // ruta HTTP donde el tipo no lo comprobó nadie.
      return {
        ok: false,
        mensajeCliente: MENSAJE_CLIENTE.bad_request,
        mensajeTecnico:
          "emitirGuia requiere confirmacionExplicita === true: cada emisión crea una guía cobrable y no hay sandbox",
        reintentable: false,
        requiereRevisionManual: false,
      };
    }

    const validacion = isValidPickupCode(request.claveRetiro);
    if (!validacion.valido) {
      return {
        ok: false,
        mensajeCliente: "La clave de retiro no es válida.",
        mensajeTecnico: `clave de retiro rechazada localmente: ${validacion.motivo ?? ""}`,
        reintentable: false,
        requiereRevisionManual: false,
      };
    }

    // Verificación previa: si ya hay guía para este pedido, no se emite otra.
    //
    // El guard puede fallar (la tabla local no responde, el listado de órdenes da
    // un 502). Si se dejara propagar, esta función rompería su contrato —los
    // fallos viajan como dato, no como excepción— y el panel recibiría un 500 en
    // vez de un texto en español. Y sobre todo: NO se emite. Sin poder comprobar
    // si ya existe una guía, emitir a ciegas es justo lo que duplica un cargo real.
    let existente: GuiaEmitida | null;
    try {
      existente = await idempotencyGuard();
    } catch (errorGuard) {
      return {
        ok: false,
        mensajeCliente: MENSAJE_CLIENTE.internal,
        mensajeTecnico: this.redactado(
          `no se pudo comprobar si el pedido ya tenía guía: ${
            errorGuard instanceof Error ? errorGuard.message : String(errorGuard)
          }. NO SE EMITIÓ nada; reintentar cuando la comprobación funcione.`,
        ),
        // Es seguro reintentar: no llegó a llamarse a Shalom.
        reintentable: true,
        requiereRevisionManual: false,
      };
    }
    if (existente !== null) {
      this.logger?.info("Shalom: ya existía una guía para este pedido; no se emite otra");
      return { ok: true, guia: existente };
    }

    try {
      const raw = await this.peticion({
        metodo: "POST",
        ruta: "/v1/orders",
        cuerpo: {
          origin_terminal_id: request.terminalOrigenId,
          destiny_terminal_id: request.terminalDestinoId,
          product_id: request.productoId,
          receiver: {
            document_type: request.destinatario.tipoDocumento,
            document: request.destinatario.documento,
            name: request.destinatario.nombre,
            ...(request.destinatario.apellidoPaterno !== undefined
              ? { last_name: request.destinatario.apellidoPaterno }
              : {}),
            ...(request.destinatario.apellidoMaterno !== undefined
              ? { sur_name: request.destinatario.apellidoMaterno }
              : {}),
            ...(request.destinatario.telefono !== undefined
              ? { phone: request.destinatario.telefono }
              : {}),
          },
          pickup_code: request.claveRetiro,
          // Obligatoria: sin ella Shalom rechaza con 422.
          declaracion_jurada: request.declaracionJurada,
          ...(request.cantidad !== undefined ? { quantity: request.cantidad } : {}),
          ...(request.pagador !== undefined ? { payer: request.pagador } : {}),
          ...(request.dimensiones !== undefined
            ? {
                dimensions: {
                  weight_kg: request.dimensiones.pesoKg,
                  height_m: request.dimensiones.altoM,
                  length_m: request.dimensiones.largoM,
                  width_m: request.dimensiones.anchoM,
                },
              }
            : {}),
          ...(request.aereo !== undefined ? { aereo: request.aereo } : {}),
          ...(request.rastrear !== undefined ? { track: request.rastrear } : {}),
        },
        modo: "cuenta",
        // NUNCA reintentar. Ver la cabecera de este método.
        reintentable: false,
      });
      const parsed = guiaSchema.safeParse(raw);
      if (!parsed.success) {
        // Un 2xx que no entendemos es peor que un error: la guía probablemente se
        // creó y no sabemos su número. Exige revisión humana inmediata.
        return {
          ok: false,
          mensajeCliente: MENSAJE_CLIENTE.respuesta_invalida,
          mensajeTecnico:
            "Shalom aceptó la emisión pero la respuesta no trae guia/serie/codigo/ose_id: la guía pudo crearse, verificar en GET /v1/orders antes de reemitir",
          reintentable: false,
          requiereRevisionManual: true,
        };
      }
      return {
        ok: true,
        guia: {
          guia: parsed.data.guia,
          serie: parsed.data.serie,
          codigo: parsed.data.codigo,
          oseId: parsed.data.ose_id,
        },
      };
    } catch (error) {
      const e = this.aShalomError(error);

      if (e.resultadoIncierto) {
        // Aquí está el riesgo económico del módulo: no sabemos si la guía se creó.
        // Se vuelve a consultar antes de dar cualquier respuesta.
        this.logger?.warn(
          `Shalom: emisión con resultado incierto (${e.code}); verificando si la guía se creó antes de decidir`,
        );
        let verificada: GuiaEmitida | null = null;
        try {
          verificada = await idempotencyGuard();
        } catch (errorGuard) {
          // Si el guard también falla, no queda información con la que decidir.
          return {
            ok: false,
            mensajeCliente: e.mensajeCliente,
            mensajeTecnico: this.redactado(
              `${e.message}; además falló la verificación de idempotencia: ${
                errorGuard instanceof Error ? errorGuard.message : String(errorGuard)
              }. NO REEMITIR sin comprobar GET /v1/orders a mano.`,
            ),
            reintentable: false,
            requiereRevisionManual: true,
          };
        }
        if (verificada !== null) {
          this.logger?.warn(
            "Shalom: la guía SÍ se había creado a pesar del fallo; se usa la existente en lugar de reemitir",
          );
          return { ok: true, guia: verificada };
        }
        return {
          ok: false,
          mensajeCliente: e.mensajeCliente,
          mensajeTecnico: this.redactado(
            `${e.message}. Verificado: la guía no aparece. Es seguro reemitir, pero debe hacerlo un humano.`,
          ),
          // `false` a propósito aunque la verificación saliera limpia: el listado de
          // órdenes puede tardar en reflejar una guía recién creada, y un reintento
          // automático dentro de esa ventana duplicaría el cargo.
          reintentable: false,
          requiereRevisionManual: true,
        };
      }

      // Rechazo determinista (422, 400): no se creó nada. Se puede corregir y
      // volver a intentar sin riesgo de duplicar.
      return {
        ok: false,
        mensajeCliente: e.mensajeCliente,
        mensajeTecnico: this.redactado(
          e.requestId === null ? e.message : `${e.message} [request_id ${e.requestId}]`,
        ),
        reintentable: false,
        requiereRevisionManual: e.code === "upstream_rejected" || e.code === "conflict",
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Tipos auxiliares del cliente
// ---------------------------------------------------------------------------

export type SuscripcionResult =
  | { readonly ok: true; readonly id: string | null }
  | { readonly ok: false; readonly cupoAgotado: boolean; readonly motivo: string };

export type ShalomBatchRequestItem = {
  /** Referencia interna (normalmente el id del pedido). El wrapper la hace eco. */
  readonly customId?: string;
  readonly ref: TrackingRef;
};

export type ShalomBatchResultado = {
  readonly customId: string | null;
  readonly ok: boolean;
  readonly tracking: TrackingState | null;
  readonly error: { readonly code: string; readonly message: string } | null;
};

export type BuscarAgenciasFiltros = {
  readonly texto?: string;
  readonly departamento?: string;
  readonly provincia?: string;
  readonly aereo?: boolean;
  readonly cerca?: { readonly lat: number; readonly lng: number };
  readonly radioKm?: number;
  readonly perPage?: number;
};

export type CotizarTarifaRequest = {
  readonly terminalOrigenId: string;
  readonly terminalDestinoId: string;
  readonly dimensiones?: PackageDimensions;
  readonly productoId?: string;
};

/**
 * Comprueba si ya existe una guía para el pedido que se está a punto de emitir.
 *
 * Es responsabilidad del llamador porque solo él sabe cómo casar un pedido con
 * una guía: por la tabla local de envíos, por el `custom_id`, o listando
 * `GET /v1/orders` y comparando destinatario y fecha. El cliente no puede
 * adivinarlo, y por eso lo exige en vez de inventar una heurística.
 *
 * Debe devolver `null` solo si está SEGURO de que no existe. Ante la duda es
 * mejor devolver la guía candidata: no emitir un envío se arregla con una
 * llamada, emitir dos cuesta dinero y confunde al cliente con dos códigos.
 */
export type IdempotencyGuard = () => Promise<GuiaEmitida | null>;

/**
 * Trocea en grupos de tamaño fijo. Se implementa aquí y no en un helper genérico
 * porque su única razón de ser es el límite duro de 50 del batch.
 */
export function trocear<T>(items: readonly T[], tamano: number): readonly (readonly T[])[] {
  if (tamano < 1) throw new Error("el tamaño del grupo debe ser >= 1");
  const grupos: T[][] = [];
  for (let i = 0; i < items.length; i += tamano) {
    grupos.push(items.slice(i, i + tamano));
  }
  return grupos;
}
