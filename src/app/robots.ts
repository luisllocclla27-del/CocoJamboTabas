import type { MetadataRoute } from "next";

/**
 * robots.txt
 *
 * Las exclusiones no son sugerencias de SEO: son una medida de privacidad. Las
 * rutas de pago y seguimiento llevan la referencia del pedido en la URL, y si un
 * buscador las indexara quedarían expuestas a cualquiera que busque. Aunque esas
 * páginas ya envían `robots: noindex` en sus metadatos, esto evita incluso el
 * rastreo.
 *
 * `/admin` va fuera por lo mismo, más el detalle de no anunciar dónde está el panel.
 */
export default function robots(): MetadataRoute.Robots {
  const base = (process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000").replace(/\/+$/, "");

  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/admin", "/carrito", "/checkout", "/pago/", "/seguimiento/", "/api/", "/diagnostico"],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
  };
}
