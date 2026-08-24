"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatSize } from "@/lib/sizes";
import { agregarAlCarrito } from "@/lib/cart/actions";
import { apuntarEnListaEspera } from "@/lib/waitlist/actions";

/**
 * Selector de talla.
 *
 * Es el único componente de cliente de la ficha, porque necesita estado local
 * (qué talla eligió el usuario). El resto de la página se renderiza en el
 * servidor.
 *
 * Decisión de diseño que importa: las tallas agotadas SE MUESTRAN, deshabilitadas
 * y tachadas, en lugar de ocultarse. Ocultarlas haría creer al cliente que el
 * modelo solo existe en tres tallas, y elimina la oportunidad de captar la lista
 * de espera, que es el dato que dice qué reponer con demanda real detrás.
 */
export type VarianteUI = {
  id: string;
  sizeUs: number;
  sizeEu: number | null;
  sizeCm: number | null;
  disponible: number;
};

/** Con 2 o menos pares se avisa: la urgencia real convierte, la inventada quema. */
const UMBRAL_STOCK_BAJO = 2;

export function SelectorTalla({
  productoId,
  slug,
  variantes,
}: {
  productoId: string;
  slug: string;
  variantes: VarianteUI[];
}) {
  const router = useRouter();
  const [seleccionada, setSeleccionada] = useState<VarianteUI | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [avisoPedido, setAvisoPedido] = useState(false);
  const [telefono, setTelefono] = useState("");

  const hayStock = variantes.some((v) => v.disponible > 0);

  async function alAgregar() {
    if (seleccionada === null) {
      setError("Elige tu talla para continuar.");
      return;
    }
    setEnviando(true);
    setError(null);
    const resultado = await agregarAlCarrito({ variantId: seleccionada.id, cantidad: 1 });
    setEnviando(false);
    if (!resultado.ok) {
      setError(resultado.error);
      // Si el stock cambió mientras el cliente miraba, hay que refrescar los
      // datos del servidor: seguir mostrando la talla como disponible haría que
      // el error se repitiera indefinidamente.
      router.refresh();
      return;
    }
    router.push("/carrito");
  }

  async function alPedirAviso(event: React.FormEvent) {
    event.preventDefault();
    if (seleccionada === null) {
      setError("Elige la talla que estás esperando.");
      return;
    }
    setEnviando(true);
    setError(null);
    const resultado = await apuntarEnListaEspera({ variantId: seleccionada.id, telefono });
    setEnviando(false);
    if (!resultado.ok) {
      setError(resultado.error);
      return;
    }
    setAvisoPedido(true);
  }

  return (
    <section className="mt-8">
      <div className="flex items-baseline justify-between">
        <h2 id="etiqueta-tallas" className="font-bold">
          Elige tu talla <span className="font-normal text-[var(--color-gris)]">(US)</span>
        </h2>
        <a href="/guia-de-tallas" className="text-sm underline underline-offset-4">
          Guía de tallas
        </a>
      </div>

      {/* `role="radiogroup"` porque funciona como un grupo de opciones excluyentes,
          aunque se dibuje con botones. */}
      <div role="radiogroup" aria-labelledby="etiqueta-tallas" className="mt-3 flex flex-wrap gap-2">
        {variantes.map((variante) => {
          const agotada = variante.disponible === 0;
          const activa = seleccionada?.id === variante.id;
          return (
            <button
              key={variante.id}
              type="button"
              role="radio"
              aria-checked={activa}
              // Una talla agotada sigue siendo seleccionable para poder pedir
              // aviso, así que no se deshabilita: se marca visualmente y con
              // `aria-describedby`.
              onClick={() => {
                setSeleccionada(variante);
                setError(null);
                setAvisoPedido(false);
              }}
              className={`cifra min-w-14 rounded-lg border px-3 py-2.5 text-sm transition ${
                activa
                  ? "border-[var(--color-tinta)] bg-[var(--color-tinta)] font-bold text-[var(--color-papel)]"
                  : agotada
                    ? "border-dashed border-[var(--color-borde)] text-[var(--color-gris)] line-through"
                    : "border-[var(--color-borde)] hover:border-[var(--color-tinta)]"
              }`}
            >
              {formatearTalla(variante.sizeUs)}
              <span className="solo-lectores">
                {agotada ? " (agotada, puedes pedir aviso)" : " disponible"}
              </span>
            </button>
          );
        })}
      </div>

      {seleccionada !== null && <DetalleTalla variante={seleccionada} />}

      {error !== null && (
        // `role="alert"` interrumpe al lector de pantalla: es un error que
        // bloquea la compra y el usuario debe saberlo de inmediato.
        <p role="alert" className="mt-4 text-sm font-medium text-[var(--color-alerta)]">
          {error}
        </p>
      )}

      {seleccionada !== null && seleccionada.disponible === 0 ? (
        avisoPedido ? (
          <p
            role="status"
            className="mt-5 rounded-lg border border-[var(--color-exito)] bg-[var(--color-exito)]/5 px-4 py-3 text-sm"
          >
            Listo. Te escribimos por WhatsApp en cuanto entre la talla{" "}
            {formatearTalla(seleccionada.sizeUs)}.
          </p>
        ) : (
          <form onSubmit={alPedirAviso} className="mt-5 rounded-lg bg-[var(--color-humo)] p-4">
            <label htmlFor="telefono-aviso" className="block text-sm font-semibold">
              Avísame cuando entre mi talla
            </label>
            <p className="mt-1 text-xs text-[var(--color-gris)]">
              Te escribimos por WhatsApp. No usamos tu número para nada más.
            </p>
            <div className="mt-3 flex gap-2">
              <input
                id="telefono-aviso"
                name="telefono"
                type="tel"
                inputMode="numeric"
                autoComplete="tel"
                required
                value={telefono}
                onChange={(e) => setTelefono(e.target.value)}
                placeholder="9XXXXXXXX"
                className="cifra w-full rounded-lg border border-[var(--color-borde)] bg-[var(--color-papel)] px-3 py-2 text-sm"
              />
              <button
                type="submit"
                disabled={enviando}
                className="shrink-0 rounded-lg bg-[var(--color-tinta)] px-4 py-2 text-sm font-semibold text-[var(--color-papel)] disabled:opacity-50"
              >
                {enviando ? "Enviando..." : "Avisarme"}
              </button>
            </div>
          </form>
        )
      ) : (
        <button
          type="button"
          onClick={alAgregar}
          disabled={enviando || !hayStock}
          className="mt-6 w-full rounded-full bg-[var(--color-acento)] px-6 py-4 font-bold text-[var(--color-tinta)] transition hover:bg-[var(--color-acento-oscuro)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {enviando ? "Agregando..." : hayStock ? "Agregar al carrito" : "Sin stock"}
        </button>
      )}

      <p className="mt-3 text-center text-xs text-[var(--color-gris)]">
        Al agregar, tu talla queda reservada 30 minutos mientras completas el pago.
      </p>

      <input type="hidden" name="producto" value={productoId} data-slug={slug} />
    </section>
  );
}

function DetalleTalla({ variante }: { variante: VarianteUI }) {
  const equivalencias = [
    `US ${formatearTalla(variante.sizeUs)}`,
    variante.sizeEu === null ? null : formatSize(variante.sizeEu, "EU"),
    variante.sizeCm === null ? null : formatSize(variante.sizeCm, "CM"),
  ].filter((x): x is string => x !== null);

  return (
    <div className="mt-4 text-sm" aria-live="polite">
      <p className="cifra text-[var(--color-gris)]">{equivalencias.join(" · ")}</p>
      {variante.disponible > 0 && variante.disponible <= UMBRAL_STOCK_BAJO && (
        <p className="mt-1 font-semibold text-[var(--color-aviso)]">
          {variante.disponible === 1 ? "Último par en esta talla" : `Quedan ${variante.disponible} pares`}
        </p>
      )}
    </div>
  );
}

function formatearTalla(valor: number): string {
  return Number.isInteger(valor) ? String(valor) : valor.toFixed(1);
}
