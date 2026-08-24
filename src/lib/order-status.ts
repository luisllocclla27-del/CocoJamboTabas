/**
 * Máquina de estados del pedido.
 *
 * Está duplicada a propósito: esta copia en TypeScript da errores tempranos y
 * habilita la UI (qué botones mostrar), y la copia en
 * `supabase/migrations/0003_functions.sql` es la que realmente manda. Si sólo
 * viviera aquí, cualquier escritura directa a la base o un bug en una ruta
 * nueva podría dejar un pedido en un estado imposible.
 *
 * La regla al tocarla: si cambia una transición, cambia en los dos lados y se
 * actualiza el test que compara ambas listas.
 */

export const ORDER_STATUSES = [
  "pendiente_pago",
  "comprobante_enviado",
  "verificado",
  "rechazado",
  "preparando",
  "enviado",
  "entregado",
  "cancelado",
  "expirado",
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Transiciones permitidas. Debe coincidir con `transition_order_status` en SQL. */
export const TRANSICIONES: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  pendiente_pago: ["comprobante_enviado", "preparando", "expirado", "cancelado"],
  comprobante_enviado: ["verificado", "rechazado"],
  verificado: ["preparando", "cancelado"],
  rechazado: ["pendiente_pago", "cancelado"],
  preparando: ["enviado", "cancelado"],
  enviado: ["entregado"],
  entregado: [],
  cancelado: [],
  expirado: [],
};

/** Estados sin salida: el pedido terminó su ciclo. */
export const ESTADOS_TERMINALES: readonly OrderStatus[] = ORDER_STATUSES.filter(
  (s) => TRANSICIONES[s].length === 0,
);

export function isTerminal(status: OrderStatus): boolean {
  return TRANSICIONES[status].length === 0;
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSICIONES[from].includes(to);
}

export function nextStatuses(from: OrderStatus): readonly OrderStatus[] {
  return TRANSICIONES[from];
}

export class InvalidTransitionError extends Error {
  readonly code = "INVALID_TRANSITION";
  constructor(
    readonly from: OrderStatus,
    readonly to: OrderStatus,
  ) {
    super(`transición inválida: ${from} → ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

/**
 * ¿Este estado mantiene el par apartado del stock disponible?
 *
 * `comprobante_enviado` cuenta: mientras el admin revisa el voucher, la talla no
 * puede revenderse. Es la razón por la que las reservas no expiran en ese
 * estado.
 */
export function reservaStock(status: OrderStatus): boolean {
  return status === "pendiente_pago" || status === "comprobante_enviado" || status === "verificado";
}

/** Etiquetas para el cliente. Deliberadamente menos técnicas que el enum. */
export const ETIQUETA_CLIENTE: Readonly<Record<OrderStatus, string>> = {
  pendiente_pago: "Esperando tu pago",
  comprobante_enviado: "Validando tu pago",
  verificado: "Pago confirmado",
  rechazado: "Pago no validado",
  preparando: "Preparando tu pedido",
  enviado: "En camino",
  entregado: "Entregado",
  cancelado: "Cancelado",
  expirado: "Expirado",
};

/** Etiquetas para el panel de administración. */
export const ETIQUETA_ADMIN: Readonly<Record<OrderStatus, string>> = {
  pendiente_pago: "Pendiente de pago",
  comprobante_enviado: "Por verificar",
  verificado: "Verificado",
  rechazado: "Rechazado",
  preparando: "Preparando",
  enviado: "Enviado",
  entregado: "Entregado",
  cancelado: "Cancelado",
  expirado: "Expirado",
};

/** Orden de avance para pintar la línea de tiempo del cliente. */
export const LINEA_TIEMPO: readonly OrderStatus[] = [
  "pendiente_pago",
  "comprobante_enviado",
  "verificado",
  "preparando",
  "enviado",
  "entregado",
];
