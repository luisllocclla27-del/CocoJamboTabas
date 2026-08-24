/**
 * Resuelve el carrito de la cookie a líneas con precios reales.
 *
 * PIEZA CLAVE DE SEGURIDAD: la cookie solo guarda `variantId` y `cantidad`. Los
 * precios se leen aquí, de la base, en cada carga. Nunca llegan del cliente. Sin
 * esto, alguien editaría la cookie para pagar S/ 1 por unas Samba.
 *
 * Y el `unit_cost_cents` no sale de aquí: no tiene por qué llegar al navegador. El
 * costo del par es información del negocio, no del comprador.
 */

import type { Cents } from "@/lib/money";
import { createServerClient } from "@/lib/supabase/server";
import type { Carrito } from "./cart";

export type LineaCarrito = {
  variantId: string;
  productoSlug: string;
  modelo: string;
  colorway: string;
  marca: string;
  sizeUs: number;
  cantidad: number;
  unitPriceCents: Cents;
  subtotalCents: Cents;
  imagen: { url: string; alt: string } | null;
  /** Disponibilidad ahora mismo, para avisar si cambió desde que lo agregó. */
  disponible: number;
  /** `true` si ya no hay stock para la cantidad pedida. */
  problema: boolean;
};

export type CarritoResuelto = {
  lineas: LineaCarrito[];
  subtotalCents: Cents;
  unidades: number;
  /** `true` si alguna línea perdió stock: bloquea el avance al checkout. */
  hayProblemas: boolean;
};

const VACIO: CarritoResuelto = {
  lineas: [],
  subtotalCents: 0,
  unidades: 0,
  hayProblemas: false,
};

export async function resolverCarrito(carrito: Carrito): Promise<CarritoResuelto> {
  if (carrito.items.length === 0) return VACIO;

  const supabase = await createServerClient();
  const variantIds = carrito.items.map((i) => i.variantId);

  const { data, error } = await supabase
    .from("variants")
    .select(
      `
      id, size_us, stock, activo,
      products!inner (
        slug, modelo, colorway, price_cents, activo,
        brands!inner ( nombre ),
        product_images ( url, alt, orden, es_principal )
      )
    `,
    )
    .in("id", variantIds)
    .eq("activo", true);

  if (error !== null) throw new Error(`no se pudo resolver el carrito: ${error.message}`);

  type Fila = {
    id: string;
    size_us: number;
    stock: number;
    products: {
      slug: string;
      modelo: string;
      colorway: string;
      price_cents: number;
      activo: boolean;
      brands: { nombre: string };
      product_images: Array<{ url: string; alt: string; orden: number; es_principal: boolean }>;
    };
  };

  const filas = (data ?? []) as unknown as Fila[];
  const porId = new Map(filas.map((f) => [f.id, f]));
  const reservas = await reservasAjenas(variantIds);

  const lineas: LineaCarrito[] = [];
  for (const item of carrito.items) {
    const fila = porId.get(item.variantId);
    // Una variante que ya no existe o cuyo producto se desactivó desaparece del
    // carrito en silencio: mostrar una línea de un producto retirado solo genera
    // una consulta por WhatsApp que no lleva a ninguna venta.
    if (fila === undefined || !fila.products.activo) continue;

    const disponible = Math.max(0, fila.stock - (reservas.get(item.variantId) ?? 0));
    const imagenes = [...fila.products.product_images].sort((a, b) => {
      if (a.es_principal !== b.es_principal) return a.es_principal ? -1 : 1;
      return a.orden - b.orden;
    });

    lineas.push({
      variantId: item.variantId,
      productoSlug: fila.products.slug,
      modelo: fila.products.modelo,
      colorway: fila.products.colorway,
      marca: fila.products.brands.nombre,
      sizeUs: Number(fila.size_us),
      cantidad: item.cantidad,
      unitPriceCents: fila.products.price_cents,
      subtotalCents: fila.products.price_cents * item.cantidad,
      imagen: imagenes[0] === undefined ? null : { url: imagenes[0].url, alt: imagenes[0].alt },
      disponible,
      problema: disponible < item.cantidad,
    });
  }

  return {
    lineas,
    subtotalCents: lineas.reduce((suma, l) => suma + l.subtotalCents, 0),
    unidades: lineas.reduce((suma, l) => suma + l.cantidad, 0),
    hayProblemas: lineas.some((l) => l.problema),
  };
}

/**
 * Reservas activas de otros pedidos.
 *
 * Igual que en el catálogo: la RLS no expone `reservations` al rol anónimo, así
 * que en el sitio público esto devuelve vacío y se muestra el stock físico. Es un
 * sobreconteo conservador y deliberado. La verdad la impone
 * `create_order_with_reservations` al confirmar, con `FOR UPDATE`.
 */
async function reservasAjenas(variantIds: string[]): Promise<Map<string, number>> {
  const mapa = new Map<string, number>();
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
