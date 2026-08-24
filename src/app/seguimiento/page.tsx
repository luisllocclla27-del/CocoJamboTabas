import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { normalizeReference } from "@/lib/reference";

export const metadata: Metadata = {
  title: "Seguir mi pedido",
  description: "Consulta el estado de tu pedido con tu código de seguimiento.",
};

/**
 * Buscador de pedidos.
 *
 * Es un formulario GET que redirige a `/seguimiento/COCO-XXXXXX`. Funciona sin
 * JavaScript y deja el pedido en una URL propia que el cliente puede guardar en
 * favoritos o recibir por WhatsApp.
 */
export default async function SeguimientoPage({
  searchParams,
}: {
  searchParams: Promise<{ ref?: string }>;
}) {
  const { ref } = await searchParams;

  if (ref !== undefined && ref.trim() !== "") {
    const normalizada = normalizeReference(ref);
    // Se normaliza antes de redirigir: la gente escribe "coco 7f3k2m" o pega el
    // código sin prefijo, y eso debe funcionar.
    if (normalizada !== null) redirect(`/seguimiento/${normalizada}`);
  }

  const conError = ref !== undefined && ref.trim() !== "";

  return (
    <div className="mx-auto max-w-md px-4 py-16">
      <h1 className="titular text-4xl">Seguir mi pedido</h1>
      <p className="mt-3 text-[var(--color-gris)]">
        Escribe el código que te dimos al confirmar tu compra. Tiene la forma{" "}
        <span className="cifra font-semibold">COCO-7F3K2M</span>.
      </p>

      <form action="/seguimiento" method="get" className="mt-8">
        <label htmlFor="ref" className="block text-sm font-semibold">
          Código de seguimiento
        </label>
        <input
          id="ref"
          name="ref"
          type="text"
          required
          autoComplete="off"
          autoCapitalize="characters"
          defaultValue={ref ?? ""}
          placeholder="COCO-7F3K2M"
          aria-describedby={conError ? "ref-error" : undefined}
          aria-invalid={conError ? "true" : undefined}
          className="cifra mt-1 w-full rounded-lg border border-[var(--color-borde)] px-4 py-3 text-lg uppercase"
        />

        {conError && (
          <p id="ref-error" role="alert" className="mt-2 text-sm font-medium text-[var(--color-alerta)]">
            Ese código no tiene el formato correcto. Revisa que sea el que te enviamos por WhatsApp.
          </p>
        )}

        <button
          type="submit"
          className="mt-5 w-full rounded-full bg-[var(--color-tinta)] px-6 py-3.5 font-semibold text-[var(--color-papel)]"
        >
          Buscar mi pedido
        </button>
      </form>

      <p className="mt-8 text-sm text-[var(--color-gris)]">
        ¿Perdiste tu código? Escríbenos por WhatsApp con tu nombre y te lo buscamos.
      </p>
    </div>
  );
}
