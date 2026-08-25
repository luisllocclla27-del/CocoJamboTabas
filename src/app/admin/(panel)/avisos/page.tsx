import type { Metadata } from "next";
import Link from "next/link";
import { listarAvisos, type AvisosPanel } from "@/lib/admin/outbox-queries";
import { FichaAviso } from "./ficha";

export const metadata: Metadata = {
  title: "Avisos",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * Cola de avisos.
 *
 * POR QUÉ ESTA PANTALLA EXISTE: los avisos de WhatsApp se encolan en `outbox` en la
 * misma transacción que el cambio de estado del pedido, pero no hay proveedor
 * conectado que los mande. Sin esta pantalla el sistema redactaba mensajes que nadie
 * veía nunca: el cliente pagaba y no recibía confirmación.
 *
 * Acá el comerciante lee el mensaje ya escrito, lo manda con un clic y registra que
 * lo hizo. Es el mismo trato que la lista de espera, y es honesto sobre quién
 * ejecuta el envío.
 */
export default async function AvisosPage() {
  let avisos: AvisosPanel;
  try {
    avisos = await listarAvisos();
  } catch {
    // El caso real es la migración 0005 sin aplicar. Un stack trace no le dice nada
    // al comerciante; el nombre del archivo que falta, sí.
    return (
      <div>
        <h1 className="titular text-3xl">Avisos</h1>
        <p className="mt-6 rounded-xl border border-[var(--color-alerta)] bg-[var(--color-alerta)]/5 p-5 text-sm">
          No se pudo leer la cola de avisos. Lo más probable es que falte aplicar{" "}
          <code>supabase/migrations/0005_outbox.sql</code> en Supabase. Revisa{" "}
          <Link href="/diagnostico" className="underline underline-offset-4">
            /diagnostico
          </Link>{" "}
          para confirmarlo.
        </p>
      </div>
    );
  }

  const porMandar = avisos.pendientes.length + avisos.fallidos.length;

  return (
    <div>
      <h1 className="titular text-3xl">Avisos</h1>
      <p className="mt-1 text-sm text-[var(--color-gris)]">
        Mensajes que el sistema ya redactó. Los mandas tú desde WhatsApp: no hay envío automático.
      </p>

      {porMandar === 0 ? (
        <div className="mt-10 rounded-xl border border-[var(--color-borde)] p-10 text-center">
          <p className="titular text-2xl">Nada por avisar</p>
          <p className="mt-2 text-sm text-[var(--color-gris)]">
            Cuando entre un comprobante o apruebes un pago, el mensaje aparecerá acá listo para
            mandar.
          </p>
        </div>
      ) : (
        <p className="mt-4 rounded-lg bg-[var(--color-acento)] px-4 py-2.5 text-sm font-semibold text-[var(--color-tinta)]">
          {porMandar} {porMandar === 1 ? "aviso" : "avisos"} por mandar. Cada uno es un cliente
          esperando respuesta.
        </p>
      )}

      {avisos.fallidos.length > 0 && (
        <section className="mt-8">
          <h2 className="font-bold">Fallaron</h2>
          <p className="mt-1 text-sm text-[var(--color-gris)]">
            El sistema no pudo cerrarlos. Mándalos a mano o descártalos.
          </p>
          <ul className="mt-4 space-y-3">
            {avisos.fallidos.map((aviso) => (
              <li key={aviso.id}>
                <FichaAviso aviso={aviso} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {avisos.pendientes.length > 0 && (
        <section className="mt-8">
          <h2 className="font-bold">Pendientes</h2>
          <p className="mt-1 text-sm text-[var(--color-gris)]">
            En el mismo orden en que los tomaría el procesado automático.
          </p>
          <ul className="mt-4 space-y-3">
            {avisos.pendientes.map((aviso) => (
              <li key={aviso.id}>
                <FichaAviso aviso={aviso} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {avisos.enviados.length > 0 && (
        <section className="mt-10">
          <h2 className="font-bold">Últimos cerrados</h2>
          <p className="mt-1 text-sm text-[var(--color-gris)]">
            Solo para recuperar el texto. Ojo: &quot;cerrado&quot; significa que el mensaje quedó
            listo, no que el cliente lo recibió.
          </p>
          <ul className="mt-4 space-y-3">
            {avisos.enviados.map((aviso) => (
              <li key={aviso.id}>
                <FichaAviso aviso={aviso} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
