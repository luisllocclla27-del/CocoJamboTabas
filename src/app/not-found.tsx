import Link from "next/link";

/**
 * Página 404.
 *
 * El caso más frecuente no es un enlace roto genérico: es alguien que escribió mal
 * su código de seguimiento o abrió un enlace viejo de un producto retirado. Por eso
 * ofrece las dos salidas concretas en lugar de un "volver al inicio".
 */
export default function NotFound() {
  return (
    <div className="mx-auto max-w-lg px-4 py-24 text-center">
      <p className="titular text-6xl text-[var(--color-acento-oscuro)]">404</p>
      <h1 className="titular mt-2 text-3xl">Esta página no existe</h1>
      <p className="mt-3 text-[var(--color-gris)]">
        Puede que el enlace esté mal escrito, o que el producto ya no esté en el catálogo.
      </p>

      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <Link
          href="/catalogo"
          className="rounded-full bg-[var(--color-acento)] px-6 py-3 font-bold text-[var(--color-tinta)]"
        >
          Ver catálogo
        </Link>
        <Link
          href="/seguimiento"
          className="rounded-full border border-[var(--color-borde)] px-6 py-3 font-semibold"
        >
          Buscar mi pedido
        </Link>
      </div>

      <p className="mt-8 text-sm text-[var(--color-gris)]">
        Si llegaste acá buscando tu pedido, revisa que el código tenga la forma{" "}
        <span className="cifra font-semibold">COCO-7F3K2M</span>.
      </p>
    </div>
  );
}
