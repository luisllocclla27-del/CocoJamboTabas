import Image from "next/image";
import Link from "next/link";
import { formatSoles } from "@/lib/money";
import type { TarjetaProducto } from "@/lib/supabase/catalog";

/**
 * Tarjeta de catálogo.
 *
 * Dos decisiones que afectan a la conversión:
 *
 * 1. Las tallas disponibles se muestran EN la tarjeta. En una tienda de
 *    zapatillas la pregunta no es "¿me gusta?" sino "¿está en mi talla?".
 *    Obligar a entrar al producto para descubrir que no está es la primera causa
 *    de abandono.
 *
 * 2. Un producto agotado se muestra, atenuado y sin enlace de compra, en vez de
 *    ocultarse. Un modelo clásico vuelve a entrar, y la lista de espera solo
 *    funciona si el cliente puede verlo y pedir aviso.
 */
export function TarjetaProductoCard({ producto }: { producto: TarjetaProducto }) {
  const agotado = producto.tallasDisponibles.length === 0;
  const enOferta =
    producto.compareAtPriceCents !== null && producto.compareAtPriceCents > producto.priceCents;

  return (
    <article className="group relative">
      <Link
        href={`/producto/${producto.slug}`}
        className="block focus-visible:outline-offset-4"
        // El `aria-label` da al lector de pantalla el contexto completo del
        // enlace; sin él anunciaría solo "Chuck Taylor" sin marca ni precio.
        aria-label={`${producto.marca} ${producto.modelo}, ${producto.colorway}, ${formatSoles(producto.priceCents)}${agotado ? ", agotado" : ""}`}
      >
        <div className="relative aspect-square overflow-hidden rounded-lg bg-[var(--color-humo)]">
          {producto.imagen !== null ? (
            <Image
              src={producto.imagen.url}
              alt={producto.imagen.alt}
              fill
              // `sizes` evita que el navegador descargue la imagen a tamaño
              // completo en móvil, donde ocupa media pantalla.
              sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
              className={`object-cover transition duration-300 group-hover:scale-[1.03] ${
                agotado ? "opacity-40 grayscale" : ""
              }`}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-[var(--color-gris)]">
              Sin foto
            </div>
          )}

          {agotado && (
            <span className="absolute left-3 top-3 rounded-full bg-[var(--color-tinta)] px-3 py-1 text-xs font-semibold uppercase text-[var(--color-papel)]">
              Agotado
            </span>
          )}
          {!agotado && enOferta && (
            <span className="absolute left-3 top-3 rounded-full bg-[var(--color-acento)] px-3 py-1 text-xs font-bold uppercase text-[var(--color-tinta)]">
              Oferta
            </span>
          )}
          {!agotado && !enOferta && producto.tallasDisponibles.length === 1 && (
            <span className="absolute left-3 top-3 rounded-full bg-[var(--color-aviso)] px-3 py-1 text-xs font-bold uppercase text-white shadow-xs">
              ⚡ Último
            </span>
          )}
        </div>

        <div className="mt-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-gris)]">
            {producto.marca}
          </p>
          <h3 className="mt-0.5 font-semibold leading-tight">{producto.modelo}</h3>
          <p className="text-sm text-[var(--color-gris)]">{producto.colorway}</p>

          <p className="cifra mt-2 flex items-baseline gap-2">
            <span className="font-bold">{formatSoles(producto.priceCents)}</span>
            {enOferta && (
              <span className="text-sm text-[var(--color-gris)] line-through">
                {formatSoles(producto.compareAtPriceCents!)}
              </span>
            )}
          </p>
        </div>
      </Link>

      <TallasEnTarjeta tallas={producto.tallasDisponibles} />
    </article>
  );
}

/**
 * Tallas disponibles, resumidas.
 *
 * Se muestran hasta 6 y se indica el resto con "+N": la retícula del catálogo no
 * aguanta 12 chips sin descolocar las tarjetas vecinas, y el objetivo aquí es
 * responder de un vistazo si está la talla del cliente.
 */
function TallasEnTarjeta({ tallas }: { tallas: number[] }) {
  if (tallas.length === 0) {
    return (
      <p className="mt-2 text-xs text-[var(--color-gris)]">
        Sin stock ahora · puedes pedir aviso de reposición
      </p>
    );
  }

  const visibles = tallas.slice(0, 6);
  const resto = tallas.length - visibles.length;

  return (
    <div className="mt-2">
      <p className="solo-lectores">Tallas US disponibles: {tallas.join(", ")}</p>
      <ul aria-hidden="true" className="flex flex-wrap gap-1">
        {visibles.map((talla) => (
          <li
            key={talla}
            className="cifra rounded border border-[var(--color-borde)] px-1.5 py-0.5 text-xs text-[var(--color-gris)]"
          >
            {formatearTalla(talla)}
          </li>
        ))}
        {resto > 0 && (
          <li className="px-1.5 py-0.5 text-xs text-[var(--color-gris)]">+{resto}</li>
        )}
      </ul>
    </div>
  );
}

/** 9 -> "9", 9.5 -> "9.5". Sin ceros de más, que ensucian una fila de chips. */
function formatearTalla(valor: number): string {
  return Number.isInteger(valor) ? String(valor) : valor.toFixed(1);
}
