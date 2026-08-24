/**
 * Firma HMAC de las peticiones y notificaciones de Tupay.
 *
 * Tupay firma así:
 *
 *   Authorization: "TUPAY " + HMAC_SHA256_hex(X-Date + X-Login + JSONPayload)
 *
 * con la API Signature como clave. Tres detalles son la causa de casi todos los
 * `102 INVALID_SIGNATURE` y por eso este módulo está aislado y testeado:
 *
 * 1. El payload se pasa **ya serializado**, como string. Si se serializara dos
 *    veces (una para firmar y otra para enviar) el orden de claves o el escapado
 *    podrían diferir entre las dos llamadas a `JSON.stringify`, y la firma no
 *    cuadraría con los bytes que viajan. La regla: serializar una vez, firmar
 *    ese string, enviar ese mismo string como body.
 * 2. Todo se concatena en UTF-8. Con nombres peruanos acentuados ("Muñoz"), un
 *    HMAC calculado sobre latin1 daría bytes distintos.
 * 3. `X-Date` tiene que ser exactamente el mismo valor en la cabecera y en la
 *    cadena firmada. Formatearlo dos veces con un `new Date()` distinto puede
 *    cambiar el segundo y romper la firma de forma intermitente.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Prefijo que Tupay exige en la cabecera `Authorization`. */
export const TUPAY_AUTH_PREFIX = "TUPAY ";

/** Ventana anti-replay por defecto, en segundos. */
export const VENTANA_DEFECTO_SEGUNDOS = 300;

export type TupaySignatureInput = {
  /** Valor exacto de la cabecera `X-Date`. */
  readonly xDate: string;
  /** API Key (cabecera `X-Login`). */
  readonly xLogin: string;
  /** Body JSON ya serializado, byte a byte igual al que se enviará. */
  readonly payload: string;
  /** API Signature. Nunca se loguea. */
  readonly secret: string;
};

/**
 * HMAC-SHA256 en hex minúsculas de `xDate + xLogin + payload`.
 *
 * No acepta un objeto para el payload a propósito: recibir un objeto obligaría
 * a serializar aquí y el llamador tendría que volver a serializar para enviar,
 * que es exactamente el bug que este diseño evita.
 */
export function computeTupaySignature({
  xDate,
  xLogin,
  payload,
  secret,
}: TupaySignatureInput): string {
  if (secret.length === 0) {
    // Un HMAC con clave vacía es válido criptográficamente pero aquí sólo puede
    // significar que la variable de entorno no se cargó, y el error resultante
    // (102 desde Tupay) sería mucho más difícil de diagnosticar.
    throw new Error("API Signature de Tupay vacía: revisar TUPAY_API_SECRET");
  }
  return createHmac("sha256", Buffer.from(secret, "utf8"))
    .update(Buffer.from(xDate + xLogin + payload, "utf8"))
    .digest("hex");
}

/** Cabecera `Authorization` completa, con el prefijo que exige Tupay. */
export function buildAuthorizationHeader(input: TupaySignatureInput): string {
  return TUPAY_AUTH_PREFIX + computeTupaySignature(input);
}

/**
 * Quita el prefijo `TUPAY ` si viene, y normaliza a minúsculas.
 *
 * Las notificaciones entrantes se han observado tanto con prefijo como sin él,
 * y con hex en mayúsculas; rechazar por eso sería descartar pagos legítimos.
 */
export function normalizeSignatureHeader(header: string): string {
  const sinEspacios = header.trim();
  const sinPrefijo = sinEspacios.toUpperCase().startsWith(TUPAY_AUTH_PREFIX.trim().toUpperCase())
    ? sinEspacios.slice(TUPAY_AUTH_PREFIX.length - 1).trim()
    : sinEspacios;
  return sinPrefijo.toLowerCase();
}

export type TupayVerifyInput = TupaySignatureInput & {
  /** Cabecera `Authorization` recibida, con o sin el prefijo `TUPAY `. */
  readonly signatureHeader: string;
};

/**
 * Verifica una firma en tiempo constante.
 *
 * `timingSafeEqual` lanza si los buffers tienen longitudes distintas, y una
 * firma truncada es justo lo que enviaría alguien probando: por eso se comparan
 * las longitudes antes y se devuelve `false` en vez de propagar la excepción.
 * Comparar longitudes no filtra nada útil (la longitud del HMAC es pública y
 * fija), pero comparar el contenido con `===` sí filtraría, byte a byte, cuánto
 * prefijo se acertó.
 */
export function verifyTupaySignature({
  signatureHeader,
  xDate,
  xLogin,
  payload,
  secret,
}: TupayVerifyInput): boolean {
  let esperada: string;
  try {
    esperada = computeTupaySignature({ xDate, xLogin, payload, secret });
  } catch {
    // Sin secret no hay verificación posible: se trata como firma inválida en
    // lugar de tumbar el endpoint de notificaciones con un 500.
    return false;
  }
  const recibida = normalizeSignatureHeader(signatureHeader);
  const a = Buffer.from(esperada, "utf8");
  const b = Buffer.from(recibida, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function dosDigitos(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * `yyyy-MM-ddTHH:mm:ssZ` en UTC, el formato que Tupay valida.
 *
 * No se usa `toISOString()` porque incluye milisegundos
 * (`2026-08-19T10:00:00.000Z`) y Tupay rechaza el formato. Tampoco se recorta
 * con `slice`, que funcionaría pero deja el motivo invisible para quien lo lea
 * después.
 */
export function formatTupayDate(date: Date): string {
  if (Number.isNaN(date.getTime())) {
    throw new Error("fecha inválida al construir X-Date");
  }
  return (
    `${date.getUTCFullYear()}-${dosDigitos(date.getUTCMonth() + 1)}-${dosDigitos(date.getUTCDate())}` +
    `T${dosDigitos(date.getUTCHours())}:${dosDigitos(date.getUTCMinutes())}:${dosDigitos(date.getUTCSeconds())}Z`
  );
}

/** Parsea un `X-Date` de Tupay. Devuelve `null` si no tiene el formato exigido. */
export function parseTupayDate(xDate: string): Date | null {
  // Se exige el formato completo en lugar de delegar en `new Date()`, que acepta
  // cosas como "2026" y produciría una ventana temporal que pasa por accidente.
  const texto = xDate.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:?\d{2})$/.test(texto)) return null;
  const t = Date.parse(texto);
  return Number.isNaN(t) ? null : new Date(t);
}

/**
 * Anti-replay: ¿el `X-Date` está dentro de la ventana alrededor de `ahora`?
 *
 * Se rechaza tanto el pasado como el futuro. El pasado evita que alguien reenvíe
 * una notificación capturada; el futuro evita que una firma con fecha adelantada
 * quede válida durante horas. La ventana simétrica de 5 minutos absorbe el
 * desfase de reloj razonable entre servidores.
 */
export function isWithinDateWindow(
  xDate: string,
  ahora: Date,
  ventanaSegundos: number = VENTANA_DEFECTO_SEGUNDOS,
): boolean {
  const fecha = parseTupayDate(xDate);
  if (fecha === null) return false;
  const deltaSegundos = Math.abs(ahora.getTime() - fecha.getTime()) / 1000;
  return deltaSegundos <= ventanaSegundos;
}
