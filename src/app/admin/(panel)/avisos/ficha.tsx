"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { AvisoOutbox } from "@/lib/admin/outbox-queries";
import {
  descartarAviso,
  marcarAvisoEnviado,
  reintentarAviso,
} from "@/lib/admin/outbox-actions";

/**
 * Tarjeta de un aviso del outbox.
 *
 * EL ENVÍO LO HACE UNA PERSONA. No hay proveedor de WhatsApp conectado (la API de
 * WhatsApp Business exige verificación de negocio y plantillas aprobadas), así que
 * el sistema redacta y el comerciante manda con un clic. Esta pantalla es lo que
 * hace que un aviso encolado no muera invisible en la tabla.
 *
 * El botón de copiar existe además del enlace `wa.me` porque en escritorio muchos
 * usan WhatsApp Web ya abierto en otra pestaña, y ahí pegar es más rápido que
 * dejar que el enlace abra una ventana nueva.
 */
export function FichaAviso({ aviso }: { aviso: AvisoOutbox }) {
  const router = useRouter();
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiado, setCopiado] = useState(false);

  async function ejecutar(accion: () => Promise<{ ok: boolean; error?: string }>) {
    setOcupado(true);
    setError(null);
    const resultado = await accion();
    setOcupado(false);
    if (!resultado.ok) {
      setError(resultado.error ?? "No se pudo completar la acción.");
      return;
    }
    router.refresh();
  }

  async function copiar() {
    if (aviso.mensaje === null) return;
    try {
      await navigator.clipboard.writeText(aviso.mensaje.texto);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 2000);
    } catch {
      // Sin permiso de portapapeles el texto sigue visible y seleccionable: no hace
      // falta un error, solo no confirmar que se copió.
      setError("Tu navegador no dejó copiar. Selecciona el texto a mano.");
    }
  }

  const esFallido = aviso.status === "fallido";
  const esCerrado = aviso.status === "enviado";

  return (
    <article
      className={`rounded-xl border p-4 ${
        esFallido
          ? "border-[var(--color-alerta)]"
          : esCerrado
            ? "border-dashed border-[var(--color-borde)] opacity-75"
            : "border-[var(--color-borde)]"
      }`}
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-semibold">{aviso.etiqueta}</p>
          <p className="text-xs text-[var(--color-gris)]">
            {aviso.reference !== null && <span className="cifra">{aviso.reference} · </span>}
            {new Date(aviso.creadoEn).toLocaleString("es-PE")}
            {aviso.intentos > 0 && ` · ${aviso.intentos} intentos`}
          </p>
        </div>
        <span
          className={`rounded-full px-3 py-1 text-xs font-bold uppercase ${
            aviso.destino === "comerciante"
              ? "bg-[var(--color-tinta)] text-[var(--color-papel)]"
              : "bg-[var(--color-humo)] text-[var(--color-gris)]"
          }`}
        >
          {aviso.destino === "comerciante" ? "Para ti" : "Para el cliente"}
        </span>
      </header>

      {aviso.esperaHasta !== null && (
        <p className="mt-2 text-xs text-[var(--color-gris)]">
          Programado para {new Date(aviso.esperaHasta).toLocaleString("es-PE")}. Puedes mandarlo
          antes.
        </p>
      )}

      {aviso.ultimoError !== null && (
        <p className="mt-2 rounded bg-[var(--color-alerta)]/5 px-3 py-2 text-xs text-[var(--color-alerta)]">
          Último error: {aviso.ultimoError}
        </p>
      )}

      {aviso.mensaje === null ? (
        <p className="mt-3 rounded-lg bg-[var(--color-humo)] px-3 py-2.5 text-sm">
          No se puede redactar: falta {aviso.faltante}. Avisa a mano y descarta este evento.
        </p>
      ) : (
        <>
          <p className="mt-3 whitespace-pre-wrap rounded-lg bg-[var(--color-humo)] px-3 py-2.5 text-sm">
            {aviso.mensaje.texto}
          </p>
          <p className="cifra mt-1 text-xs text-[var(--color-gris)]">
            +{aviso.mensaje.telefono}
          </p>
        </>
      )}

      {error !== null && (
        <p role="alert" className="mt-3 text-sm font-medium text-[var(--color-alerta)]">
          {error}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {aviso.mensaje !== null && aviso.destino === "cliente" && (
          <a
            href={aviso.mensaje.enlace}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-full bg-[var(--color-acento)] px-5 py-2 text-sm font-semibold text-[var(--color-tinta)]"
          >
            Abrir WhatsApp
            <span className="solo-lectores"> (se abre en una pestaña nueva)</span>
          </a>
        )}

        {aviso.mensaje !== null && aviso.destino === "comerciante" && aviso.reference !== null && (
          <Link
            href="/admin/pagos"
            className="rounded-full bg-[var(--color-tinta)] px-5 py-2 text-sm font-semibold text-[var(--color-papel)]"
          >
            Ir a verificar
          </Link>
        )}

        {aviso.mensaje !== null && (
          <button
            type="button"
            onClick={copiar}
            className="rounded-full border border-[var(--color-borde)] px-4 py-2 text-sm hover:border-[var(--color-tinta)]"
          >
            {copiado ? "Copiado" : "Copiar texto"}
          </button>
        )}

        {!esCerrado && (
          <div className="ml-auto flex flex-wrap gap-3 text-sm">
            {esFallido && (
              <button
                type="button"
                disabled={ocupado}
                onClick={() => ejecutar(() => reintentarAviso(aviso.id))}
                className="underline underline-offset-4 disabled:opacity-50"
              >
                Devolver a la cola
              </button>
            )}
            <button
              type="button"
              disabled={ocupado}
              onClick={() => ejecutar(() => marcarAvisoEnviado(aviso.id))}
              className="font-semibold underline underline-offset-4 disabled:opacity-50"
            >
              Ya lo mandé
            </button>
            <button
              type="button"
              disabled={ocupado}
              onClick={() => ejecutar(() => descartarAviso(aviso.id))}
              className="text-[var(--color-gris)] underline underline-offset-4 disabled:opacity-50"
            >
              Descartar
            </button>
          </div>
        )}
      </div>
    </article>
  );
}
