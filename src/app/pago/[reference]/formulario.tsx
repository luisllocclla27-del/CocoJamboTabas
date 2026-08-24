"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatSoles, type Cents } from "@/lib/money";
import { subirComprobante } from "@/lib/orders/voucher";

/**
 * Formulario del comprobante.
 *
 * Pide dos cosas y ninguna es opcional:
 *
 * 1. La captura del Yape.
 * 2. El número de operación, escrito a mano. Podría extraerse por OCR, pero
 *    pedirlo cumple dos funciones: da un dato limpio contra el que comprobar
 *    duplicados de inmediato (el índice único de la base lo rechaza si ya existe),
 *    y hace consciente al cliente de que el pago es verificable. La fricción de
 *    teclear 8 dígitos es menor que el coste de un fraude.
 *
 * La vista previa se genera en el navegador con `URL.createObjectURL` y no se
 * sube nada hasta que el usuario confirma: así puede darse cuenta de que eligió la
 * captura equivocada antes de enviarla.
 */
export function FormularioComprobante({
  reference,
  totalCents,
}: {
  reference: string;
  totalCents: Cents;
}) {
  const router = useRouter();
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enviado, setEnviado] = useState(false);
  const [previa, setPrevia] = useState<string | null>(null);
  const [nombreArchivo, setNombreArchivo] = useState<string | null>(null);

  function alElegirArchivo(event: React.ChangeEvent<HTMLInputElement>) {
    const archivo = event.target.files?.[0];
    setError(null);
    if (previa !== null) URL.revokeObjectURL(previa);
    if (archivo === undefined) {
      setPrevia(null);
      setNombreArchivo(null);
      return;
    }
    setPrevia(URL.createObjectURL(archivo));
    setNombreArchivo(archivo.name);
  }

  async function alEnviar(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setEnviando(true);
    setError(null);

    const datos = new FormData(event.currentTarget);
    datos.set("reference", reference);

    const resultado = await subirComprobante(datos);
    setEnviando(false);

    if (!resultado.ok) {
      setError(resultado.error);
      return;
    }
    setEnviado(true);
    router.refresh();
  }

  if (enviado) {
    return (
      <section
        role="status"
        className="mt-8 rounded-2xl border-2 border-[var(--color-exito)] bg-[var(--color-exito)]/5 p-6"
      >
        <h2 className="titular text-2xl">Comprobante recibido</h2>
        <p className="mt-2 text-sm">
          Lo estamos validando. Te escribimos por WhatsApp en cuanto confirmemos tu pago, y desde
          ahí coordinamos el envío.
        </p>
        <a
          href={`/seguimiento/${reference}`}
          className="mt-5 inline-block rounded-full bg-[var(--color-tinta)] px-5 py-2.5 text-sm font-semibold text-[var(--color-papel)]"
        >
          Ver estado de mi pedido
        </a>
      </section>
    );
  }

  return (
    <form onSubmit={alEnviar} className="mt-8 rounded-2xl border border-[var(--color-borde)] p-6">
      <h2 className="titular text-2xl">Ya yapeé</h2>
      <p className="mt-1 text-sm text-[var(--color-gris)]">
        Sube tu captura y el número de operación para que validemos el pago.
      </p>

      <div className="mt-5">
        <label htmlFor="voucher" className="block text-sm font-semibold">
          Captura del Yape
          <span aria-hidden="true" className="text-[var(--color-alerta)]">
            {" "}
            *
          </span>
          <span className="solo-lectores"> (obligatorio)</span>
        </label>
        <input
          id="voucher"
          name="voucher"
          type="file"
          required
          // `capture` no se fuerza: mucha gente ya tiene la captura en su galería y
          // abrir la cámara directamente sería un estorbo.
          accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
          onChange={alElegirArchivo}
          aria-describedby="voucher-ayuda"
          className="mt-1 w-full rounded-lg border border-[var(--color-borde)] px-3 py-2.5 text-sm file:mr-3 file:rounded-full file:border-0 file:bg-[var(--color-tinta)] file:px-4 file:py-1.5 file:text-sm file:font-semibold file:text-[var(--color-papel)]"
        />
        <p id="voucher-ayuda" className="mt-1 text-xs text-[var(--color-gris)]">
          JPG, PNG, WEBP o HEIC. Máximo 5 MB. Que se vea el monto y el número de operación.
        </p>
      </div>

      {previa !== null && (
        <figure className="mt-4">
          {/* `next/image` no aplica aquí: es un blob local del navegador, no una
              imagen remota que se pueda optimizar en el servidor. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={previa}
            alt={`Vista previa de ${nombreArchivo ?? "tu comprobante"}`}
            className="max-h-64 rounded-lg border border-[var(--color-borde)] object-contain"
          />
          <figcaption className="mt-1 text-xs text-[var(--color-gris)]">
            Revisa que se lea el monto {formatSoles(totalCents)} antes de enviar.
          </figcaption>
        </figure>
      )}

      <div className="mt-5">
        <label htmlFor="operationNumber" className="block text-sm font-semibold">
          Número de operación
          <span aria-hidden="true" className="text-[var(--color-alerta)]">
            {" "}
            *
          </span>
          <span className="solo-lectores"> (obligatorio)</span>
        </label>
        <input
          id="operationNumber"
          name="operationNumber"
          type="text"
          inputMode="numeric"
          required
          autoComplete="off"
          placeholder="Ej. 12345678"
          aria-describedby="operacion-ayuda"
          className="cifra mt-1 w-full rounded-lg border border-[var(--color-borde)] px-3 py-2.5 text-sm"
        />
        <p id="operacion-ayuda" className="mt-1 text-xs text-[var(--color-gris)]">
          Aparece en tu Yape como &quot;N° de operación&quot;. Cada operación sirve para un solo
          pedido.
        </p>
      </div>

      {error !== null && (
        <p
          role="alert"
          className="mt-4 rounded-lg border border-[var(--color-alerta)] bg-[var(--color-alerta)]/5 px-4 py-3 text-sm font-medium text-[var(--color-alerta)]"
        >
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={enviando}
        className="mt-6 w-full rounded-full bg-[var(--color-acento)] px-6 py-4 font-bold text-[var(--color-tinta)] transition hover:bg-[var(--color-acento-oscuro)] disabled:opacity-50"
      >
        {enviando ? "Enviando comprobante..." : "Enviar comprobante"}
      </button>
    </form>
  );
}
