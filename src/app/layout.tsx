import type { Metadata } from "next";
import { Anton, Inter } from "next/font/google";
import Link from "next/link";
import { BotonWhatsAppFlotante } from "@/components/boton-whatsapp-flotante";
import { Encabezado } from "@/components/encabezado";
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
    default: "Coco Jambo · Zapatillas y ropa urbana second hand en Perú",
    template: "%s · Coco Jambo",
  },
  description:
    "Zapatillas originales y ropa urbana second hand en Perú. Converse, Vans, New Balance, poleras y vintage. Envíos a todo el país y pago con Yape.",
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
    <html lang="es-PE">
      <body className={`${anton.variable} ${inter.variable} antialiased`}>
        <a
          href="#contenido"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-[var(--color-acento)] focus:px-4 focus:py-2 focus:font-semibold focus:text-[var(--color-tinta)]"
        >
          Saltar al contenido
        </a>
        <Encabezado />
        <main id="contenido">{children}</main>
        <PieDePagina />
        <BotonWhatsAppFlotante numeroWhatsapp={process.env.WHATSAPP_NUMERO ?? "935502420"} />
      </body>
    </html>
  );
}

function PieDePagina() {
  return (
    <footer className="mt-20 border-t border-[var(--color-borde)] bg-[var(--color-humo)]">
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-12 sm:grid-cols-3">
        <div>
          <p className="titular text-xl">COCO JAMBO</p>
          <p className="mt-2 text-sm text-[var(--color-gris)]">
            Zapatillas originales y ropa urbana second hand. Piezas únicas con fotos 100% reales.
          </p>
          <div className="mt-4 flex flex-col gap-1.5 text-xs text-[var(--color-gris)]">
            <p className="font-semibold text-[var(--color-tinta)]">Atención directa:</p>
            <a
              href="https://wa.me/51935502420?text=Hola%20Coco%20Jambo%2C%20tengo%20una%20consulta"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[#128C7E] font-bold hover:underline"
            >
              📱 WhatsApp: 935 502 420
            </a>
            <a
              href="https://chat.whatsapp.com/ESkzHNItHLzIHzl07psBWj"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-[var(--color-tinta)] hover:underline"
            >
              💬 Grupo de WhatsApp (Ingresos diarios) ↗
            </a>
          </div>
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
              <Link href="/catalogo?q=zapatillas" className="hover:text-[var(--color-tinta)]">
                Zapatillas
              </Link>
            </li>
            <li>
              <Link href="/catalogo?q=ropa" className="hover:text-[var(--color-tinta)]">
                Ropa second hand
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
            Elige tu prenda o par único, paga con Yape y validamos tu comprobante. Te avisamos por WhatsApp en
            cuanto tu paquete sale por Olva o Shalom.
          </p>
        </div>
      </div>
      <div className="border-t border-[var(--color-borde)] px-4 py-6 text-center text-xs text-[var(--color-gris)]">
        © 2025 Coco Jambo · Moda urbana y second hand en Perú.
      </div>
    </footer>
  );
}
