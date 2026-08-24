/**
 * Referencia pública del pedido (`COCO-7F3K2M`).
 *
 * Esta cadena es la única credencial de la página de seguimiento, así que su
 * entropía es una decisión de seguridad, no estética. Un `COCO-0001`
 * autoincremental permitiría a cualquiera recorrer los pedidos del negocio.
 *
 * Usamos 6 caracteres de un alfabeto de consonantes y dígitos, sin `0/O` ni
 * `1/I/L` (no se confunden al dictarlas por WhatsApp) y sin vocales (no se
 * forman palabras ofensivas por accidente): 28^6 = ~482 millones de
 * combinaciones. Con 10 000 pedidos vivos, la probabilidad de acertar uno a
 * ciegas es ~1 en 48 000 por intento, y el endpoint de seguimiento va con rate
 * limit.
 */

const ALFABETO = "23456789BCDFGHJKMNPQRSTVWXYZ";
const LONGITUD = 6;
const PREFIJO = "COCO";

export const REFERENCE_REGEX = new RegExp(`^${PREFIJO}-[${ALFABETO}]{${LONGITUD}}$`);

function randomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

export function generateReference(): string {
  // Rechazo de módulo: descartamos los bytes que sesgarían el reparto.
  const limite = Math.floor(256 / ALFABETO.length) * ALFABETO.length;
  let salida = "";
  while (salida.length < LONGITUD) {
    for (const byte of randomBytes(LONGITUD * 2)) {
      if (byte >= limite) continue;
      salida += ALFABETO[byte % ALFABETO.length];
      if (salida.length === LONGITUD) break;
    }
  }
  return `${PREFIJO}-${salida}`;
}

export function isValidReference(value: string): boolean {
  return REFERENCE_REGEX.test(value);
}

/**
 * Normaliza lo que el cliente escribe en el buscador de seguimiento:
 * minúsculas, espacios, prefijo olvidado.
 */
export function normalizeReference(input: string): string | null {
  const limpio = input.trim().toUpperCase().replace(/\s+/g, "");
  const conPrefijo = limpio.startsWith(`${PREFIJO}-`)
    ? limpio
    : limpio.startsWith(PREFIJO)
      ? `${PREFIJO}-${limpio.slice(PREFIJO.length)}`
      : `${PREFIJO}-${limpio}`;
  return isValidReference(conPrefijo) ? conPrefijo : null;
}
