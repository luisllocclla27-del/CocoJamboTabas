/**
 * Clave de retiro de 4 dígitos que Shalom pide al crear la guía.
 *
 * QUÉ ES: la credencial física con la que el destinatario retira el paquete en
 * el mostrador de la agencia. Quien la sepa y sepa el número de guía puede
 * llevarse la mercadería.
 *
 * POR QUÉ ES ALEATORIA Y NO DERIVADA DEL PEDIDO: la tentación es usar los
 * últimos 4 dígitos de la referencia (`COCO-7F3K2M`), del número de pedido o del
 * DNI del cliente, porque así el admin la puede reconstruir si la pierde. Sería
 * un error de seguridad: la referencia del pedido viaja en la URL de
 * seguimiento, en el correo y en el WhatsApp, y el DNI aparece en la boleta. Una
 * clave deducible de datos que circulan por canales que no controlamos equivale
 * a no tener clave. Se genera con CSPRNG, se guarda cifrada junto al envío y se
 * comunica al cliente por el mismo canal que el resto de datos de entrega.
 *
 * RESTRICCIÓN DE SHALOM: rechaza claves con los 4 dígitos repetidos (`1111`) y
 * secuencias consecutivas ascendentes o descendentes (`1234`, `4321`). No es una
 * regla nuestra: si se manda una así, `POST /v1/orders` responde 422 y la guía no
 * se crea. Como no hay sandbox donde descubrirlo, la validación tiene que ser
 * local y estar testeada.
 */

/** Cantidad de dígitos que exige Shalom. */
export const LONGITUD_CLAVE_RETIRO = 4;

export type ValidacionClave = { readonly valido: boolean; readonly motivo?: string };

/**
 * ¿Son los 4 dígitos el mismo? (`0000`, `7777`)
 */
function todosRepetidos(digitos: readonly number[]): boolean {
  return digitos.every((d) => d === digitos[0]);
}

/**
 * ¿Es una secuencia consecutiva? Cubre ascendente (`1234`) y descendente
 * (`9876`).
 *
 * No se considera consecutivo el envolvente `9012`: Shalom no lo rechaza y
 * excluirlo reduciría el espacio de claves sin ganar nada.
 */
function esConsecutiva(digitos: readonly number[]): boolean {
  const paso = digitos[1] - digitos[0];
  if (paso !== 1 && paso !== -1) return false;
  for (let i = 2; i < digitos.length; i++) {
    if (digitos[i] - digitos[i - 1] !== paso) return false;
  }
  return true;
}

export function isValidPickupCode(code: string): ValidacionClave {
  if (typeof code !== "string" || code.length !== LONGITUD_CLAVE_RETIRO) {
    return {
      valido: false,
      motivo: `La clave de retiro debe tener exactamente ${LONGITUD_CLAVE_RETIRO} dígitos.`,
    };
  }
  if (!/^\d{4}$/.test(code)) {
    // Se exige el patrón completo en vez de `Number.isInteger` porque `" 12"` y
    // `"1e3"` pasarían una conversión numérica y llegarían mal a Shalom.
    return { valido: false, motivo: "La clave de retiro solo puede contener dígitos del 0 al 9." };
  }
  const digitos = [...code].map(Number);
  if (todosRepetidos(digitos)) {
    return { valido: false, motivo: "Shalom no acepta claves con los cuatro dígitos iguales." };
  }
  if (esConsecutiva(digitos)) {
    return {
      valido: false,
      motivo: "Shalom no acepta claves con dígitos consecutivos, ni ascendentes ni descendentes.",
    };
  }
  return { valido: true };
}

/**
 * Fuente de aleatoriedad. Inyectable solo para poder testear el rechazo de
 * candidatos inválidos de forma determinista; en producción es siempre el CSPRNG
 * de la plataforma.
 */
export type RandomBytes = (buffer: Uint8Array) => void;

function randomPorDefecto(buffer: Uint8Array): void {
  // `crypto.getRandomValues` y no `Math.random`: `Math.random` es un PRNG
  // predecible a partir de unas pocas salidas, y esto es una credencial de
  // retiro. Está disponible como global tanto en Node 18+ como en el runtime
  // Edge de Next, así que no hace falta importar `node:crypto`.
  crypto.getRandomValues(buffer);
}

/**
 * Un dígito uniforme en 0..9 sin sesgo de módulo.
 *
 * `byte % 10` sesgaría: 256 no es múltiplo de 10, así que los dígitos 0..5
 * saldrían con probabilidad 26/256 y los 6..9 con 25/256. Se descartan los bytes
 * a partir de 250 (rechazo por muestreo) para que el reparto sea exacto. El
 * sesgo sería pequeño, pero corregirlo cuesta cuatro líneas y esto es una
 * credencial.
 */
function digitoUniforme(random: RandomBytes): number {
  const buffer = new Uint8Array(1);
  for (;;) {
    random(buffer);
    const byte = buffer[0];
    if (byte < 250) return byte % 10;
  }
}

/**
 * Genera una clave válida.
 *
 * Reintenta hasta dar con una que pase `isValidPickupCode`. Los candidatos
 * inválidos son 10 repetidos + 14 consecutivos = 24 de 10 000 (0.24%), así que
 * el bucle termina en el primer intento salvo casualidad. El límite duro existe
 * solo para que una fuente de aleatoriedad rota (un `random` inyectado que
 * devuelva siempre lo mismo) falle ruidosamente en vez de colgar el proceso.
 */
export function generatePickupCode(random: RandomBytes = randomPorDefecto): string {
  for (let intento = 0; intento < 100; intento++) {
    let code = "";
    for (let i = 0; i < LONGITUD_CLAVE_RETIRO; i++) code += String(digitoUniforme(random));
    if (isValidPickupCode(code).valido) return code;
  }
  throw new Error(
    "no se pudo generar una clave de retiro válida en 100 intentos: la fuente de aleatoriedad no es aleatoria",
  );
}

/**
 * Texto para el WhatsApp de confirmación.
 *
 * Vive aquí y no en la capa de mensajería porque el aviso de no compartirla es
 * parte de la seguridad de la clave, no de la redacción del mensaje.
 */
export function instruccionesRetiro(code: string, agencia: string): string {
  return [
    `Tu clave de retiro es ${code}.`,
    `Presenta tu DNI y esta clave en la agencia Shalom de ${agencia}.`,
    "No la compartas con nadie: cualquiera con esta clave puede recoger tu pedido.",
  ].join(" ");
}
