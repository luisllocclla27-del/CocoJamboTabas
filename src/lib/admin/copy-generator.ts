import { formatSoles } from "@/lib/money";

export type DatosProductoCopy = {
  marca: string;
  modelo: string;
  colorway: string;
  priceCents: number;
  compareAtPriceCents?: number | null;
  tallas: Array<{ sizeUs: number; stock: number }>;
  slug: string;
  baseUrl?: string;
};

/**
 * Formatea una talla US como número entero o con un decimal.
 */
function formatTallaUs(sizeUs: number): string {
  return Number.isInteger(sizeUs) ? String(sizeUs) : sizeUs.toFixed(1);
}

/**
 * Genera el texto publicitario estructurado listo para copiar y pegar en grupos de WhatsApp o canales de difusión.
 */
export function generarTextoWhatsApp(producto: DatosProductoCopy): string {
  const base = producto.baseUrl ?? process.env.NEXT_PUBLIC_SITE_URL ?? "https://coco-jambo-tabas.vercel.app";
  const urlLimpia = base.replace(/\/$/, "");
  const linkProducto = `${urlLimpia}/producto/${producto.slug}`;

  const tallasDisponibles = producto.tallas
    .filter((t) => t.stock > 0)
    .sort((a, b) => a.sizeUs - b.sizeUs)
    .map((t) => formatTallaUs(t.sizeUs));

  const textoTallas =
    tallasDisponibles.length > 0
      ? `US ${tallasDisponibles.join(" · ")}`
      : "Agotado temporalmente (pide aviso de reposición en la web)";

  const precioTexto = formatSoles(producto.priceCents);
  const oferta =
    producto.compareAtPriceCents && producto.compareAtPriceCents > producto.priceCents
      ? ` (Antes ~${formatSoles(producto.compareAtPriceCents)}~)`
      : "";

  return [
    `🔥 *${producto.marca.toUpperCase()} ${producto.modelo.toUpperCase()}*`,
    `🎨 Color: *${producto.colorway}*`,
    `👟 *Tallas disponibles:* ${textoTallas}`,
    `💰 *Precio:* ${precioTexto}${oferta}`,
    `🚚 *Envíos:* A todo el Perú (Lima a domicilio · Provincias por Shalom)`,
    `⚡ *100% Originales garantizadas*`,
    `👉 *Asegura tu par en 1 clic aquí:*`,
    `${linkProducto}`,
  ].join("\n");
}

/**
 * Genera la URL optimizada para usar en el sticker de enlace de Historias de Instagram o Link en Bio.
 */
export function generarEnlaceHistoriaIG(slug: string, baseUrl?: string): string {
  const base = baseUrl ?? process.env.NEXT_PUBLIC_SITE_URL ?? "https://coco-jambo-tabas.vercel.app";
  const urlLimpia = base.replace(/\/$/, "");
  return `${urlLimpia}/producto/${slug}?utm_source=instagram&utm_medium=stories`;
}
