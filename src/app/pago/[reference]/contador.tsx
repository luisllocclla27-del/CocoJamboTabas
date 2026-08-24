"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Contador de la reserva.
 *
 * Muestra cuánto queda antes de que las tallas se liberen. La urgencia es real, no
 * inventada: pasado ese tiempo, `expire_stale_reservations()` devuelve el stock al
 * catálogo y el pedido pasa a `expirado`.
 *
 * Al llegar a cero refresca la página en vez de dejar el formulario activo. Sin
 * eso, el cliente subiría un comprobante contra un pedido ya expirado, habiendo
 * pagado de verdad, y habría que devolverle el dinero.
 */
export function Contador({ hasta }: { hasta: string }) {
  const router = useRouter();
  const objetivo = new Date(hasta).getTime();
  const [restante, setRestante] = useState(() => Math.max(0, objetivo - Date.now()));

  useEffect(() => {
    if (restante <= 0) {
      router.refresh();
      return;
    }
    const id = setInterval(() => {
      const nuevo = Math.max(0, objetivo - Date.now());
      setRestante(nuevo);
      if (nuevo <= 0) router.refresh();
    }, 1000);
    return () => clearInterval(id);
  }, [objetivo, restante, router]);

  const minutos = Math.floor(restante / 60_000);
  const segundos = Math.floor((restante % 60_000) / 1000);
  const urgente = restante < 5 * 60_000;

  return (
    <p
      // `aria-live="off"` a propósito: un contador que se anuncia cada segundo
      // haría inutilizable la página con lector de pantalla. El tiempo restante
      // está en el texto y se puede consultar cuando el usuario quiera.
      aria-live="off"
      className={`mt-5 rounded-lg px-4 py-3 text-sm ${
        urgente
          ? "bg-[var(--color-alerta)]/10 text-[var(--color-alerta)]"
          : "bg-[var(--color-humo)] text-[var(--color-gris)]"
      }`}
    >
      Tus tallas están reservadas{" "}
      <span className="cifra font-bold">
        {minutos}:{String(segundos).padStart(2, "0")}
      </span>{" "}
      más.
    </p>
  );
}
