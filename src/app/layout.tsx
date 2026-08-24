import type { Metadata } from "next";
import { Anton, Inter } from "next/font/google";
import Link from "next/link";
import "./globals.css";

/**
 * Anton para titulares (comprimida, con el peso del cartelismo urbano) e Inter
 * para el texto. Se cargan con `next/font`, que las autohospeda: sin petición a
 * Google en tiempo de ejecución y sin salto de texto al cargar.
 */
const anton = Anton({
  weight: "400",
  variable: "--font-anton",
  subsets: ["latin"],
  display: "swap",
});

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

/**
 * `metadataBase` es necesaria para que las URLs de Open Graph sean absolutas.
 * Sin ella, al compartir un producto por WhatsApp la vista previa no carga la
 * imagen, y WhatsApp es el canal principal de esta tienda.
 */
export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"),
  title: {
    default: "Coco Jambo · Zapatillas urbanas originales en Perú",
    template: "%s · Coco Jambo",
  },
  description:
    "Converse, Vans, New Balance y Adidas originales. Envíos a todo el Perú, pago con Yape y stock real por talla.",
  openGraph: {
    type: "website",
    locale: "es_PE",
    siteName: "Coco Jambo",
  },
  robots: { index: true, follow: true },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    // `lang="es-PE"` no es cosmético: define la pronunciación del lector de
    // pantalla y la separación de sílabas.
    <html lang="es-PE">
      <body className={`${anton.variable} ${inter.variable} antialiased`}>
        {/* Salto al contenido: lo primero que encuentra quien navega con teclado,
            para no recorrer todo el menú en cada página. */}
        <a
          href="#contenido"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-[var(--color-acento)] focus:px-4 focus:py-2 focus:font-semibold focus:text-[var(--color-tinta)]"
        >
          Saltar al contenido
        </a>
        <Encabezado />
        <main id="contenido">{children}</main>
        <PieDePagina />
      </body>
    </html>
  );
}

function Encabezado() {
  return (
    <header className="sticky top-0 z-40 border-b border-[var(--color-borde)] bg-[var(--color-papel)]/95 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4">
        <Link href="/" className="titular text-2xl tracking-tight">
          COCO<span className="text-[var(--color-acento-oscuro)]">JAMBO</span>
        </Link>

        <nav aria-label="Navegación principal" className="hidden gap-6 text-sm font-medium sm:flex">
          <Link href="/catalogo" className="hover:text-[var(--color-gris)]">
            Catálogo
          </Link>
          <Link href="/catalogo?marca=converse" className="hover:text-[var(--color-gris)]">
            Converse
          </Link>
          <Link href="/catalogo?marca=vans" className="hover:text-[var(--color-gris)]">
            Vans
          </Link>
          <Link href="/seguimiento" className="hover:text-[var(--color-gris)]">
            Seguir pedido
          </Link>
        </nav>

        <Link
          href="/carrito"
          className="rounded-full bg-[var(--color-tinta)] px-4 py-2 text-sm font-semibold text-[var(--color-papel)] transition hover:bg-[var(--color-tinta-suave)]"
        >
          Carrito
        </Link>
      </div>
    </header>
  );
}

function PieDePagina() {
  return (
    <footer className="mt-20 border-t border-[var(--color-borde)] bg-[var(--color-humo)]">
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-12 sm:grid-cols-3">
        <div>
          <p className="titular text-xl">COCO JAMBO</p>
          <p className="mt-2 text-sm text-[var(--color-gris)]">
            Zapatillas urbanas originales. Envíos a todo el Perú.
          </p>
        </div>
        <nav aria-label="Enlaces del pie">
          <h2 className="text-sm font-semibold uppercase tracking-wide">Tienda</h2>
          <ul className="mt-3 space-y-2 text-sm text-[var(--color-gris)]">
            <li>
              <Link href="/catalogo" className="hover:text-[var(--color-tinta)]">
                Ver todo el catálogo
              </Link>
            </li>
            <li>
              <Link href="/seguimiento" className="hover:text-[var(--color-tinta)]">
                Seguir mi pedido
              </Link>
            </li>
            <li>
              <Link href="/guia-de-tallas" className="hover:text-[var(--color-tinta)]">
                Guía de tallas
              </Link>
            </li>
          </ul>
        </nav>
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide">Cómo comprar</h2>
          <p className="mt-3 text-sm text-[var(--color-gris)]">
            Elige tu talla, paga con Yape y validamos tu comprobante. Te avisamos por WhatsApp en
            cuanto tu pedido sale.
          </p>
        </div>
      </div>
      <div className="border-t border-[var(--color-borde)] px-4 py-6 text-center text-xs text-[var(--color-gris)]">
        Proyecto de demostración. Los productos y precios son datos de ejemplo.
      </div>
    </footer>
  );
}
