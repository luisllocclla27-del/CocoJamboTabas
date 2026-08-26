/**
 * Consultas de catálogo.
 *
 * Todas las lecturas públicas pasan por aquí, en el servidor. El motivo no es
 * rendimiento sino seguridad: la disponibilidad real de una talla depende de
 * `reservations`, una tabla que la RLS no expone a nadie. Si el navegador
 * calculara el stock, mostraría el stock físico e ignoraría las reservas activas,
 * anunciando como disponible un par que otro cliente ya tiene apartado.
 *
 * El precio también se lee aquí y NUNCA se acepta desde el cliente: en el
 * checkout, `create_order_with_reservations` lo vuelve a leer de la base. Es la
 * defensa contra manipular el precio desde el navegador.
 */

import { createServerClient } from "./server";
import type { BrandRow, ProductImageRow, ProductRow, VariantRow } from "./types";

/** Producto con marca, imágenes y tallas con disponibilidad real. */
export type ProductoConTallas = ProductRow & {
  brand: Pick<BrandRow, "slug" | "nombre">;
  images: ProductImageRow[];
  variants: Array<VariantRow & { disponible: number }>;
};

/** Lo mínimo para pintar una tarjeta de catálogo, sin traer datos de más. */
export type TarjetaProducto = {
  id: string;
  slug: string;
  modelo: string;
  colorway: string;
  marca: string;
  marcaSlug: string;
  priceCents: number;
  compareAtPriceCents: number | null;
  imagen: { url: string; alt: string } | null;
  /** Tallas US con al menos un par disponible. Vacío = agotado. */
  tallasDisponibles: number[];
  destacado: boolean;
};

const SELECT_PRODUCTO = `
  id, slug, brand_id, modelo, colorway, silueta, descripcion, condicion,
  cost_cents, price_cents, compare_at_price_cents, nota_calce,
  garantia_originalidad, activo, destacado, created_at, updated_at,
  brands!inner ( slug, nombre, activo ),
  product_images ( id, product_id, url, alt, orden, es_principal, created_at ),
  variants ( id, product_id, size_us, size_eu, size_cm, sku, stock, activo, created_at )
`;

type FilaProducto = ProductRow & {
  brands: { slug: string; nombre: string; activo: boolean };
  product_images: ProductImageRow[];
  variants: VariantRow[];
};

export type FiltrosCatalogo = {
  marca?: string;
  /** Talla US: solo devuelve productos con esa talla DISPONIBLE. */
  talla?: number;
  busqueda?: string;
  orden?: "novedad" | "precio_asc" | "precio_desc";
};

/**
 * Catálogo con la disponibilidad ya resuelta.
 *
 * La disponibilidad se calcula en una sola consulta agregada a `reservations` en
 * vez de llamar a `available_stock()` por variante: con 6 productos y 50 tallas
 * serían 50 round-trips por visita a la home.
 */
export async function listarCatalogo(filtros: FiltrosCatalogo = {}): Promise<TarjetaProducto[]> {
  const supabase = await createServerClient();

  let query = supabase.from("products").select(SELECT_PRODUCTO).eq("activo", true);

  if (filtros.marca !== undefined && filtros.marca !== "") {
    query = query.eq("brands.slug", filtros.marca);
  }
  if (filtros.busqueda !== undefined && filtros.busqueda.trim() !== "") {
    // `or` con `ilike` en vez del índice de texto completo: con este volumen es
    // suficiente y tolera búsquedas parciales como "chuck" o "old sk".
    const patron = `%${filtros.busqueda.trim()}%`;
    query = query.or(
      `modelo.ilike.${patron},colorway.ilike.${patron},silueta.ilike.${patron},descripcion.ilike.${patron}`,
    );
  }

  switch (filtros.orden) {
    case "precio_asc":
      query = query.order("price_cents", { ascending: true });
      break;
    case "precio_desc":
      query = query.order("price_cents", { ascending: false });
      break;
    default:
      // Destacados primero, y dentro de ellos lo más nuevo.
      query = query
        .order("destacado", { ascending: false })
        .order("created_at", { ascending: false });
  }

  const { data, error } = await query;
  if (error !== null) throw new Error(`no se pudo leer el catálogo: ${error.message}`);

  const filas = (data ?? []) as unknown as FilaProducto[];
  const reservas = await reservasPorVariante(filas.flatMap((p) => p.variants.map((v) => v.id)));

  const tarjetas = filas.map((fila) => aTarjeta(fila, reservas));

  // El filtro por talla se aplica DESPUÉS de calcular la disponibilidad: filtrar
  // por `variants.stock > 0` en SQL ignoraría las reservas y llevaría al cliente a
  // una ficha donde su talla ya no está. Es la primera causa de abandono.
  if (filtros.talla !== undefined) {
    return tarjetas.filter((t) => t.tallasDisponibles.includes(filtros.talla!));
  }
  return tarjetas;
}

/** Un producto por su slug, o `null` si no existe o está inactivo. */
export async function obtenerProducto(slug: string): Promise<ProductoConTallas | null> {
  const supabase = await createServerClient();
  const { data, error } = await supabase
    .from("products")
    .select(SELECT_PRODUCTO)
    .eq("slug", slug)
    .eq("activo", true)
    .maybeSingle();

  if (error !== null) throw new Error(`no se pudo leer el producto: ${error.message}`);
  if (data === null) return null;

  const fila = data as unknown as FilaProducto;
  const reservas = await reservasPorVariante(fila.variants.map((v) => v.id));

  return {
    ...soloProducto(fila),
    brand: { slug: fila.brands.slug, nombre: fila.brands.nombre },
    images: [...fila.product_images].sort(ordenarImagenes),
    variants: fila.variants
      .filter((v) => v.activo)
      .sort((a, b) => a.size_us - b.size_us)
      .map((v) => ({
        ...v,
        disponible: Math.max(0, v.stock - (reservas.get(v.id) ?? 0)),
      })),
  };
}

export async function listarMarcas(): Promise<Array<Pick<BrandRow, "slug" | "nombre">>> {
  const supabase = await createServerClient();
  const { data, error } = await supabase
    .from("brands")
    .select("slug, nombre")
    .eq("activo", true)
    .order("orden", { ascending: true });
  if (error !== null) throw new Error(`no se pudieron leer las marcas: ${error.message}`);
  return data ?? [];
}

/** Tallas US que existen en el catálogo, para el filtro. */
export async function listarTallasDelCatalogo(): Promise<number[]> {
  const supabase = await createServerClient();
  const { data, error } = await supabase
    .from("variants")
    .select("size_us")
    .eq("activo", true)
    .order("size_us", { ascending: true });
  if (error !== null) throw new Error(`no se pudieron leer las tallas: ${error.message}`);
  return [...new Set((data ?? []).map((v) => Number(v.size_us)))];
}

export async function listarDestacados(limite = 4): Promise<TarjetaProducto[]> {
  const todos = await listarCatalogo();
  const destacados = todos.filter((p) => p.destacado);
  return (destacados.length > 0 ? destacados : todos).slice(0, limite);
}

let ultimaLimpieza = 0;
const INTERVALO_LIMPIEZA_MS = 60 * 1000; // 1 minuto

/**
 * Limpieza oportunista de reservas vencidas.
 * Se ejecuta al vuelo con un intervalo mínimo de 1 minuto para garantizar
 * que los carritos abandonados liberen el stock de inmediato sin depender
 * exclusivamente de un cron externo.
 */
async function limpiarReservasExpiradasOportunista(): Promise<void> {
  const ahora = Date.now();
  if (ahora - ultimaLimpieza < INTERVALO_LIMPIEZA_MS) return;
  ultimaLimpieza = ahora;
  try {
    const { createAdminClient } = await import("./client");
    const supabase = createAdminClient();
    await supabase.rpc("expire_stale_reservations");
  } catch {
    // Si no está disponible service_role o falla, continúa sin interrumpir la carga
  }
}

/**
 * Reservas activas agrupadas por variante.
 *
 * Solo cuenta las que están `activa` y no han expirado, que es la misma condición
 * que usa `available_stock()` en SQL.
 */
async function reservasPorVariante(variantIds: string[]): Promise<Map<string, number>> {
  const mapa = new Map<string, number>();
  if (variantIds.length === 0) return mapa;

  // Disparar autolimpieza oportunista en segundo plano
  void limpiarReservasExpiradasOportunista();

  try {
    const { createAdminClient } = await import("./client");
    const supabaseAdmin = createAdminClient();
    const { data, error } = await supabaseAdmin
      .from("reservations")
      .select("variant_id, cantidad")
      .in("variant_id", variantIds)
      .eq("status", "activa")
      .gt("expires_at", new Date().toISOString());

    if (error === null && data !== null) {
      for (const fila of data) {
        mapa.set(fila.variant_id, (mapa.get(fila.variant_id) ?? 0) + fila.cantidad);
      }
      return mapa;
    }
  } catch {
    // Fallback a cliente de sesión si createAdminClient no está disponible
  }

  const supabase = await createServerClient();
  const { data, error } = await supabase
    .from("reservations")
    .select("variant_id, cantidad")
    .in("variant_id", variantIds)
    .eq("status", "activa")
    .gt("expires_at", new Date().toISOString());

  if (error !== null) return mapa;

  for (const fila of data ?? []) {
    mapa.set(fila.variant_id, (mapa.get(fila.variant_id) ?? 0) + fila.cantidad);
  }
  return mapa;
}

function ordenarImagenes(a: ProductImageRow, b: ProductImageRow): number {
  if (a.es_principal !== b.es_principal) return a.es_principal ? -1 : 1;
  return a.orden - b.orden;
}

function soloProducto(fila: FilaProducto): ProductRow {
  const { brands: _b, product_images: _i, variants: _v, ...producto } = fila;
  return producto;
}

function aTarjeta(fila: FilaProducto, reservas: Map<string, number>): TarjetaProducto {
  const principal = [...fila.product_images].sort(ordenarImagenes)[0];
  return {
    id: fila.id,
    slug: fila.slug,
    modelo: fila.modelo,
    colorway: fila.colorway,
    marca: fila.brands.nombre,
    marcaSlug: fila.brands.slug,
    priceCents: fila.price_cents,
    compareAtPriceCents: fila.compare_at_price_cents,
    imagen: principal === undefined ? null : { url: principal.url, alt: principal.alt },
    tallasDisponibles: fila.variants
      .filter((v) => v.activo && v.stock - (reservas.get(v.id) ?? 0) > 0)
      .map((v) => Number(v.size_us))
      .sort((a, b) => a - b),
    destacado: fila.destacado,
  };
}
