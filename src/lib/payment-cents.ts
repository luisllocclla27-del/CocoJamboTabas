/**
 * Céntimos únicos: el monto identifica el pago.
 *
 * El problema del Yape manual es el matching. Lo habitual es pedirle al cliente
 * que escriba un código de referencia en el mensaje del Yape, pero la mitad no
 * lo hace, y el admin queda con un voucher suelto que no sabe a qué pedido
 * corresponde.
 *
 * La solución: en vez de cobrar S/ 249.00, cobramos S/ 249.37. Los céntimos se
 * asignan por pedido y son únicos entre los pedidos que están esperando pago,
 * así que **el monto exacto del Yape apunta a un solo pedido**. El cliente no
 * tiene que copiar nada: solo pagar el monto que ve en pantalla.
 *
 * Reglas de diseño:
 *
 * 1. Los céntimos SUSTITUYEN los del importe, no se suman. Si sumáramos, el
 *    total dependería del carrito y dos pedidos podrían caer en el mismo valor.
 * 2. El total resultante nunca puede quedar por debajo del importe real, o
 *    estaríamos regalando plata. Si al sustituir bajaría, subimos un sol.
 * 3. Solo hay 100 valores posibles, así que el espacio se agota: con 100 pedidos
 *    esperando pago simultáneamente no hay céntimo libre. La unicidad la
 *    garantiza un índice parcial en Postgres, y aquí solo elegimos candidatos.
 *    Ese límite es aceptable para el volumen de una tienda pequeña y está
 *    documentado como el punto donde este mecanismo debe reemplazarse por la
 *    pasarela automática.
 * 4. Evitamos el 00 como céntimo asignado: un total redondo es indistinguible
 *    de un pago sin identificar.
 */

import type { Cents } from "./money";

/** Cuántos pedidos pueden esperar pago a la vez con este mecanismo. */
export const MAX_PEDIDOS_CONCURRENTES = 99;

const SOL = 100;

export type PaymentAmount = {
  /** Importe real del pedido, sin tocar. */
  baseCents: Cents;
  /** Céntimos identificadores asignados, 1..99. */
  paymentCents: number;
  /** Total que el cliente debe yapear. Siempre >= baseCents. */
  totalCents: Cents;
};

/**
 * Aplica unos céntimos identificadores a un importe.
 * @throws si los céntimos están fuera de 1..99.
 */
export function applyPaymentCents(baseCents: Cents, paymentCents: number): PaymentAmount {
  if (!Number.isInteger(paymentCents) || paymentCents < 1 || paymentCents > 99) {
    throw new Error(`céntimos identificadores fuera de rango: ${paymentCents}`);
  }
  const soles = Math.floor(baseCents / SOL);
  const candidato = soles * SOL + paymentCents;
  // Regla 2: nunca cobrar menos que el importe real.
  const totalCents = candidato >= baseCents ? candidato : candidato + SOL;
  return { baseCents, paymentCents, totalCents };
}

/**
 * Elige unos céntimos libres. `ocupados` son los céntimos de los pedidos que
 * ahora mismo esperan pago; el llamador los lee de la base.
 *
 * Elige al azar entre los libres en vez de tomar el menor disponible: un
 * contador secuencial dejaría adivinar cuántos pedidos hay y el orden en que
 * entraron.
 *
 * @throws si no queda ningún céntimo libre. El llamador debe traducirlo a un
 * mensaje pidiendo reintentar en unos minutos, no a un error 500.
 */
export function pickPaymentCents(ocupados: readonly number[]): number {
  const tomados = new Set(ocupados);
  const libres: number[] = [];
  for (let c = 1; c <= 99; c++) {
    if (!tomados.has(c)) libres.push(c);
  }
  if (libres.length === 0) {
    throw new NoPaymentCentsAvailableError();
  }
  const bytes = new Uint32Array(1);
  globalThis.crypto.getRandomValues(bytes);
  return libres[bytes[0] % libres.length];
}

export class NoPaymentCentsAvailableError extends Error {
  readonly code = "NO_PAYMENT_CENTS_AVAILABLE";
  constructor() {
    super(
      "No hay céntimos identificadores libres: demasiados pedidos esperando pago. Reintentar en unos minutos.",
    );
    this.name = "NoPaymentCentsAvailableError";
  }
}

/**
 * ¿El monto que dice el voucher coincide con el que esperábamos?
 *
 * Exigimos coincidencia exacta. Una tolerancia arruinaría el mecanismo: si
 * aceptamos ±5 céntimos, un pago podría casar con varios pedidos y volvemos al
 * problema que vinimos a resolver.
 */
export function matchesExpectedAmount(esperadoCents: Cents, vouchercents: Cents): boolean {
  return esperadoCents === vouchercents;
}

/**
 * Busca a qué pedido pertenece un monto leído de un voucher.
 * Devuelve todos los candidatos: si hay más de uno, el índice único de la base
 * falló o el pedido ya cambió de estado, y eso exige revisión humana.
 */
export function findOrdersByAmount<T extends { totalCents: Cents }>(
  pedidos: readonly T[],
  vouchercents: Cents,
): T[] {
  return pedidos.filter((p) => matchesExpectedAmount(p.totalCents, vouchercents));
}
