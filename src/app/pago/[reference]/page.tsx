import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { formatSoles, splitSoles } from "@/lib/money";
import { isSupabaseConfigured } from "@/lib/env";
import { obtenerPedidoPublico, reservaVigente } from "@/lib/orders/read";
import { FormularioComprobante } from "./formulario";
import { Contador } from "./contador";

export const metadata: Metadata = {
  title: "Completa tu pago",
  // Un pedido concreto no debe indexarse: la referencia es la credencial de
  // acceso y no tiene ningún valor de búsqueda.
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * Pantalla de pago con Yape.
 *
 * Todo el diseño gira alrededor de una idea: el cliente debe yapear el monto
 * EXACTO, con sus céntimos. Esos céntimos son lo que identifica su pago entre los
 * demás, así que la interfaz los resalta en lugar de esconderlos en un total
 * cualquiera. Si el cliente redondea, el pago no se puede casar automáticamente y
 * alguien tiene que revisarlo a mano.
 */
export default async function PagoPage({
  params,
}: {
  params: Promise<{ reference: string }>;
}) {
  if (!isSupabaseConfigured()) notFound();

  const { reference } = await params;
  const pedido = await obtenerPedidoPublico(reference, await headers());
  if (pedido === null) notFound();

  // Un pedido que ya pasó de pago no debe mostrar el número de Yape: llevaría a
  // pagar dos veces.
  if (pedido.status !== "pendiente_pago" && pedido.status !== "rechazado") {
    return <YaPagado pedido={pedido} />;
  }

  const vigente = reservaVigente(pedido);
  if (!vigente) return <ReservaExpirada pedido={pedido} />;

  const numeroYape = process.env.YAPE_NUMERO ?? "";
  const titularYape = process.env.YAPE_TITULAR ?? "";
  const monto = splitSoles(pedido.totalCents);

  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <p className="text-sm text-[var(--color-gris)]">
        Pedido <span className="cifra font-semibold">{pedido.reference}</span>
      </p>
      <h1 className="titular mt-1 text-4xl">
        {pedido.nombreCliente}, falta un paso
      </h1>

      {pedido.status === "rechazado" && pedido.pago?.motivoRechazo !== null && (
        <p
          role="alert"
          className="mt-5 rounded-lg border border-[var(--color-alerta)] bg-[var(--color-alerta)]/5 px-4 py-3 text-sm"
        >
          <span className="font-semibold">No pudimos validar tu pago anterior.</span>{" "}
          {pedido.pago?.motivoRechazo} Puedes enviar un comprobante nuevo.
        </p>
      )}

      {pedido.reservaHasta !== null && <Contador hasta={pedido.reservaHasta} />}

      <section className="mt-6 rounded-2xl border-2 border-[var(--color-tinta)] p-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-[var(--color-gris)]">
          Yapea este monto exacto
        </h2>

        {/* El monto es lo más grande de la pantalla y los céntimos van
            destacados: son la parte que la gente redondea por costumbre. */}
        <p className="cifra mt-2 flex items-baseline gap-1 font-bold leading-none">
          <span className="text-2xl">S/</span>
          <span className="text-6xl">{monto.soles}</span>
          <span className="text-6xl text-[var(--color-acento-oscuro)]">.{monto.centimos}</span>
        </p>

        <p className="mt-4 rounded-lg bg-[var(--color-humo)] px-4 py-3 text-sm">
          <span className="font-semibold">Los céntimos importan.</span> Ese{" "}
          <span className="cifra font-semibold">.{monto.centimos}</span> es lo que nos permite
          reconocer tu pago entre todos los demás. Si redondeas, tu pedido se retrasa.
        </p>

        <dl className="mt-5 space-y-3 border-t border-[var(--color-borde)] pt-5 text-sm">
          <div>
            <dt className="text-[var(--color-gris)]">Número de Yape</dt>
            <dd className="cifra text-2xl font-bold">
              {numeroYape === "" ? (
                <span className="text-base font-normal text-[var(--color-alerta)]">
                  Falta configurar YAPE_NUMERO en el servidor.
                </span>
              ) : (
                numeroYape
              )}
            </dd>
          </div>
          {titularYape !== "" && (
            <div>
              <dt className="text-[var(--color-gris)]">A nombre de</dt>
              <dd className="font-semibold">{titularYape}</dd>
            </div>
          )}
        </dl>
      </section>

      <FormularioComprobante reference={pedido.reference} totalCents={pedido.totalCents} />

      <section className="mt-10">
        <h2 className="font-bold">Tu pedido</h2>
        <ul className="mt-3 divide-y divide-[var(--color-borde)] text-sm">
          {pedido.items.map((item, i) => (
            <li key={i} className="flex justify-between gap-3 py-2.5">
              <span>
                <span className="block font-medium">{item.modelo}</span>
                <span className="cifra text-xs text-[var(--color-gris)]">
                  {item.colorway} · Talla US {formatearTalla(item.sizeUs)} × {item.cantidad}
                </span>
              </span>
              <span className="cifra shrink-0">
                {formatSoles(item.unitPriceCents * item.cantidad)}
              </span>
            </li>
          ))}
        </ul>

        <dl className="mt-4 space-y-1.5 border-t border-[var(--color-borde)] pt-4 text-sm">
          <Fila etiqueta="Productos" valor={formatSoles(pedido.subtotalCents)} />
          {pedido.discountCents > 0 && (
            <Fila
              etiqueta="Descuento por Yape"
              valor={`−${formatSoles(pedido.discountCents)}`}
              resaltado
            />
          )}
          <Fila
            etiqueta="Envío"
            valor={pedido.shippingCents === 0 ? "Gratis" : formatSoles(pedido.shippingCents)}
          />
          <div className="flex justify-between border-t border-[var(--color-borde)] pt-2 font-bold">
            <dt>Total a yapear</dt>
            <dd className="cifra">{formatSoles(pedido.totalCents)}</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}

function Fila({
  etiqueta,
  valor,
  resaltado = false,
}: {
  etiqueta: string;
  valor: string;
  resaltado?: boolean;
}) {
  return (
    <div className={`flex justify-between ${resaltado ? "text-[var(--color-exito)]" : ""}`}>
      <dt className={resaltado ? "" : "text-[var(--color-gris)]"}>{etiqueta}</dt>
      <dd className="cifra">{valor}</dd>
    </div>
  );
}

function YaPagado({ pedido }: { pedido: { reference: string; status: string } }) {
  return (
    <div className="mx-auto max-w-xl px-4 py-20 text-center">
      <h1 className="titular text-3xl">
        {pedido.status === "comprobante_enviado"
          ? "Ya recibimos tu comprobante"
          : "Este pedido ya está pagado"}
      </h1>
      <p className="mt-3 text-[var(--color-gris)]">
        {pedido.status === "comprobante_enviado"
          ? "Lo estamos validando. Te escribimos por WhatsApp en cuanto lo confirmemos."
          : "No necesitas volver a pagar."}
      </p>
      <Link
        href={`/seguimiento/${pedido.reference}`}
        className="mt-8 inline-block rounded-full bg-[var(--color-tinta)] px-6 py-3 font-semibold text-[var(--color-papel)]"
      >
        Ver estado de mi pedido
      </Link>
    </div>
  );
}

/**
 * Reserva expirada.
 *
 * No se permite pagar: el stock ya volvió a estar disponible para otros y cobrar
 * ahora podría dejar al cliente pagado y sin par, que es el peor resultado
 * posible. Se le invita a rehacer el pedido.
 */
function ReservaExpirada({ pedido }: { pedido: { reference: string } }) {
  return (
    <div className="mx-auto max-w-xl px-4 py-20 text-center">
      <h1 className="titular text-3xl">Se venció el tiempo de reserva</h1>
      <p className="mt-3 text-[var(--color-gris)]">
        Liberamos tus tallas para que otras personas pudieran comprarlas. Si todavía las quieres,
        arma el pedido de nuevo: toma menos de un minuto.
      </p>
      <p className="cifra mt-2 text-xs text-[var(--color-gris)]">
        Pedido {pedido.reference}
      </p>
      <Link
        href="/catalogo"
        className="mt-8 inline-block rounded-full bg-[var(--color-acento)] px-6 py-3 font-bold text-[var(--color-tinta)]"
      >
        Volver al catálogo
      </Link>
    </div>
  );
}

function formatearTalla(valor: number): string {
  return Number.isInteger(valor) ? String(valor) : valor.toFixed(1);
}
