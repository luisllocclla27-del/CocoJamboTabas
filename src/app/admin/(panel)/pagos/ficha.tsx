"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { splitSoles } from "@/lib/money";
import type { ComprobantePendiente } from "@/lib/admin/queries";
import { aprobarPago, rechazarPago, verVoucher } from "@/lib/admin/verify";

/**
 * Ficha de un comprobante en la cola.
 *
 * La disposición responde a cómo se verifica de verdad: primero el monto esperado
 * con sus céntimos destacados (que es lo que hay que buscar en la captura), luego
 * las señales de riesgo, luego el voucher, y al final los dos botones.
 *
 * Rechazar exige escribir un motivo. No es burocracia: el cliente lo va a leer en
 * su página de seguimiento, y un rechazo sin explicación genera un reclamo por
 * WhatsApp que cuesta más tiempo que teclearlo.
 */
export function FichaComprobante({ comprobante }: { comprobante: ComprobantePendiente }) {
  const router = useRouter();
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [urlVoucher, setUrlVoucher] = useState<string | null>(null);
  const [rechazando, setRechazando] = useState(false);
  const [motivo, setMotivo] = useState("");

  const monto = splitSoles(comprobante.montoEsperadoCents);
  const criticas = comprobante.riskSignals.filter((s) => s.severidad === "critico");
  const advertencias = comprobante.riskSignals.filter((s) => s.severidad === "advertencia");

  async function abrirVoucher() {
    setError(null);
    if (comprobante.voucherPath === null) return;
    const resultado = await verVoucher(comprobante.voucherPath);
    if ("error" in resultado) {
      setError(resultado.error);
      return;
    }
    setUrlVoucher(resultado.url);
  }

  async function alAprobar() {
    setEnviando(true);
    setError(null);
    const resultado = await aprobarPago({ paymentId: comprobante.paymentId });
    setEnviando(false);
    if (!resultado.ok) {
      setError(resultado.error);
      return;
    }
    router.refresh();
  }

  async function alRechazar(event: React.FormEvent) {
    event.preventDefault();
    setEnviando(true);
    setError(null);
    const resultado = await rechazarPago({ paymentId: comprobante.paymentId, motivo });
    setEnviando(false);
    if (!resultado.ok) {
      setError(resultado.error);
      return;
    }
    router.refresh();
  }

  return (
    <article
      className={`rounded-xl border-2 p-5 ${
        criticas.length > 0
          ? "border-[var(--color-alerta)]"
          : advertencias.length > 0
            ? "border-[var(--color-aviso)]"
            : "border-[var(--color-borde)]"
      }`}
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="cifra font-bold">{comprobante.reference}</p>
          <p className="text-sm text-[var(--color-gris)]">
            {comprobante.nombreCliente} ·{" "}
            <a
              href={`https://wa.me/51${comprobante.telefono}`}
              target="_blank"
              rel="noopener noreferrer"
              className="cifra underline underline-offset-2"
            >
              {comprobante.telefono}
            </a>
          </p>
        </div>
        <Insignia criticas={criticas.length} advertencias={advertencias.length} />
      </header>

      <div className="mt-4 grid gap-5 sm:grid-cols-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-gris)]">
            Monto que debe decir el voucher
          </p>
          {/* Los céntimos van resaltados porque son el dato que identifica el pago:
              es lo que hay que comparar contra la captura. */}
          <p className="cifra mt-1 flex items-baseline gap-1 font-bold leading-none">
            <span className="text-lg">S/</span>
            <span className="text-4xl">{monto.soles}</span>
            <span className="text-4xl text-[var(--color-acento-oscuro)]">.{monto.centimos}</span>
          </p>

          <dl className="mt-4 space-y-1 text-sm">
            <div className="flex gap-2">
              <dt className="text-[var(--color-gris)]">N° operación:</dt>
              <dd className="cifra font-semibold">
                {comprobante.operationNumber ?? "—"}
                {comprobante.operacionDuplicada && (
                  <span className="ml-2 rounded bg-[var(--color-alerta)] px-1.5 py-0.5 text-xs font-bold text-white">
                    REPETIDO
                  </span>
                )}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-[var(--color-gris)]">Enviado:</dt>
              <dd>{new Date(comprobante.creadoEn).toLocaleString("es-PE")}</dd>
            </div>
          </dl>

          <ul className="mt-3 text-sm">
            {comprobante.items.map((item, i) => (
              <li key={i} className="cifra text-[var(--color-gris)]">
                {item.cantidad}× {item.modelo} · US {formatearTalla(item.sizeUs)}
              </li>
            ))}
          </ul>
        </div>

        <div>
          {comprobante.riskSignals.length > 0 && (
            <>
              <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-gris)]">
                Señales
              </p>
              <ul className="mt-1 space-y-1 text-sm">
                {comprobante.riskSignals.map((señal, i) => (
                  <li key={i} className="flex gap-2">
                    <span aria-hidden="true">
                      {señal.severidad === "critico"
                        ? "🔴"
                        : señal.severidad === "advertencia"
                          ? "🟡"
                          : "⚪"}
                    </span>
                    <span
                      className={
                        señal.severidad === "critico"
                          ? "font-semibold text-[var(--color-alerta)]"
                          : señal.severidad === "advertencia"
                            ? "text-[var(--color-aviso)]"
                            : "text-[var(--color-gris)]"
                      }
                    >
                      {señal.mensaje}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}

          <div className="mt-4">
            {comprobante.voucherPath === null ? (
              <p className="text-sm text-[var(--color-gris)]">Sin comprobante adjunto.</p>
            ) : urlVoucher === null ? (
              <button
                type="button"
                onClick={abrirVoucher}
                className="rounded-full border border-[var(--color-tinta)] px-4 py-2 text-sm font-semibold"
              >
                Ver comprobante
              </button>
            ) : (
              <figure>
                {/* URL firmada con caducidad de 5 minutos, no una URL pública del
                    bucket. `next/image` no aplica: la URL cambia en cada firma. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={urlVoucher}
                  alt={`Comprobante de ${comprobante.reference}`}
                  className="max-h-80 rounded-lg border border-[var(--color-borde)] object-contain"
                />
                <figcaption className="mt-1 text-xs text-[var(--color-gris)]">
                  El enlace caduca en 5 minutos.
                </figcaption>
              </figure>
            )}
          </div>
        </div>
      </div>

      {error !== null && (
        <p
          role="alert"
          className="mt-4 rounded-lg border border-[var(--color-alerta)] bg-[var(--color-alerta)]/5 px-4 py-2.5 text-sm font-medium text-[var(--color-alerta)]"
        >
          {error}
        </p>
      )}

      {rechazando ? (
        <form onSubmit={alRechazar} className="mt-5 rounded-lg bg-[var(--color-humo)] p-4">
          <label htmlFor={`motivo-${comprobante.paymentId}`} className="block text-sm font-semibold">
            Motivo del rechazo
          </label>
          <p className="mt-0.5 text-xs text-[var(--color-gris)]">
            El cliente va a leer esto en su página de seguimiento.
          </p>
          <textarea
            id={`motivo-${comprobante.paymentId}`}
            required
            minLength={10}
            maxLength={300}
            rows={2}
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            placeholder="El monto del voucher no coincide con el del pedido."
            className="mt-2 w-full rounded-lg border border-[var(--color-borde)] px-3 py-2 text-sm"
          />
          <div className="mt-3 flex gap-2">
            <button
              type="submit"
              disabled={enviando}
              className="rounded-full bg-[var(--color-alerta)] px-5 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {enviando ? "Rechazando..." : "Confirmar rechazo"}
            </button>
            <button
              type="button"
              onClick={() => setRechazando(false)}
              className="rounded-full border border-[var(--color-borde)] px-5 py-2 text-sm"
            >
              Cancelar
            </button>
          </div>
        </form>
      ) : (
        <div className="mt-5 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={alAprobar}
            disabled={enviando}
            className="rounded-full bg-[var(--color-acento)] px-6 py-2.5 font-bold text-[var(--color-tinta)] disabled:opacity-50"
          >
            {enviando ? "Aprobando..." : "Aprobar y preparar"}
          </button>
          <button
            type="button"
            onClick={() => setRechazando(true)}
            disabled={enviando}
            className="rounded-full border border-[var(--color-alerta)] px-6 py-2.5 font-semibold text-[var(--color-alerta)] disabled:opacity-50"
          >
            Rechazar
          </button>
        </div>
      )}

      {criticas.length > 0 && (
        <p className="mt-3 text-xs text-[var(--color-gris)]">
          Hay señales críticas. La decisión sigue siendo tuya: el sistema nunca rechaza solo.
        </p>
      )}
    </article>
  );
}

function Insignia({ criticas, advertencias }: { criticas: number; advertencias: number }) {
  if (criticas > 0) {
    return (
      <span className="rounded-full bg-[var(--color-alerta)] px-3 py-1 text-xs font-bold uppercase text-white">
        Revisar con cuidado
      </span>
    );
  }
  if (advertencias > 0) {
    return (
      <span className="rounded-full bg-[var(--color-aviso)] px-3 py-1 text-xs font-bold uppercase text-white">
        Con dudas
      </span>
    );
  }
  return (
    <span className="rounded-full bg-[var(--color-exito)] px-3 py-1 text-xs font-bold uppercase text-white">
      Sin señales
    </span>
  );
}

function formatearTalla(valor: number): string {
  return Number.isInteger(valor) ? String(valor) : valor.toFixed(1);
}
