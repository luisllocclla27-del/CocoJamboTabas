import type { Metadata } from "next";
import { listarComprobantesPendientes } from "@/lib/admin/queries";
import { FichaComprobante } from "./ficha";

export const metadata: Metadata = {
  title: "Verificar pagos",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * Cola de verificación: la pantalla más usada del panel.
 *
 * Está ordenada por riesgo ascendente para que el admin apruebe rápido lo limpio y
 * concentre la atención en lo dudoso. Ordenar por antigüedad, que sería lo
 * intuitivo, mezcla un caso sospechoso entre veinte legítimos, y es justo ahí donde
 * se aprueba un fraude por inercia.
 */
export default async function PagosPage() {
  const pendientes = await listarComprobantesPendientes();

  return (
    <div>
      <h1 className="titular text-3xl">Verificar pagos</h1>
      <p className="mt-1 text-sm text-[var(--color-gris)]">
        {pendientes.length === 0
          ? "Sin comprobantes pendientes."
          : `${pendientes.length} ${pendientes.length === 1 ? "comprobante" : "comprobantes"} esperando revisión. Los más limpios aparecen primero.`}
      </p>

      {pendientes.length === 0 ? (
        <div className="mt-10 rounded-xl border border-[var(--color-borde)] p-10 text-center">
          <p className="titular text-2xl">Todo al día</p>
          <p className="mt-2 text-sm text-[var(--color-gris)]">
            Cuando entre un comprobante nuevo aparecerá acá.
          </p>
        </div>
      ) : (
        <ul className="mt-6 space-y-5">
          {pendientes.map((comprobante) => (
            <li key={comprobante.paymentId}>
              <FichaComprobante comprobante={comprobante} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
