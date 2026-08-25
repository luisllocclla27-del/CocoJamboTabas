/**
 * Constantes y esquemas del inventario.
 *
 * Vive aparte de `inventory.ts` porque un módulo con `"use server"` solo puede
 * exportar funciones asíncronas: un `export const` ahí rompe el build con un error
 * que no señala la causa. Es el mismo motivo por el que existe `orders/config.ts`.
 */

/**
 * Motivos de movimiento que el panel puede originar.
 *
 * Coinciden con el `check` de `inventory_moves.motivo` en
 * `0007_product_media.sql`, menos `venta` y `alta_producto`, que no las escribe un
 * humano desde esta pantalla. Si se añade uno aquí hay que añadirlo también al
 * check, o el insert falla con 23514.
 */
export const MOTIVOS_STOCK = ["ajuste_manual", "recepcion", "merma", "devolucion"] as const;

export type MotivoStock = (typeof MOTIVOS_STOCK)[number];

/** Etiquetas para el selector del panel. */
export const ETIQUETA_MOTIVO: Readonly<Record<MotivoStock, string>> = {
  ajuste_manual: "Ajuste manual",
  recepcion: "Llegó mercadería",
  merma: "Pérdida o daño",
  devolucion: "Devolución de un cliente",
};

/** Tope de stock por talla. Un dedo pegado al teclado no debe dejar 99999 pares. */
export const MAX_STOCK_VARIANTE = 999;
