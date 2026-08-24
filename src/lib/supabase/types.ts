/**
 * Tipos de la base de datos.
 *
 * Escritos a mano en vez de generados con `supabase gen types`, por una razón
 * concreta: el proyecto tiene que compilar y correr sus tests sin que exista una
 * base de datos. Un tipo generado obliga a tener credenciales para poder hacer
 * `npm run typecheck`, y eso rompe el CI y a cualquiera que clone el repo.
 *
 * Cuando el proyecto tenga la base levantada, conviene regenerarlos con
 * `npx supabase gen types typescript --linked` y comparar: si algo difiere, este
 * archivo quedó desactualizado respecto a las migraciones.
 *
 * Regla de oro: los importes son `number` **de céntimos enteros**. Postgres
 * devuelve `integer` como number, así que el tipo es honesto; lo que no es obvio
 * es la unidad, y de ahí el sufijo `_cents` en cada nombre.
 */

export type OrderStatusDb =
  | "pendiente_pago"
  | "comprobante_enviado"
  | "verificado"
  | "rechazado"
  | "preparando"
  | "enviado"
  | "entregado"
  | "cancelado"
  | "expirado";

export type PaymentMethodDb = "yape_manual" | "tupay" | "contraentrega";

export type PaymentStatusDb = "pendiente" | "en_revision" | "aprobado" | "rechazado" | "expirado";

export type ReservationStatusDb = "activa" | "confirmada" | "liberada" | "expirada";

export type ShippingModeDb = "lima_domicilio" | "provincia_agencia" | "recojo_tienda";

export type CondicionDb = "nuevo_en_caja" | "nuevo_sin_caja";

export type BrandRow = {
  id: string;
  slug: string;
  nombre: string;
  logo_url: string | null;
  activo: boolean;
  orden: number;
  created_at: string;
};

export type ProductRow = {
  id: string;
  slug: string;
  brand_id: string;
  modelo: string;
  colorway: string;
  silueta: string | null;
  descripcion: string | null;
  condicion: CondicionDb;
  cost_cents: number;
  price_cents: number;
  compare_at_price_cents: number | null;
  /** Observación de calce escrita por el comerciante. Nunca autogenerada. */
  nota_calce: string | null;
  garantia_originalidad: string | null;
  activo: boolean;
  destacado: boolean;
  created_at: string;
  updated_at: string;
};

export type ProductImageRow = {
  id: string;
  product_id: string;
  url: string;
  /** Obligatorio en la base: sin `alt` la ficha no es accesible. */
  alt: string;
  orden: number;
  es_principal: boolean;
  created_at: string;
};

export type VariantRow = {
  id: string;
  product_id: string;
  size_us: number;
  size_eu: number | null;
  size_cm: number | null;
  sku: string;
  /** Stock físico. El disponible para vender lo da `available_stock()`. */
  stock: number;
  activo: boolean;
  created_at: string;
};

export type OrderRow = {
  id: string;
  reference: string;
  customer_id: string;
  status: OrderStatusDb;
  subtotal_cents: number;
  discount_cents: number;
  shipping_cents: number;
  /** Total final, con los céntimos identificadores ya aplicados. */
  total_cents: number;
  /** Céntimos identificadores (1-99). Único entre los pedidos esperando pago. */
  payment_cents: number | null;
  payment_method: PaymentMethodDb;
  shipping_mode: ShippingModeDb;
  direccion: string | null;
  distrito: string | null;
  departamento: string | null;
  provincia: string | null;
  agencia_destino: string | null;
  notas: string | null;
  reserved_until: string | null;
  created_at: string;
  updated_at: string;
};

export type OrderItemRow = {
  id: string;
  order_id: string;
  variant_id: string | null;
  cantidad: number;
  unit_price_cents: number;
  /** Costo congelado al vender: permite calcular la ganancia histórica real. */
  unit_cost_cents: number;
  /** Snapshot: el pedido histórico sobrevive al renombrado o borrado del producto. */
  product_modelo: string;
  product_colorway: string;
  size_us: number;
  created_at: string;
};

export type PaymentRow = {
  id: string;
  order_id: string;
  method: PaymentMethodDb;
  status: PaymentStatusDb;
  amount_cents: number;
  operation_number: string | null;
  /** Ruta en Storage, NO una URL pública. Se firma al vuelo para el admin. */
  voucher_path: string | null;
  voucher_phash: string | null;
  voucher_sha256: string | null;
  ocr_raw: unknown;
  ocr_confidence: number | null;
  risk_score: number | null;
  risk_signals: unknown;
  provider_deposit_id: string | null;
  provider_invoice_id: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  rejection_reason: string | null;
  created_at: string;
};

export type ShipmentRow = {
  id: string;
  order_id: string;
  provider: "manual" | "shalom";
  guia: string | null;
  codigo: string | null;
  /** Clave de retiro de 4 dígitos que el destinatario presenta en la agencia. */
  pickup_code: string | null;
  agencia_origen_id: number | null;
  agencia_destino_id: number | null;
  tracking_url: string | null;
  hitos: unknown;
  delivered: boolean;
  created_at: string;
  updated_at: string;
};

/** Resultado de `public_order_tracking()`: solo datos no sensibles. */
export type PublicTracking = {
  reference: string;
  status: OrderStatusDb;
  created_at: string;
  total_cents: number;
  items: Array<{
    modelo: string;
    colorway: string;
    size_us: number;
    cantidad: number;
  }>;
  envio: {
    guia: string | null;
    codigo: string | null;
    pickup_code: string | null;
    agencia_destino: string | null;
    tracking_url: string | null;
    hitos: unknown;
    delivered: boolean;
  } | null;
};

/** Producto con lo necesario para pintar una tarjeta de catálogo. */
export type ProductCard = ProductRow & {
  brand: Pick<BrandRow, "slug" | "nombre">;
  images: ProductImageRow[];
  variants: Array<VariantRow & { disponible: number }>;
};
