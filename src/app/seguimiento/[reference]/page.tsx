import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { formatSoles } from "@/lib/money";
import { ETIQUETA_CLIENTE, LINEA_TIEMPO, type OrderStatus } from "@/lib/order-status";
import { isSupabaseConfigured } from "@/lib/env";
import { obtenerPedidoPublico, type PedidoPublico } from "@/lib/orders/read";

export const metadata: Metadata = {
  title: "Estado de tu pedido",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * Seguimiento del pedido.
 *
 * Sin cuenta de usuario: la referencia es la credencial. Esa decisión reduce la
 * fricción a cero (nadie se registra para comprar un par de zapatillas), y por eso
 * la referencia tiene 28^6 combinaciones y no es secuencial.
 *
 * Lo que se muestra está deliberadamente limitado: nunca el voucher, ni el número
 * de operación, ni los datos personales más allá del nombre de pila. Ver
 * `orders/read.ts`.
 */
export default async function SeguimientoPedidoPage({
  params,
}: {
  params: Promise<{ reference: string }>;
}) {
  if (!isSupabaseConfigured()) notFound();

  const { reference } = await params;
  const pedido = await obtenerPedidoPublico(reference, await headers());
  if (pedido === null) notFound();

  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <p className="text-sm text-[var(--color-gris)]">
        Pedido <span className="cifra font-semibold">{pedido.reference}</span>
      </p>
      <h1 className="titular mt-1 text-4xl">{ETIQUETA_CLIENTE[pedido.status]}</h1>
      <p className="mt-2 text-[var(--color-gris)]">{mensajeEstado(pedido)}</p>

      {pedido.status === "pendiente_pago" && (
        <Link
          href={`/pago/${pedido.reference}`}
          className="mt-5 inline-block rounded-full bg-[var(--color-acento)] px-6 py-3 font-bold text-[var(--color-tinta)]"
        >
          Completar mi pago
        </Link>
      )}

      {pedido.status === "rechazado" && (
        <div className="mt-5">
          {pedido.pago?.motivoRechazo !== null && pedido.pago !== null && (
            <p className="rounded-lg border border-[var(--color-alerta)] bg-[var(--color-alerta)]/5 px-4 py-3 text-sm">
              {pedido.pago.motivoRechazo}
            </p>
          )}
          <Link
            href={`/pago/${pedido.reference}`}
            className="mt-4 inline-block rounded-full bg-[var(--color-tinta)] px-6 py-3 font-semibold text-[var(--color-papel)]"
          >
            Enviar otro comprobante
          </Link>
        </div>
      )}

      <LineaDeTiempo status={pedido.status} />

      {pedido.envio !== null && pedido.envio.guia !== null && <DatosEnvio envio={pedido.envio} />}

      <section className="mt-10">
        <h2 className="font-bold">Lo que pediste</h2>
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
        <p className="mt-4 flex justify-between border-t border-[var(--color-borde)] pt-4 font-bold">
          <span>Total</span>
          <span className="cifra">{formatSoles(pedido.totalCents)}</span>
        </p>
      </section>

      <p className="mt-10 text-sm text-[var(--color-gris)]">
        ¿Alguna duda con tu pedido? Escríbenos por WhatsApp mencionando tu código{" "}
        <span className="cifra font-semibold">{pedido.reference}</span>.
      </p>
    </div>
  );
}

/**
 * Línea de tiempo.
 *
 * Solo muestra el camino de éxito. Los estados de fracaso (rechazado, cancelado,
 * expirado) se comunican arriba con su propio bloque y una acción concreta:
 * meterlos en la línea de avance daría la impresión de que el pedido "avanza"
 * hacia un fracaso.
 */
function LineaDeTiempo({ status }: { status: OrderStatus }) {
  const indiceActual = LINEA_TIEMPO.indexOf(status);
  // Un estado fuera de la línea (rechazado, expirado) no pinta progreso.
  if (indiceActual === -1) return null;

  return (
    <section className="mt-10">
      <h2 className="solo-lectores">Progreso del pedido</h2>
      <ol className="space-y-0">
        {LINEA_TIEMPO.map((paso, i) => {
          const completado = i < indiceActual;
          const actual = i === indiceActual;
          return (
            <li key={paso} className="flex gap-4">
              <div className="flex flex-col items-center">
                <span
                  aria-hidden="true"
                  className={`mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${
                    completado
                      ? "border-[var(--color-exito)] bg-[var(--color-exito)]"
                      : actual
                        ? "border-[var(--color-tinta)] bg-[var(--color-acento)]"
                        : "border-[var(--color-borde)]"
                  }`}
                >
                  {completado && (
                    <svg viewBox="0 0 12 12" className="h-3 w-3 fill-white">
                      <path d="M4.5 8.5 2 6l.9-.9 1.6 1.6L9 2.2l.9.9z" />
                    </svg>
                  )}
                </span>
                {i < LINEA_TIEMPO.length - 1 && (
                  <span
                    aria-hidden="true"
                    className={`w-0.5 flex-1 ${
                      completado ? "bg-[var(--color-exito)]" : "bg-[var(--color-borde)]"
                    }`}
                  />
                )}
              </div>
              <div className="pb-6">
                <p
                  className={
                    actual ? "font-bold" : completado ? "" : "text-[var(--color-gris)]"
                  }
                >
                  {ETIQUETA_CLIENTE[paso]}
                  {actual && <span className="solo-lectores"> (estado actual)</span>}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function DatosEnvio({ envio }: { envio: NonNullable<PedidoPublico["envio"]> }) {
  return (
    <section className="mt-8 rounded-xl border-2 border-[var(--color-tinta)] p-5">
      <h2 className="font-bold">Datos de tu envío</h2>
      <dl className="mt-3 space-y-3 text-sm">
        <div>
          <dt className="text-[var(--color-gris)]">Número de guía</dt>
          <dd className="cifra text-lg font-bold">{envio.guia}</dd>
        </div>
        {envio.claveRetiro !== null && (
          <div>
            <dt className="text-[var(--color-gris)]">Clave de retiro</dt>
            <dd className="cifra text-lg font-bold">{envio.claveRetiro}</dd>
            {/* El aviso es parte de la seguridad de la clave: cualquiera con ella y
                la guía puede recoger el paquete. */}
            <dd className="mt-1 text-xs text-[var(--color-gris)]">
              No la compartas. Preséntala con tu DNI en la agencia.
            </dd>
          </div>
        )}
        {envio.agencia !== null && (
          <div>
            <dt className="text-[var(--color-gris)]">Agencia de destino</dt>
            <dd className="font-semibold">{envio.agencia}</dd>
          </div>
        )}
      </dl>

      <a
        href={envio.urlRastreo ?? "https://shalom.com.pe/rastrea-tu-envio"}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-4 inline-block text-sm font-semibold underline underline-offset-4"
      >
        Rastrear en Shalom
        <span className="solo-lectores"> (se abre en una pestaña nueva)</span>
      </a>
    </section>
  );
}

function mensajeEstado(pedido: PedidoPublico): string {
  switch (pedido.status) {
    case "pendiente_pago":
      return "Yapea el monto exacto para que podamos confirmar tu compra.";
    case "comprobante_enviado":
      return "Recibimos tu comprobante y lo estamos revisando. Te escribimos por WhatsApp en cuanto lo validemos.";
    case "verificado":
      return "Tu pago está confirmado. Ya estamos preparando tu pedido.";
    case "rechazado":
      return "No pudimos validar el comprobante que enviaste. Puedes enviar otro.";
    case "preparando":
      return "Estamos empacando tus zapatillas.";
    case "enviado":
      return pedido.modoEnvio === "provincia_agencia"
        ? "Tu pedido va en camino a la agencia. Te avisamos cuando llegue."
        : "Tu pedido está en camino.";
    case "entregado":
      return "Entregado. Gracias por comprar con nosotros.";
    case "cancelado":
      return "Este pedido fue cancelado.";
    case "expirado":
      return "El tiempo de reserva se venció y liberamos las tallas. Puedes armar el pedido de nuevo.";
  }
}

function formatearTalla(valor: number): string {
  return Number.isInteger(valor) ? String(valor) : valor.toFixed(1);
}
