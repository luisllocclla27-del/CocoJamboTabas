"use client";

import { useState } from "react";

export function CompartirProductoPublico({
  modelo,
  colorway,
  precioTexto,
}: {
  modelo: string;
  colorway: string;
  precioTexto: string;
}) {
  const [copiado, setCopiado] = useState(false);

  const urlActual = typeof window !== "undefined" ? window.location.href : "";

  function compartirWhatsApp() {
    const mensaje = encodeURIComponent(
      `¡Mira estas zapatillas originales en Coco Jambo! 🔥\n*${modelo} - ${colorway}*\nPrecio: ${precioTexto}\n👉 ${urlActual}`,
    );
    window.open(`https://api.whatsapp.com/send?text=${mensaje}`, "_blank");
  }

  async function copiarEnlace() {
    try {
      await navigator.clipboard.writeText(urlActual);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 2000);
    } catch {
      // Fallback si el portapapeles falla
    }
  }

  return (
    <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-[var(--color-borde)] pt-6">
      <span className="text-xs font-semibold uppercase text-[var(--color-gris)]">
        Compartir par:
      </span>
      <button
        type="button"
        onClick={compartirWhatsApp}
        className="inline-flex items-center gap-1.5 rounded-full border border-[#25D366]/40 bg-[#25D366]/10 px-4 py-1.5 text-xs font-semibold text-[#128C7E] hover:bg-[#25D366]/20 transition cursor-pointer"
      >
        <span aria-hidden="true">📲</span> WhatsApp
      </button>

      <button
        type="button"
        onClick={copiarEnlace}
        className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-borde)] px-4 py-1.5 text-xs font-semibold hover:border-[var(--color-tinta)] transition cursor-pointer"
      >
        <span aria-hidden="true">{copiado ? "✓" : "🔗"}</span>
        {copiado ? "¡Enlace copiado!" : "Copiar enlace"}
      </button>
    </div>
  );
}
