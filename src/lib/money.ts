/**
 * Dinero en céntimos, siempre.
 *
 * Nunca usamos coma flotante para dinero: `0.1 + 0.2 !== 0.3` en IEEE 754 y en
 * un checkout eso termina en descalces de un céntimo que rompen la conciliación
 * contra la pasarela. Todo importe viaja como `integer` de céntimos, de la base
 * de datos hasta la UI, y solo se formatea al renderizar.
 */

export type Cents = number;

const SOL = 100;

export function isValidCents(value: unknown): value is Cents {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function assertCents(value: unknown, campo = "monto"): Cents {
  if (!isValidCents(value)) {
    throw new Error(
      `${campo} inválido: se esperaba un entero de céntimos >= 0, se recibió ${String(value)}`,
    );
  }
  return value;
}

/** Formatea céntimos como soles peruanos. 24937 -> "S/ 249.37" */
export function formatSoles(cents: Cents): string {
  const negativo = cents < 0;
  const abs = Math.abs(cents);
  const soles = Math.floor(abs / SOL);
  const centimos = abs % SOL;
  const texto = `S/ ${soles.toLocaleString("es-PE")}.${String(centimos).padStart(2, "0")}`;
  return negativo ? `-${texto}` : texto;
}

/** Solo la parte de céntimos, para resaltarla en la pantalla de pago. */
export function splitSoles(cents: Cents): { soles: string; centimos: string } {
  const abs = Math.abs(cents);
  return {
    soles: Math.floor(abs / SOL).toLocaleString("es-PE"),
    centimos: String(abs % SOL).padStart(2, "0"),
  };
}

/** Convierte soles (número humano) a céntimos. Solo para seeds y entrada de admin. */
export function solesToCents(soles: number): Cents {
  // `soles * 100` arrastra error binario: 1.005 * 100 === 100.49999999999999, que
  // redondearía a 100 en vez de 101. Normalizamos en decimal antes de redondear.
  return Math.round(Number((soles * SOL).toFixed(4)));
}

/**
 * Porcentaje sobre céntimos, redondeando al céntimo más cercano.
 * Se usa para el descuento por pago directo con Yape.
 */
export function percentOf(cents: Cents, percent: number): Cents {
  return Math.round((cents * percent) / 100);
}

/** Margen de ganancia en céntimos y en porcentaje sobre el precio de venta. */
export function margin(priceCents: Cents, costCents: Cents) {
  const gananciaCents = priceCents - costCents;
  const porcentaje = priceCents === 0 ? 0 : (gananciaCents / priceCents) * 100;
  return { gananciaCents, porcentaje };
}
