"use client";

import { useState } from "react";
import { generarEnlaceHistoriaIG, generarTextoWhatsApp, type DatosProductoCopy } from "@/lib/admin/copy-generator";

export function BotonCompartirRedes({ producto }: { producto: DatosProductoCopy }) {
  const [copiado, setCopiado] = useState<string | null>(null);

  async function copiarTextoWhatsApp() {
    try {
      const texto = generarTextoWhatsApp(producto);
      await navigator.clipboard.writeText(texto);
      setCopiado("whatsapp");
      setTimeout(() => setCopiado(null), 2500);
    } catch {
      alert("No se pudo copiar al portapapeles. Intenta manualmente.");
    }
  }

  async function copiarLinkIG() {
    try {
      const link = generarEnlaceHistoriaIG(producto.slug);
      await navigator.clipboard.writeText(link);
      setCopiado("ig");
      setTimeout(() => setCopiado(null), 2500);
    } catch {
      alert("No se pudo copiar al portapapeles. Intenta manualmente.");
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={copiarTextoWhatsApp}
        className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition ${
          copiado === "whatsapp"
            ? "bg-[var(--color-exito)] text-white"
            : "bg-[#25D366]/15 text-[#128C7E] hover:bg-[#25D366]/25 border border-[#25D366]/30"
        }`}
        title="Copiar texto formateado con tallas y link para pegar en grupos de WhatsApp"
      >
        <span aria-hidden="true">{copiado === "whatsapp" ? "✓" : "📲"}</span>
        {copiado === "whatsapp" ? "¡Copiado para WhatsApp!" : "Copiar para WhatsApp"}
      </button>

      <button
        type="button"
        onClick={copiarLinkIG}
        className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition ${
          copiado === "ig"
            ? "bg-[var(--color-exito)] text-white"
            : "bg-[#E1306C]/10 text-[#C13584] hover:bg-[#E1306C]/20 border border-[#E1306C]/30"
        }`}
        title="Copiar link con tracking para stickers de Historias de Instagram o Bio"
      >
        <span aria-hidden="true">{copiado === "ig" ? "✓" : "📸"}</span>
        {copiado === "ig" ? "¡Link de IG copiado!" : "Link para Instagram"}
      </button>
    </div>
  );
}
