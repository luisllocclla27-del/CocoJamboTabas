/**
 * Consultas del panel de administración.
 *
 * Van con la service_role key porque son consultas agregadas sobre datos que la
 * RLS restringe a admins, y el rol de sesión no puede hacer agregaciones sobre
 * tablas que no lee. La autorización ya se comprobó en el layout del panel y las
 * políticas RLS siguen activas por debajo.
 *
 * Nota sobre el margen: `unit_cost_cents` se congela en `order_items` al vender.
 * Por eso la ganancia histórica es exacta aunque el costo del producto cambie
 * después; calcularla contra `products.cost_cents` daría cifras que se mueven
 * hacia atrás en el tiempo cada vez que sube un precio de compra.
 */

import type { Cents } from "@/lib/money";
import type { OrderStatus } from "@/lib/order-status";
import { createAdminClient } from "@/lib/supabase/client";

export type ResumenPanel = {
  porVerificar: number;
  ventasMesCents: Cents;
  gananciaMesCents: Cents;
  pedidosMes: number;
  tallasPorAgotarse: Array<{
    modelo: string;
    colorway: string;
    sizeUs: number;
    stock: number;
    slug: string;
  }>;
  enEspera: number;
  tallasQueRotan: Array<{ sizeUs: number; unidades: number }>;
  /** Avisos redactados esperando que alguien los mande. */
  avisosPendientes: number;
};

/** Estados que cuentan como venta cerrada para el resumen. */
const ESTADOS_VENDIDOS: OrderStatus[] = ["verificado", "preparando", "enviado", "entregado"];

export async function obtenerResumen(): Promise<ResumenPanel> {
  const supabase = createAdminClient();
  const inicioMes = new Date();
  inicioMes.setUTCDate(1);
  inicioMes.setUTCHours(0, 0, 0, 0);

  const [colaVerificacion, ventas, stockBajo, espera, avisos] = await Promise.all([
    supabase
      .from("orders")
      .select("id", { count: "exact", head: true })
      .eq("status", "comprobante_enviado"),

    supabase
      .from("orders")
      .select("total_cents, order_items(cantidad, unit_price_cents, unit_cost_cents, size_us)")
      .in("status", ESTADOS_VENDIDOS)
      .gte("created_at", inicioMes.toISOString()),

    supabase
      .from("variants")
      .select("size_us, stock, products!inner(modelo, colorway, slug, activo)")
      .eq("activo", true)
      .gt("stock", 0)
      // 2 o menos: el umbral con el que se avisa "últimas unidades" al cliente.
      .lte("stock", 2)
      .order("stock", { ascending: true })
      .limit(12),

    supabase
      .from("waitlist")
      .select("id", { count: "exact", head: true })
      .eq("notificado", false),

    // El error no se propaga: sin la migración 0005 la tabla `outbox` no existe y
    // el resumen tiene que seguir cargando. La cifra queda en 0 y la pantalla de
    // avisos es la que explica el problema.
    supabase
      .from("outbox")
      .select("id", { count: "exact", head: true })
      .eq("status", "pendiente"),
  ]);

  type FilaVenta = {
    total_cents: number;
    order_items: Array<{
      cantidad: number;
      unit_price_cents: number;
      unit_cost_cents: number;
      size_us: number;
    }>;
  };

  const filasVenta = (ventas.data ?? []) as unknown as FilaVenta[];

  let ventasMesCents = 0;
  let gananciaMesCents = 0;
  const rotacionPorTalla = new Map<number, number>();

  for (const pedido of filasVenta) {
    ventasMesCents += pedido.total_cents;
    for (const item of pedido.order_items) {
      gananciaMesCents += (item.unit_price_cents - item.unit_cost_cents) * item.cantidad;
      const talla = Number(item.size_us);
      rotacionPorTalla.set(talla, (rotacionPorTalla.get(talla) ?? 0) + item.cantidad);
    }
  }

  type FilaStock = {
    size_us: number;
    stock: number;
    products: { modelo: string; colorway: string; slug: string; activo: boolean };
  };

  const filasStock = (stockBajo.data ?? []) as unknown as FilaStock[];

  return {
    porVerificar: colaVerificacion.count ?? 0,
    ventasMesCents,
    gananciaMesCents,
    pedidosMes: filasVenta.length,
    tallasPorAgotarse: filasStock
      .filter((f) => f.products.activo)
      .map((f) => ({
        modelo: f.products.modelo,
        colorway: f.products.colorway,
        slug: f.products.slug,
        sizeUs: Number(f.size_us),
        stock: f.stock,
      })),
    enEspera: espera.count ?? 0,
    // Las tallas que más rotan son el dato que decide las compras de reposición.
    tallasQueRotan: [...rotacionPorTalla.entries()]
      .map(([sizeUs, unidades]) => ({ sizeUs, unidades }))
      .sort((a, b) => b.unidades - a.unidades)
      .slice(0, 6),
    avisosPendientes: avisos.count ?? 0,
  };
}

/**
 * Marcas para el formulario de alta.
 *
 * Se listan también las inactivas, al contrario que en el catálogo público: una
 * marca desactivada sigue siendo una marca de la que puede llegar mercadería, y
 * ocultarla aquí obligaría a reactivarla antes de poder cargar el producto.
 */
export async function listarMarcasAdmin(): Promise<
  Array<{ slug: string; nombre: string; activo: boolean }>
> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("brands")
    .select("slug, nombre, activo")
    .order("orden", { ascending: true });

  if (error !== null) throw new Error(`no se pudieron leer las marcas: ${error.message}`);
  return (data ?? []) as Array<{ slug: string; nombre: string; activo: boolean }>;
}

export type ComprobantePendiente = {
  paymentId: string;
  orderId: string;
  reference: string;
  creadoEn: string;
  nombreCliente: string;
  telefono: string;
  montoEsperadoCents: Cents;
  operationNumber: string | null;
  voucherPath: string | null;
  riskScore: number | null;
  riskSignals: Array<{ codigo: string; severidad: string; mensaje: string; puntos: number }>;
  items: Array<{ modelo: string; colorway: string; sizeUs: number; cantidad: number }>;
  /** `true` si este número de operación aparece en más de un pago. */
  operacionDuplicada: boolean;
};

/**
 * Cola de verificación, ordenada por riesgo ascendente.
 *
 * Lo limpio primero para que el admin apruebe rápido lo obvio y dedique atención a
 * lo dudoso. Ordenar por antigüedad mezclaría un caso sospechoso entre veinte
 * legítimos y es donde se cometen los errores.
 */
export async function listarComprobantesPendientes(): Promise<ComprobantePendiente[]> {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("payments")
    .select(
      `
      id, order_id, amount_cents, operation_number, voucher_path, risk_score,
      risk_signals, created_at,
      orders!inner (
        reference, status,
        customers!inner ( nombre, apellidos, telefono ),
        order_items ( product_modelo, product_colorway, size_us, cantidad )
      )
    `,
    )
    .eq("status", "en_revision")
    .order("risk_score", { ascending: true, nullsFirst: true });

  if (error !== null) throw new Error(`no se pudo leer la cola: ${error.message}`);

  type Fila = {
    id: string;
    order_id: string;
    amount_cents: number;
    operation_number: string | null;
    voucher_path: string | null;
    risk_score: number | null;
    risk_signals: unknown;
    created_at: string;
    orders: {
      reference: string;
      status: string;
      customers: { nombre: string; apellidos: string; telefono: string };
      order_items: Array<{
        product_modelo: string;
        product_colorway: string;
        size_us: number;
        cantidad: number;
      }>;
    };
  };

  const filas = (data ?? []) as unknown as Fila[];

  // Detección de números de operación repetidos dentro de la propia cola: el
  // índice único los impide entre pagos distintos, pero un mismo número puede
  // haber quedado en un pago rechazado anterior.
  const conteoOperaciones = new Map<string, number>();
  for (const fila of filas) {
    if (fila.operation_number === null) continue;
    conteoOperaciones.set(
      fila.operation_number,
      (conteoOperaciones.get(fila.operation_number) ?? 0) + 1,
    );
  }

  return filas
    .filter((f) => f.orders.status === "comprobante_enviado")
    .map((f) => ({
      paymentId: f.id,
      orderId: f.order_id,
      reference: f.orders.reference,
      creadoEn: f.created_at,
      nombreCliente: `${f.orders.customers.nombre} ${f.orders.customers.apellidos}`.trim(),
      telefono: f.orders.customers.telefono,
      montoEsperadoCents: f.amount_cents,
      operationNumber: f.operation_number,
      voucherPath: f.voucher_path,
      riskScore: f.risk_score,
      riskSignals: Array.isArray(f.risk_signals)
        ? (f.risk_signals as ComprobantePendiente["riskSignals"])
        : [],
      items: f.orders.order_items.map((i) => ({
        modelo: i.product_modelo,
        colorway: i.product_colorway,
        sizeUs: Number(i.size_us),
        cantidad: i.cantidad,
      })),
      operacionDuplicada:
        f.operation_number !== null && (conteoOperaciones.get(f.operation_number) ?? 0) > 1,
    }));
}

/**
 * URL firmada del voucher, válida unos minutos.
 *
 * El bucket es privado, así que esta es la ÚNICA forma de ver un comprobante. Se
 * firma bajo demanda y caduca: si la URL se filtrara (en un log, en un historial),
 * deja de servir en 5 minutos en lugar de exponer el documento para siempre.
 */
export async function urlFirmadaVoucher(ruta: string): Promise<string | null> {
  const supabase = createAdminClient();
  const { data, error } = await supabase.storage.from("vouchers").createSignedUrl(ruta, 300);
  if (error !== null || data === null) return null;
  return data.signedUrl;
}

export type PedidoAdmin = {
  id: string;
  reference: string;
  status: OrderStatus;
  creadoEn: string;
  totalCents: Cents;
  gananciaCents: Cents;
  nombreCliente: string;
  telefono: string;
  dni: string | null;
  modoEnvio: string;
  direccion: string | null;
  distrito: string | null;
  departamento: string | null;
  provincia: string | null;
  agenciaDestino: string | null;
  notas: string | null;
  items: Array<{ modelo: string; colorway: string; sizeUs: number; cantidad: number }>;
  envio: { guia: string | null; codigo: string | null; claveRetiro: string | null } | null;
};

/**
 * Pedidos para el panel, del más reciente al más antiguo.
 *
 * Se limita a 100: una tienda pequeña no necesita paginación todavía, y traer
 * todo el historial cada vez que se abre la pantalla sería gratuito hoy y un
 * problema en un año. El límite deja constancia de dónde habrá que paginar.
 */
export async function listarPedidos(estado?: OrderStatus): Promise<PedidoAdmin[]> {
  const supabase = createAdminClient();

  let query = supabase
    .from("orders")
    .select(
      `
      id, reference, status, created_at, total_cents, shipping_mode,
      direccion, distrito, departamento, provincia, agencia_destino, notas,
      customers!inner ( nombre, apellidos, telefono, dni ),
      order_items ( product_modelo, product_colorway, size_us, cantidad, unit_price_cents, unit_cost_cents ),
      shipments ( guia, codigo, pickup_code )
    `,
    )
    .order("created_at", { ascending: false })
    .limit(100);

  if (estado !== undefined) query = query.eq("status", estado);

  const { data, error } = await query;
  if (error !== null) throw new Error(`no se pudieron leer los pedidos: ${error.message}`);

  type Fila = {
    id: string;
    reference: string;
    status: OrderStatus;
    created_at: string;
    total_cents: number;
    shipping_mode: string;
    direccion: string | null;
    distrito: string | null;
    departamento: string | null;
    provincia: string | null;
    agencia_destino: string | null;
    notas: string | null;
    customers: { nombre: string; apellidos: string; telefono: string; dni: string | null };
    order_items: Array<{
      product_modelo: string;
      product_colorway: string;
      size_us: number;
      cantidad: number;
      unit_price_cents: number;
      unit_cost_cents: number;
    }>;
    shipments: Array<{ guia: string | null; codigo: string | null; pickup_code: string | null }>;
  };

  return ((data ?? []) as unknown as Fila[]).map((f) => ({
    id: f.id,
    reference: f.reference,
    status: f.status,
    creadoEn: f.created_at,
    totalCents: f.total_cents,
    // Ganancia con el costo congelado al vender: exacta aunque el costo del
    // producto haya cambiado después.
    gananciaCents: f.order_items.reduce(
      (suma, i) => suma + (i.unit_price_cents - i.unit_cost_cents) * i.cantidad,
      0,
    ),
    nombreCliente: `${f.customers.nombre} ${f.customers.apellidos}`.trim(),
    telefono: f.customers.telefono,
    dni: f.customers.dni,
    modoEnvio: f.shipping_mode,
    direccion: f.direccion,
    distrito: f.distrito,
    departamento: f.departamento,
    provincia: f.provincia,
    agenciaDestino: f.agencia_destino,
    notas: f.notas,
    items: f.order_items.map((i) => ({
      modelo: i.product_modelo,
      colorway: i.product_colorway,
      sizeUs: Number(i.size_us),
      cantidad: i.cantidad,
    })),
    envio:
      f.shipments[0] === undefined
        ? null
        : {
            guia: f.shipments[0].guia,
            codigo: f.shipments[0].codigo,
            claveRetiro: f.shipments[0].pickup_code,
          },
  }));
}

export type ProductoAdmin = {
  id: string;
  slug: string;
  modelo: string;
  colorway: string;
  marca: string;
  priceCents: Cents;
  costCents: Cents;
  activo: boolean;
  destacado: boolean;
  variantes: Array<{ id: string; sizeUs: number; stock: number; sku: string; activo: boolean }>;
};

export async function listarProductosAdmin(): Promise<ProductoAdmin[]> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("products")
    .select(
      `
      id, slug, modelo, colorway, price_cents, cost_cents, activo, destacado,
      brands!inner ( nombre ),
      variants ( id, size_us, stock, sku, activo )
    `,
    )
    .order("created_at", { ascending: false });

  if (error !== null) throw new Error(`no se pudieron leer los productos: ${error.message}`);

  type Fila = {
    id: string;
    slug: string;
    modelo: string;
    colorway: string;
    price_cents: number;
    cost_cents: number;
    activo: boolean;
    destacado: boolean;
    brands: { nombre: string };
    variants: Array<{ id: string; size_us: number; stock: number; sku: string; activo: boolean }>;
  };

  return ((data ?? []) as unknown as Fila[]).map((f) => ({
    id: f.id,
    slug: f.slug,
    modelo: f.modelo,
    colorway: f.colorway,
    marca: f.brands.nombre,
    priceCents: f.price_cents,
    costCents: f.cost_cents,
    activo: f.activo,
    destacado: f.destacado,
    variantes: f.variants
      .map((v) => ({ ...v, sizeUs: Number(v.size_us) }))
      .sort((a, b) => a.sizeUs - b.sizeUs),
  }));
}

export type ProductoAdminDetalle = {
  id: string;
  slug: string;
  brandId: string;
  brandSlug: string;
  brandNombre: string;
  modelo: string;
  colorway: string;
  silueta: string | null;
  descripcion: string | null;
  condicion: string;
  costCents: Cents;
  priceCents: Cents;
  compareAtPriceCents: Cents | null;
  notaCalce: string | null;
  activo: boolean;
  destacado: boolean;
  images: Array<{
    id: string;
    url: string;
    alt: string;
    orden: number;
    esPrincipal: boolean;
  }>;
  variantes: Array<{
    id: string;
    sizeUs: number;
    sizeEu: number | null;
    sizeCm: number | null;
    stock: number;
    sku: string;
    activo: boolean;
  }>;
};

/**
 * Consulta detallada de un producto para su pantalla de edición.
 */
export async function obtenerProductoAdminDetalle(id: string): Promise<ProductoAdminDetalle | null> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("products")
    .select(
      `
      id, slug, brand_id, modelo, colorway, silueta, descripcion, condicion,
      cost_cents, price_cents, compare_at_price_cents, nota_calce, activo, destacado,
      brands!inner ( id, slug, nombre ),
      product_images ( id, url, alt, orden, es_principal ),
      variants ( id, size_us, size_eu, size_cm, stock, sku, activo )
    `,
    )
    .eq("id", id)
    .maybeSingle();

  if (error !== null || data === null) return null;

  type FilaDetalle = {
    id: string;
    slug: string;
    brand_id: string;
    modelo: string;
    colorway: string;
    silueta: string | null;
    descripcion: string | null;
    condicion: string;
    cost_cents: number;
    price_cents: number;
    compare_at_price_cents: number | null;
    nota_calce: string | null;
    activo: boolean;
    destacado: boolean;
    brands: { id: string; slug: string; nombre: string };
    product_images: Array<{ id: string; url: string; alt: string; orden: number; es_principal: boolean }>;
    variants: Array<{ id: string; size_us: number; size_eu: number | null; size_cm: number | null; stock: number; sku: string; activo: boolean }>;
  };

  const f = data as unknown as FilaDetalle;

  return {
    id: f.id,
    slug: f.slug,
    brandId: f.brands.id,
    brandSlug: f.brands.slug,
    brandNombre: f.brands.nombre,
    modelo: f.modelo,
    colorway: f.colorway,
    silueta: f.silueta,
    descripcion: f.descripcion,
    condicion: f.condicion,
    costCents: f.cost_cents,
    priceCents: f.price_cents,
    compareAtPriceCents: f.compare_at_price_cents,
    notaCalce: f.nota_calce,
    activo: f.activo,
    destacado: f.destacado,
    images: (f.product_images ?? [])
      .map((img) => ({
        id: img.id,
        url: img.url,
        alt: img.alt,
        orden: img.orden,
        esPrincipal: img.es_principal,
      }))
      .sort((a, b) => {
        if (a.esPrincipal !== b.esPrincipal) return a.esPrincipal ? -1 : 1;
        return a.orden - b.orden;
      }),
    variantes: (f.variants ?? [])
      .map((v) => ({
        id: v.id,
        sizeUs: Number(v.size_us),
        sizeEu: v.size_eu === null ? null : Number(v.size_eu),
        sizeCm: v.size_cm === null ? null : Number(v.size_cm),
        stock: v.stock,
        sku: v.sku,
        activo: v.activo,
      }))
      .sort((a, b) => a.sizeUs - b.sizeUs),
  };
}

export type EsperaAdmin = {
  id: string;
  telefono: string;
  creadoEn: string;
  modelo: string;
  colorway: string;
  sizeUs: number;
  /** Stock actual de esa talla: si es > 0, ya se puede avisar. */
  stockActual: number;
};

/**
 * Lista de espera pendiente de avisar.
 *
 * Se ordena poniendo primero lo que YA tiene stock: son los avisos que se pueden
 * mandar ahora mismo y que convierten en venta inmediata. El resto es la señal de
 * qué reponer.
 */
export async function listarListaEspera(): Promise<EsperaAdmin[]> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("waitlist")
    .select(
      `
      id, telefono, created_at,
      variants!inner ( size_us, stock, products!inner ( modelo, colorway ) )
    `,
    )
    .eq("notificado", false)
    .order("created_at", { ascending: true });

  if (error !== null) throw new Error(`no se pudo leer la lista de espera: ${error.message}`);

  type Fila = {
    id: string;
    telefono: string;
    created_at: string;
    variants: {
      size_us: number;
      stock: number;
      products: { modelo: string; colorway: string };
    };
  };

  return ((data ?? []) as unknown as Fila[])
    .map((f) => ({
      id: f.id,
      telefono: f.telefono,
      creadoEn: f.created_at,
      modelo: f.variants.products.modelo,
      colorway: f.variants.products.colorway,
      sizeUs: Number(f.variants.size_us),
      stockActual: f.variants.stock,
    }))
    .sort((a, b) => b.stockActual - a.stockActual);
}

/**
 * Cuenta los productos activos cuyas variantes activas tienen stock = 0.
 *
 * Para second hand son los "muertos vivientes": aparecen en el catálogo como
 * agotados pero no tienen posibilidad de reposición. Lo habitual es que ya se
 * vendieron y el comerciante olvidó desactivarlos.
 */
export async function obtenerProductosSinStock(): Promise<number> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("products")
    .select("id, variants!inner(stock, activo)")
    .eq("activo", true)
    .eq("variants.activo", true);
  if (error !== null || data === null) return 0;
  return (data as unknown as Array<{ id: string; variants: Array<{ stock: number }> }>).filter(
    (p) => p.variants.every((v) => v.stock === 0),
  ).length;
}
