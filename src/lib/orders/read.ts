/**
 * Lectura de pedidos para las pantallas de pago y seguimiento.
 *
 * Va con la service_role key, y eso exige justificación porque salta la RLS: el
 * comprador es anónimo y las políticas no le permiten leer `orders`. La
 * alternativa sería abrir SELECT público con la reference como filtro, pero
 * entonces cualquiera podría enumerar pedidos probando referencias y leer datos
 * personales de otros clientes.
 *
 * La contención está en el tipo de retorno: estas funciones NUNCA devuelven
 * `voucher_path`, `operation_number`, `unit_cost_cents`, el DNI ni el email. Solo
 * lo que la persona que tiene la referencia necesita ver. La referencia misma es
 * la credencial, y por eso tiene 28^6 combinaciones (ver `reference.ts`).
 */

import { normalizeReference } from "@/lib/reference";
import { consumir, identificarPeticion } from "@/lib/rate-limit";
import type { Cents } from "@/lib/money";
import type { OrderStatus } from "@/lib/order-status";
import { createAdminClient } from "@/lib/supabase/client";

export type ItemPedido = {
  modelo: string;
  colorway: string;
  sizeUs: number;
  cantidad: number;
  unitPriceCents: Cents;
};

export type PedidoPublico = {
  reference: string;
  status: OrderStatus;
  creadoEn: string;
  subtotalCents: Cents;
  discountCents: Cents;
  shippingCents: Cents;
  totalCents: Cents;
  /** Céntimos identificadores: el dato que hace único el monto. */
  paymentCents: number | null;
  metodoPago: string;
  modoEnvio: string;
  /** Solo el nombre de pila, para saludar. Nunca apellidos ni documento. */
  nombreCliente: string;
  reservaHasta: string | null;
  items: ItemPedido[];
  envio: {
    guia: string | null;
    codigo: string | null;
    claveRetiro: string | null;
    agencia: string | null;
    urlRastreo: string | null;
    entregado: boolean;
  } | null;
  /** Estado del comprobante, sin exponer el voucher ni el número de operación. */
  pago: {
    status: string;
    comprobanteEnviado: boolean;
    motivoRechazo: string | null;
  } | null;
};

const SELECT_PEDIDO = `
  reference, status, created_at, subtotal_cents, discount_cents, shipping_cents,
  total_cents, payment_cents, payment_method, shipping_mode, agencia_destino,
  reserved_until,
  customers!inner ( nombre ),
  order_items ( product_modelo, product_colorway, size_us, cantidad, unit_price_cents ),
  shipments ( guia, codigo, pickup_code, tracking_url, delivered ),
  payments ( status, voucher_path, rejection_reason, created_at )
`;

/**
 * Busca un pedido por su referencia pública. `null` si no existe.
 *
 * @param solicitante Cabeceras de la petición, para aplicar el límite por IP. Se
 * pasa explícitamente en vez de leerlo aquí con `headers()` porque esta función
 * también se invoca desde contextos sin petición asociada.
 */
export async function obtenerPedidoPublico(
  referenceCruda: string,
  solicitante?: Headers,
): Promise<PedidoPublico | null> {
  /**
   * Límite por IP. Es la otra mitad del argumento de seguridad de `reference.ts`:
   * las 28⁶ combinaciones hacen costosa la fuerza bruta solo si no se pueden probar
   * miles por segundo. Sin esto, la referencia dejaría de ser una credencial
   * defendible.
   *
   * Se devuelve `null` al superarlo, igual que si el pedido no existiera: distinguir
   * "bloqueado" de "no existe" le diría a quien enumera que acertó con el formato.
   */
  if (solicitante !== undefined) {
    const limite = consumir("seguimiento", identificarPeticion(solicitante));
    if (!limite.permitido) return null;
  }

  const reference = normalizeReference(referenceCruda);
  // Se valida el formato antes de consultar: descarta el ruido de bots que prueban
  // rutas sin gastar una consulta a la base.
  if (reference === null) return null;

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("orders")
    .select(SELECT_PEDIDO)
    .eq("reference", reference)
    .maybeSingle();

  if (error !== null || data === null) return null;

  type Fila = {
    reference: string;
    status: OrderStatus;
    created_at: string;
    subtotal_cents: number;
    discount_cents: number;
    shipping_cents: number;
    total_cents: number;
    payment_cents: number | null;
    payment_method: string;
    shipping_mode: string;
    agencia_destino: string | null;
    reserved_until: string | null;
    customers: { nombre: string };
    order_items: Array<{
      product_modelo: string;
      product_colorway: string;
      size_us: number;
      cantidad: number;
      unit_price_cents: number;
    }>;
    shipments: Array<{
      guia: string | null;
      codigo: string | null;
      pickup_code: string | null;
      tracking_url: string | null;
      delivered: boolean;
    }>;
    payments: Array<{
      status: string;
      voucher_path: string | null;
      rejection_reason: string | null;
      created_at: string;
    }>;
  };

  const fila = data as unknown as Fila;
  const envio = fila.shipments[0];
  // El pago más reciente: un pedido rechazado puede tener varios intentos.
  const pago = [...fila.payments].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];

  return {
    reference: fila.reference,
    status: fila.status,
    creadoEn: fila.created_at,
    subtotalCents: fila.subtotal_cents,
    discountCents: fila.discount_cents,
    shippingCents: fila.shipping_cents,
    totalCents: fila.total_cents,
    paymentCents: fila.payment_cents,
    metodoPago: fila.payment_method,
    modoEnvio: fila.shipping_mode,
    // Solo el primer nombre, aunque en la base haya nombre completo.
    nombreCliente: fila.customers.nombre.split(" ")[0] ?? fila.customers.nombre,
    reservaHasta: fila.reserved_until,
    items: fila.order_items.map((i) => ({
      modelo: i.product_modelo,
      colorway: i.product_colorway,
      sizeUs: Number(i.size_us),
      cantidad: i.cantidad,
      unitPriceCents: i.unit_price_cents,
    })),
    envio:
      envio === undefined
        ? null
        : {
            guia: envio.guia,
            codigo: envio.codigo,
            claveRetiro: envio.pickup_code,
            agencia: fila.agencia_destino,
            urlRastreo: envio.tracking_url,
            entregado: envio.delivered,
          },
    pago:
      pago === undefined
        ? null
        : {
            status: pago.status,
            // Se deriva un booleano en vez de exponer la ruta del voucher.
            comprobanteEnviado: pago.voucher_path !== null,
            motivoRechazo: pago.rejection_reason,
          },
  };
}

/** ¿La reserva sigue viva? Para el contador de la pantalla de pago. */
export function reservaVigente(pedido: PedidoPublico, ahora = new Date()): boolean {
  if (pedido.reservaHasta === null) return false;
  return new Date(pedido.reservaHasta).getTime() > ahora.getTime();
}
