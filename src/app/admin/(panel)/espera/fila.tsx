"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { EsperaAdmin } from "@/lib/admin/queries";
import { marcarAvisado } from "@/lib/admin/inventory";

/**
 * Fila de la lista de espera.
 *
 * El WhatsApp se manda a mano desde el enlace `wa.me`, con el mensaje ya escrito.
 * No se automatiza el envío por dos razones: la API de WhatsApp Business exige
 * verificación de negocio y plantillas aprobadas, y un mensaje escrito por una
 * persona convierte mejor que uno automático. Lo que sí se registra es que ya se
 * avisó, para que nadie reciba el mismo aviso tres veces.
 */
export function FilaEspera({ item }: { item: EsperaAdmin }) {
  const router = useRouter();
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hayStock = item.stockActual > 0;

  const mensaje = hayStock
    ? `Hola! Ya tenemos de vuelta las ${item.modelo} ${item.colorway} en talla US ${formatearTalla(item.sizeUs)}. ¿Te la aparto?`
    : `Hola! Sobre las ${item.modelo} ${item.colorway} en talla US ${formatearTalla(item.sizeUs)} que estabas esperando:`;

  async function marcar() {
    setEnviando(true);
    setError(null);
    const resultado = await marcarAvisado({ esperaId: item.id });
    setEnviando(false);
    if (!resultado.ok) {
      setError(resultado.error);
      return;
    }
    router.refresh();
  }

  return (
    <article
      className={`rounded-xl border p-4 ${
        hayStock ? "border-[var(--color-exito)]" : "border-[var(--color-borde)]"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-semibold">{item.modelo}</p>
          <p className="cifra text-sm text-[var(--color-gris)]">
            {item.colorway} · US {formatearTalla(item.sizeUs)}
          </p>
          <p className="mt-1 text-xs text-[var(--color-gris)]">
            Pedido el {new Date(item.creadoEn).toLocaleDateString("es-PE")}
          </p>
        </div>
        <div className="text-right">
          {hayStock ? (
            <span className="cifra rounded-full bg-[var(--color-exito)] px-3 py-1 text-xs font-bold text-white">
              {item.stockActual} en stock
            </span>
          ) : (
            <span className="rounded-full bg-[var(--color-humo)] px-3 py-1 text-xs font-semibold text-[var(--color-gris)]">
              Sin stock
            </span>
          )}
        </div>
      </div>

      {error !== null && (
        <p role="alert" className="mt-3 text-sm font-medium text-[var(--color-alerta)]">
          {error}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <a
          href={`https://wa.me/51${item.telefono}?text=${encodeURIComponent(mensaje)}`}
          target="_blank"
          rel="noopener noreferrer"
          className={`rounded-full px-5 py-2 text-sm font-semibold ${
            hayStock
              ? "bg-[var(--color-acento)] text-[var(--color-tinta)]"
              : "border border-[var(--color-borde)]"
          }`}
        >
          Escribir por WhatsApp
          <span className="solo-lectores"> (se abre en una pestaña nueva)</span>
        </a>
        <span className="cifra text-sm text-[var(--color-gris)]">{item.telefono}</span>
        <button
          type="button"
          onClick={marcar}
          disabled={enviando}
          className="ml-auto text-sm underline underline-offset-4 disabled:opacity-50"
        >
          {enviando ? "Marcando..." : "Marcar como avisado"}
        </button>
      </div>
    </article>
  );
}

function formatearTalla(valor: number): string {
  return Number.isInteger(valor) ? String(valor) : valor.toFixed(1);
}
