import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { formatSoles, percentOf } from "@/lib/money";
import { isSupabaseConfigured } from "@/lib/env";
import { leerCarrito } from "@/lib/cart/actions";
import { resolverCarrito } from "@/lib/cart/resolve";
import { CONFIG_ENVIO_DEFECTO } from "@/lib/shipping/quote";
import { DESCUENTO_YAPE_PCT, RESERVA_MINUTOS } from "@/lib/orders/config";
import { FormularioCheckout } from "./formulario";

export const metadata: Metadata = {
  title: "Finalizar compra",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function CheckoutPage() {
  if (!isSupabaseConfigured()) redirect("/");

  const carrito = await resolverCarrito(await leerCarrito());

  // Un checkout sin carrito no tiene nada que hacer: se devuelve al catálogo en
  // vez de mostrar un formulario que no puede completarse.
  if (carrito.lineas.length === 0) redirect("/catalogo");
  if (carrito.hayProblemas) redirect("/carrito");

  const descuentoCents = percentOf(carrito.subtotalCents, DESCUENTO_YAPE_PCT);

  return (
    <div className="mx-auto max-w-5xl px-4 py-10">
      <nav aria-label="Progreso" className="text-sm text-[var(--color-gris)]">
        <Link href="/carrito" className="underline underline-offset-4">
          Carrito
        </Link>
        <span aria-hidden="true"> → </span>
        <span aria-current="step" className="font-semibold text-[var(--color-tinta)]">
          Tus datos
        </span>
        <span aria-hidden="true"> → </span>
        <span>Pago</span>
      </nav>

      <h1 className="titular mt-3 text-4xl">Finalizar compra</h1>

      <div className="mt-8 grid gap-10 lg:grid-cols-[1fr_20rem]">
        <FormularioCheckout
          subtotalCents={carrito.subtotalCents}
          descuentoCents={descuentoCents}
          config={{
            zonasLima: CONFIG_ENVIO_DEFECTO.zonasLima.map((z) => ({
              nombre: z.nombre,
              costoCents: z.costoCents,
              plazo: z.plazo,
              distritos: [...z.distritos],
            })),
            limaFallbackCents: CONFIG_ENVIO_DEFECTO.limaFallback.costoCents,
            provinciaCents: CONFIG_ENVIO_DEFECTO.provinciaEstimadoCents,
            umbralEnvioGratisCents: CONFIG_ENVIO_DEFECTO.umbralEnvioGratisCents,
            envioGratisAplicaProvincia: CONFIG_ENVIO_DEFECTO.envioGratisAplicaProvincia,
          }}
        />

        <aside className="lg:sticky lg:top-24 lg:self-start">
          <div className="rounded-xl border border-[var(--color-borde)] p-5">
            <h2 className="font-bold">Tu pedido</h2>

            <ul className="mt-4 space-y-3 text-sm">
              {carrito.lineas.map((linea) => (
                <li key={linea.variantId} className="flex justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{linea.modelo}</span>
                    <span className="cifra text-xs text-[var(--color-gris)]">
                      Talla US {formatearTalla(linea.sizeUs)} × {linea.cantidad}
                    </span>
                  </span>
                  <span className="cifra shrink-0">{formatSoles(linea.subtotalCents)}</span>
                </li>
              ))}
            </ul>

            <dl className="mt-4 space-y-2 border-t border-[var(--color-borde)] pt-4 text-sm">
              <div className="flex justify-between">
                <dt className="text-[var(--color-gris)]">Productos</dt>
                <dd className="cifra">{formatSoles(carrito.subtotalCents)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-[var(--color-exito)]">
                  Descuento por Yape ({DESCUENTO_YAPE_PCT}%)
                </dt>
                <dd className="cifra text-[var(--color-exito)]">−{formatSoles(descuentoCents)}</dd>
              </div>
            </dl>

            <p className="mt-4 rounded-lg bg-[var(--color-humo)] px-3 py-2 text-xs text-[var(--color-gris)]">
              Al confirmar, tus tallas quedan reservadas {RESERVA_MINUTOS} minutos para que completes
              el pago.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}

function formatearTalla(valor: number): string {
  return Number.isInteger(valor) ? String(valor) : valor.toFixed(1);
}
