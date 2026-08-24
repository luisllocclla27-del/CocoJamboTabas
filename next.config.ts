import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const raizProyecto = dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  /**
   * Raíz del proyecto, fijada explícitamente.
   *
   * Sin esto, Turbopack sube por el árbol buscando un lockfile, encuentra uno en
   * `C:\Users\luisg` y toma el directorio personal como raíz, vigilando miles de
   * archivos ajenos. Ocurre porque el proyecto vive dentro de OneDrive\Documentos.
   */
  turbopack: { root: raizProyecto },

  images: {
    /**
     * Dominios permitidos para `next/image`.
     *
     * La lista es explícita a propósito: sin ella, cualquiera podría usar el
     * optimizador de imágenes del sitio como proxy para servir contenido ajeno,
     * consumiendo la cuota de transformaciones y prestando la reputación del
     * dominio a imágenes que no controlamos.
     *
     * `placehold.co` está aquí solo para el catálogo de ejemplo del seed. Al subir
     * fotos reales, se sirven desde Supabase Storage y esa entrada puede quitarse.
     */
    remotePatterns: [
      { protocol: "https", hostname: "placehold.co" },
      { protocol: "https", hostname: "*.supabase.co", pathname: "/storage/v1/object/public/**" },
    ],
  },
};

export default nextConfig;
