import type { Metadata } from "next";
import { listarListaEspera } from "@/lib/admin/queries";
import { FilaEspera } from "./fila";

export const metadata: Metadata = {
  title: "Lista de espera",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * Lista de espera.
 *
 * Es la señal de reposición más valiosa del negocio: dice qué modelo y talla pide
 * la gente, con su WhatsApp detrás. Reponer con esto es reponer con demanda real en
 * vez de con intuición.
 *
 * Se separa en dos bloques porque son dos tareas distintas: arriba lo que ya tiene
 * stock y se puede avisar ahora mismo (venta inmediata), abajo lo que hay que
 * comprar.
 */
export default async function EsperaPage() {
  const espera = await listarListaEspera();
  const conStock = espera.filter((e) => e.stockActual > 0);
  const sinStock = espera.filter((e) => e.stockActual === 0);

  // Agrupa la demanda por modelo y talla: es la vista que sirve para decidir la
  // compra, en lugar de una lista de personas.
  const demanda = new Map<string, { modelo: string; colorway: string; sizeUs: number; personas: number }>();
  for (const item of sinStock) {
    const clave = `${item.modelo}|${item.colorway}|${item.sizeUs}`;
    const previo = demanda.get(clave);
    demanda.set(clave, {
      modelo: item.modelo,
      colorway: item.colorway,
      sizeUs: item.sizeUs,
      personas: (previo?.personas ?? 0) + 1,
    });
  }
  const paraReponer = [...demanda.values()].sort((a, b) => b.personas - a.personas);

  return (
    <div>
      <h1 className="titular text-3xl">Lista de espera</h1>
      <p className="mt-1 text-sm text-[var(--color-gris)]">
        {espera.length === 0
          ? "Nadie esperando reposición ahora mismo."
          : `${espera.length} ${espera.length === 1 ? "persona" : "personas"} esperando aviso.`}
      </p>

      {conStock.length > 0 && (
        <section className="mt-6">
          <h2 className="font-bold">Avisa ahora: ya hay stock</h2>
          <p className="mt-1 text-sm text-[var(--color-gris)]">
            Estas tallas volvieron a entrar. Cada aviso es una venta a punto de cerrarse.
          </p>
          <ul className="mt-4 space-y-3">
            {conStock.map((item) => (
              <li key={item.id}>
                <FilaEspera item={item} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {paraReponer.length > 0 && (
        <section className="mt-10">
          <h2 className="font-bold">Qué reponer</h2>
          <p className="mt-1 text-sm text-[var(--color-gris)]">
            Ordenado por cuánta gente lo está pidiendo.
          </p>
          <ul className="mt-4 divide-y divide-[var(--color-borde)] text-sm">
            {paraReponer.map((d) => (
              <li key={`${d.modelo}-${d.sizeUs}`} className="flex justify-between gap-3 py-2.5">
                <span>
                  <span className="block font-medium">{d.modelo}</span>
                  <span className="cifra text-xs text-[var(--color-gris)]">
                    {d.colorway} · US {formatearTalla(d.sizeUs)}
                  </span>
                </span>
                <span className="cifra shrink-0 font-bold">
                  {d.personas} {d.personas === 1 ? "persona" : "personas"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {sinStock.length > 0 && (
        <section className="mt-10">
          <h2 className="font-bold">Esperando reposición</h2>
          <ul className="mt-4 space-y-3">
            {sinStock.map((item) => (
              <li key={item.id}>
                <FilaEspera item={item} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {espera.length === 0 && (
        <p className="mt-10 rounded-xl border border-[var(--color-borde)] p-10 text-center text-sm text-[var(--color-gris)]">
          Cuando alguien pida aviso de una talla agotada aparecerá acá.
        </p>
      )}
    </div>
  );
}

function formatearTalla(valor: number): string {
  return Number.isInteger(valor) ? String(valor) : valor.toFixed(1);
}
