import type { MetadataRoute } from "next";
import { isSupabaseConfigured } from "@/lib/env";
import { listarCatalogo, listarMarcas } from "@/lib/supabase/catalog";

/**
 * Sitemap.
 *
 * Incluye solo lo que tiene sentido indexar: home, catálogo, filtros por marca,
 * guía de tallas y las fichas de producto activas.
 *
 * Se excluyen a propósito el carrito, el checkout, las páginas de pago, el
 * seguimiento y todo `/admin`. No es solo que no aporten SEO: una URL de
 * seguimiento en el sitemap expondría referencias de pedidos reales a cualquiera
 * que lo lea.
 */
export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = (process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  const ahora = new Date();

  const estaticas: MetadataRoute.Sitemap = [
    { url: `${base}/`, lastModified: ahora, changeFrequency: "daily", priority: 1 },
    { url: `${base}/catalogo`, lastModified: ahora, changeFrequency: "daily", priority: 0.9 },
    {
      url: `${base}/guia-de-tallas`,
      lastModified: ahora,
      changeFrequency: "yearly",
      priority: 0.4,
    },
  ];

  // Sin base de datos el sitemap se limita a las rutas estáticas en vez de fallar:
  // un sitemap que devuelve 500 hace que el buscador deje de pedirlo.
  if (!isSupabaseConfigured()) return estaticas;

  try {
    const [productos, marcas] = await Promise.all([listarCatalogo(), listarMarcas()]);

    return [
      ...estaticas,
      ...marcas.map((marca) => ({
        url: `${base}/catalogo?marca=${marca.slug}`,
        lastModified: ahora,
        changeFrequency: "weekly" as const,
        priority: 0.6,
      })),
      ...productos.map((producto) => ({
        url: `${base}/producto/${producto.slug}`,
        lastModified: ahora,
        changeFrequency: "weekly" as const,
        // Los productos con stock pesan más: enviar tráfico a una ficha agotada
        // gasta presupuesto de rastreo y decepciona a quien llega.
        priority: producto.tallasDisponibles.length > 0 ? 0.8 : 0.5,
      })),
    ];
  } catch {
    return estaticas;
  }
}
