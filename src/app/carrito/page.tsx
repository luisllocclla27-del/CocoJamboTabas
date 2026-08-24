import type { Metadata } from "next";
import Link from "next/link";
import { formatSoles } from "@/lib/money";
import { isSupabaseConfigured } from "@/lib/env";
import { leerCarrito } from "@/lib/cart/actions";
import { resolverCarrito } from "@/lib/cart/resolve";
import { calcularCotizacion, faltaParaEnvioGratis } from "@/lib/shipping/quote";
import { LineasCarrito } from "./lineas";

export const metadata: Metadata = {
  title: "Tu carrito",
  // El carrito no debe indexarse: es contenido por visitante y sin valor de
  // búsqueda.
  robots: { index: false, follow: false },
};

/**
 * `force-dynamic` porque el carrito depende de una cookie y del stock actual.
 * Cachearlo mostraría a un cliente el carrito de otro, que es el peor fallo
 * posible en una tienda.
 */
export const dynamic = "force-dynamic";

export default async function CarritoPage() {
  if (!isSupabaseConfigured()) {
    return (
      <Vacio titulo="Falta conectar Supabase" texto="Configura las variables de entorno." />
    );
  }

  const carrito = await resolverCarrito(await leerCarrito());

  if (carrito.lineas.length === 0) {
    return (
      <Vacio
        titulo="Tu carrito está vacío"
        texto="Elige tus zapatillas y vuelve por acá para completar el pedido."
      />
    );
  }

  const falta = faltaParaEnvioGratis(carrito.subtotalCents);
  // Se muestra el costo de Lima como referencia: el definitivo depende del
  // distrito o la agencia, que se eligen en el checkout. Prometer aquí un total
  // exacto obligaría a corregirlo después, que es peor que no darlo.
  const envioReferencia = calcularCotizacion({
    destino: { modo: "lima_domicilio", distrito: "" },
    subtotalCents: carrito.subtotalCents,
  });

  return (
    <div className="mx-auto max-w-5xl px-4 py-10">
      <h1 className="titular text-4xl">Tu carrito</h1>
      <p className="mt-1 text-[var(--color-gris)]">
        {carrito.unidades === 1 ? "1 par" : `${carrito.unidades} pares`}
      </p>

      {carrito.hayProblemas && (
        <p
          role="alert"
          className="mt-6 rounded-lg border border-[var(--color-alerta)] bg-[var(--color-alerta)]/5 px-4 py-3 text-sm"
        >
          Alguna talla se quedó sin stock mientras completabas tu compra. Ajusta las cantidades
          marcadas para continuar.
        </p>
      )}

      <div className="mt-8 grid gap-10 lg:grid-cols-[1fr_20rem]">
        <LineasCarrito lineas={carrito.lineas} />

        <aside className="lg:sticky lg:top-24 lg:self-start">
          <div className="rounded-xl border border-[var(--color-borde)] p-5">
            <h2 className="font-bold">Resumen</h2>

            <dl className="mt-4 space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-[var(--color-gris)]">Productos</dt>
                <dd className="cifra font-semibold">{formatSoles(carrito.subtotalCents)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-[var(--color-gris)]">Envío</dt>
                <dd className="cifra">
                  {envioReferencia.gratis ? (
                    <span className="font-semibold text-[var(--color-exito)]">Gratis</span>
                  ) : (
                    <span className="text-[var(--color-gris)]">Se calcula al elegir entrega</span>
                  )}
                </dd>
              </div>
            </dl>

            {falta !== null && (
              <p className="mt-4 rounded-lg bg-[var(--color-humo)] px-3 py-2 text-xs">
                Te faltan <span className="cifra font-semibold">{formatSoles(falta)}</span> para el
                envío gratis en Lima.
              </p>
            )}

            <div className="mt-4 flex justify-between border-t border-[var(--color-borde)] pt-4">
              <span className="font-bold">Total estimado</span>
              <span className="cifra text-lg font-bold">{formatSoles(carrito.subtotalCents)}</span>
            </div>
            <p className="mt-1 text-xs text-[var(--color-gris)]">
              El envío y el descuento por Yape se aplican en el siguiente paso.
            </p>

            {carrito.hayProblemas ? (
              <p className="mt-5 rounded-full bg-[var(--color-humo)] px-6 py-3 text-center text-sm font-semibold text-[var(--color-gris)]">
                Ajusta las cantidades para continuar
              </p>
            ) : (
              <Link
                href="/checkout"
                className="mt-5 block rounded-full bg-[var(--color-acento)] px-6 py-3.5 text-center font-bold text-[var(--color-tinta)] transition hover:bg-[var(--color-acento-oscuro)]"
              >
                Continuar
              </Link>
            )}

            <Link
              href="/catalogo"
              className="mt-3 block text-center text-sm underline underline-offset-4"
            >
              Seguir viendo
            </Link>
          </div>
        </aside>
      </div>
    </div>
  );
}

function Vacio({ titulo, texto }: { titulo: string; texto: string }) {
  return (
    <div className="mx-auto max-w-xl px-4 py-24 text-center">
      <h1 className="titular text-3xl">{titulo}</h1>
      <p className="mt-3 text-[var(--color-gris)]">{texto}</p>
      <Link
        href="/catalogo"
        className="mt-8 inline-block rounded-full bg-[var(--color-tinta)] px-6 py-3 font-semibold text-[var(--color-papel)]"
      >
        Ver catálogo
      </Link>
    </div>
  );
}
