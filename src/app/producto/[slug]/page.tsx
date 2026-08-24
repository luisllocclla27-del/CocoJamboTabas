import type { Metadata } from "next";
import Image from "next/image";
import { notFound } from "next/navigation";
import { formatSoles } from "@/lib/money";
import { formatSizeTriple } from "@/lib/sizes";
import { isSupabaseConfigured } from "@/lib/env";
import { obtenerProducto } from "@/lib/supabase/catalog";
import { SelectorTalla } from "./selector-talla";

export const revalidate = 60;

type Props = { params: Promise<{ slug: string }> };

/**
 * Metadatos por producto, para que compartir el enlace por WhatsApp muestre la
 * foto, el modelo y el precio. En una tienda que vende por Instagram y WhatsApp,
 * la vista previa del enlace es parte del producto.
 */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  if (!isSupabaseConfigured()) return { title: "Producto" };
  const { slug } = await params;
  const producto = await obtenerProducto(slug);
  if (producto === null) return { title: "Producto no encontrado" };

  const titulo = `${producto.brand.nombre} ${producto.modelo} · ${producto.colorway}`;
  const imagen = producto.images[0];
  return {
    title: titulo,
    description:
      producto.descripcion ??
      `${titulo} originales, disponibles en Perú. Envíos a todo el país y pago con Yape.`,
    openGraph: {
      title: titulo,
      description: `${formatSoles(producto.price_cents)} · Envíos a todo el Perú`,
      images: imagen === undefined ? [] : [{ url: imagen.url, alt: imagen.alt }],
    },
  };
}

export default async function ProductoPage({ params }: Props) {
  if (!isSupabaseConfigured()) notFound();

  const { slug } = await params;
  const producto = await obtenerProducto(slug);
  if (producto === null) notFound();

  const hayStock = producto.variants.some((v) => v.disponible > 0);
  const enOferta =
    producto.compare_at_price_cents !== null &&
    producto.compare_at_price_cents > producto.price_cents;

  return (
    <article className="mx-auto max-w-6xl px-4 py-8">
      <div className="grid gap-10 lg:grid-cols-2">
        <Galeria imagenes={producto.images} nombre={`${producto.modelo} ${producto.colorway}`} />

        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.15em] text-[var(--color-gris)]">
            {producto.brand.nombre}
          </p>
          <h1 className="titular mt-1 text-4xl sm:text-5xl">{producto.modelo}</h1>
          <p className="mt-1 text-lg text-[var(--color-gris)]">{producto.colorway}</p>

          <div className="cifra mt-5 flex items-baseline gap-3">
            <span className="text-3xl font-bold">{formatSoles(producto.price_cents)}</span>
            {enOferta && (
              <span className="text-lg text-[var(--color-gris)] line-through">
                {formatSoles(producto.compare_at_price_cents!)}
              </span>
            )}
          </div>

          {!hayStock && (
            <p
              // `role="status"` para que el lector de pantalla anuncie el agotado
              // sin que el usuario tenga que buscarlo.
              role="status"
              className="mt-4 rounded-lg border border-[var(--color-borde)] bg-[var(--color-humo)] px-4 py-3 text-sm"
            >
              Agotado por ahora. Es un modelo de reposición constante: pide aviso y te escribimos
              cuando entre tu talla.
            </p>
          )}

          <SelectorTalla
            productoId={producto.id}
            slug={producto.slug}
            variantes={producto.variants.map((v) => ({
              id: v.id,
              sizeUs: Number(v.size_us),
              sizeEu: v.size_eu === null ? null : Number(v.size_eu),
              sizeCm: v.size_cm === null ? null : Number(v.size_cm),
              disponible: v.disponible,
            }))}
          />

          {producto.descripcion !== null && (
            <section className="mt-8">
              <h2 className="font-bold">Sobre este par</h2>
              <p className="mt-2 text-[var(--color-gris)]">{producto.descripcion}</p>
            </section>
          )}

          <Detalles producto={producto} />
        </div>
      </div>

      {/* Datos estructurados: hacen que Google muestre precio y disponibilidad en
          el resultado de búsqueda. En una tienda esto es tráfico directo. */}
      <script
        type="application/ld+json"
        // El contenido se serializa con JSON.stringify sobre datos propios de la
        // base, no sobre entrada del usuario.
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "Product",
            name: `${producto.brand.nombre} ${producto.modelo}`,
            color: producto.colorway,
            brand: { "@type": "Brand", name: producto.brand.nombre },
            description: producto.descripcion ?? undefined,
            image: producto.images.map((i) => i.url),
            offers: {
              "@type": "Offer",
              priceCurrency: "PEN",
              price: (producto.price_cents / 100).toFixed(2),
              availability: hayStock
                ? "https://schema.org/InStock"
                : "https://schema.org/OutOfStock",
              itemCondition: "https://schema.org/NewCondition",
            },
          }),
        }}
      />
    </article>
  );
}

/**
 * Galería.
 *
 * La primera imagen lleva `priority`: es el elemento más grande de la vista y
 * define el LCP de la página. Sin `priority`, Next la carga de forma diferida y
 * la métrica se degrada notablemente en móvil.
 */
function Galeria({
  imagenes,
  nombre,
}: {
  imagenes: Array<{ id: string; url: string; alt: string }>;
  nombre: string;
}) {
  if (imagenes.length === 0) {
    return (
      <div className="flex aspect-square items-center justify-center rounded-xl bg-[var(--color-humo)] text-[var(--color-gris)]">
        Sin fotos de {nombre}
      </div>
    );
  }

  const [principal, ...resto] = imagenes;
  return (
    <div>
      <div className="relative aspect-square overflow-hidden rounded-xl bg-[var(--color-humo)]">
        <Image
          src={principal.url}
          alt={principal.alt}
          fill
          priority
          sizes="(max-width: 1024px) 100vw, 50vw"
          className="object-cover"
        />
      </div>
      {resto.length > 0 && (
        <ul className="mt-3 grid grid-cols-4 gap-3">
          {resto.map((imagen) => (
            <li
              key={imagen.id}
              className="relative aspect-square overflow-hidden rounded-lg bg-[var(--color-humo)]"
            >
              <Image
                src={imagen.url}
                alt={imagen.alt}
                fill
                sizes="25vw"
                className="object-cover"
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Detalles del par.
 *
 * La nota de calce solo se muestra si el comerciante la escribió. No se genera
 * ninguna afirmación sobre cómo calza un modelo: un dato de calce inventado
 * produce devoluciones reales, y solo quien tiene el par en la mano puede
 * afirmarlo.
 */
function Detalles({
  producto,
}: {
  producto: {
    condicion: string;
    nota_calce: string | null;
    garantia_originalidad: string | null;
    variants: Array<{ size_us: number; size_eu: number | null; size_cm: number | null }>;
  };
}) {
  const conCalce =
    producto.nota_calce !== null &&
    producto.nota_calce.trim() !== "" &&
    // El seed deja una plantilla marcada para que el comerciante la complete; no
    // debe llegar al cliente tal cual.
    !producto.nota_calce.includes("EJEMPLO A COMPLETAR");

  const ejemplo = producto.variants.find((v) => v.size_eu !== null && v.size_cm !== null);

  return (
    <dl className="mt-8 space-y-4 border-t border-[var(--color-borde)] pt-6 text-sm">
      <div>
        <dt className="font-bold">Estado</dt>
        <dd className="mt-1 text-[var(--color-gris)]">
          {producto.condicion === "nuevo_en_caja" ? "Nuevo, en su caja original" : "Nuevo, sin caja"}
        </dd>
      </div>

      {producto.garantia_originalidad !== null && (
        <div>
          <dt className="font-bold">¿Son originales?</dt>
          <dd className="mt-1 text-[var(--color-gris)]">{producto.garantia_originalidad}</dd>
        </div>
      )}

      {conCalce && (
        <div>
          <dt className="font-bold">Cómo calza</dt>
          <dd className="mt-1 text-[var(--color-gris)]">{producto.nota_calce}</dd>
        </div>
      )}

      <div>
        <dt className="font-bold">Tallas</dt>
        <dd className="mt-1 text-[var(--color-gris)]">
          Mide tu pie en centímetros y elige por esa referencia: es el dato menos ambiguo.
          {ejemplo !== undefined && (
            <>
              {" "}
              Por ejemplo,{" "}
              <span className="cifra">
                {formatSizeTriple({
                  us: Number(ejemplo.size_us),
                  eu: Number(ejemplo.size_eu),
                  cm: Number(ejemplo.size_cm),
                })}
              </span>
              .
            </>
          )}
        </dd>
      </div>
    </dl>
  );
}
