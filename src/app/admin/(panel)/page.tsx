import type { Metadata } from "next";
import Link from "next/link";
import { formatSoles } from "@/lib/money";
import { obtenerProductosSinStock, obtenerResumen } from "@/lib/admin/queries";

export const metadata: Metadata = {
  title: "Resumen",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * Resumen del panel.
 *
 * Las cuatro cifras están elegidas por lo que hacen decidir, no por lo que se ve
 * bien en un dashboard: cuántos pagos esperan revisión (trabajo pendiente ahora),
 * la ganancia real del mes (no las ventas brutas, que engañan), qué tallas se
 * están agotando y qué tallas rotan. Las dos últimas son las que deciden la
 * siguiente compra de mercadería.
 */
export default async function ResumenPage() {
  const [resumen, sinStock] = await Promise.all([obtenerResumen(), obtenerProductosSinStock()]);

  return (
    <div>
      <h1 className="titular text-3xl">Resumen</h1>

      {resumen.porVerificar > 0 && (
        <Link
          href="/admin/pagos"
          className="mt-5 flex items-center justify-between gap-4 rounded-xl border-2 border-[var(--color-tinta)] bg-[var(--color-acento)] p-5"
        >
          <span>
            <span className="titular block text-2xl">
              {resumen.porVerificar}{" "}
              {resumen.porVerificar === 1 ? "pago por verificar" : "pagos por verificar"}
            </span>
            <span className="text-sm">
              Cada minuto que pasa es un cliente esperando confirmación.
            </span>
          </span>
          <span aria-hidden="true" className="text-2xl font-bold">
            →
          </span>
        </Link>
      )}

      {resumen.avisosPendientes > 0 && (
        <Link
          href="/admin/avisos"
          className="mt-3 flex items-center justify-between gap-4 rounded-xl border border-[var(--color-borde)] p-5 hover:border-[var(--color-tinta)]"
        >
          <span>
            <span className="titular block text-2xl">
              {resumen.avisosPendientes}{" "}
              {resumen.avisosPendientes === 1 ? "aviso por mandar" : "avisos por mandar"}
            </span>
            <span className="text-sm text-[var(--color-gris)]">
              Mensajes ya redactados esperando que los envíes por WhatsApp.
            </span>
          </span>
          <span aria-hidden="true" className="text-2xl font-bold">
            →
          </span>
        </Link>
      )}

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Tarjeta
          etiqueta="Ventas del mes"
          valor={formatSoles(resumen.ventasMesCents)}
          nota={`${resumen.pedidosMes} ${resumen.pedidosMes === 1 ? "pedido" : "pedidos"}`}
        />
        <Tarjeta
          etiqueta="Ganancia real del mes"
          valor={formatSoles(resumen.gananciaMesCents)}
          nota="Precio de venta menos costo"
          destacada
        />
        <Tarjeta
          etiqueta="Esperando aviso"
          valor={String(resumen.enEspera)}
          nota="Personas en lista de espera"
        />
        <Tarjeta
          etiqueta="Agotados publicados"
          valor={String(sinStock)}
          nota={sinStock > 0 ? "Sin stock activo · Puedes ocultarlos" : "Catálogo al día"}
        />
      </div>

      <div className="mt-8 grid gap-8 lg:grid-cols-2">
        <section>
          <h2 className="font-bold">Tallas por agotarse</h2>
          <p className="mt-1 text-sm text-[var(--color-gris)]">
            Quedan 2 pares o menos. Es lo que hay que reponer primero.
          </p>
          {resumen.tallasPorAgotarse.length === 0 ? (
            <p className="mt-4 text-sm text-[var(--color-gris)]">
              Nada crítico ahora mismo.
            </p>
          ) : (
            <ul className="mt-4 divide-y divide-[var(--color-borde)] text-sm">
              {resumen.tallasPorAgotarse.map((t) => (
                <li key={`${t.slug}-${t.sizeUs}`} className="flex justify-between gap-3 py-2.5">
                  <span>
                    <span className="block font-medium">{t.modelo}</span>
                    <span className="cifra text-xs text-[var(--color-gris)]">
                      {t.colorway} · US {formatearTalla(t.sizeUs)}
                    </span>
                  </span>
                  <span
                    className={`cifra shrink-0 font-bold ${
                      t.stock === 1 ? "text-[var(--color-alerta)]" : "text-[var(--color-aviso)]"
                    }`}
                  >
                    {t.stock}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h2 className="font-bold">Tallas que más rotan este mes</h2>
          <p className="mt-1 text-sm text-[var(--color-gris)]">
            Con esto decides cuántos pares comprar de cada talla.
          </p>
          {resumen.tallasQueRotan.length === 0 ? (
            <p className="mt-4 text-sm text-[var(--color-gris)]">
              Todavía no hay ventas este mes.
            </p>
          ) : (
            <ul className="mt-4 space-y-2">
              {resumen.tallasQueRotan.map((t) => {
                const maximo = resumen.tallasQueRotan[0].unidades;
                return (
                  <li key={t.sizeUs} className="flex items-center gap-3 text-sm">
                    <span className="cifra w-16 shrink-0 font-semibold">
                      US {formatearTalla(t.sizeUs)}
                    </span>
                    {/* Barra proporcional: comparar de un vistazo es el objetivo,
                        no leer cifras exactas. */}
                    <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-[var(--color-humo)]">
                      <span
                        className="block h-full rounded-full bg-[var(--color-tinta)]"
                        style={{ width: `${Math.round((t.unidades / maximo) * 100)}%` }}
                      />
                    </span>
                    <span className="cifra w-10 shrink-0 text-right text-[var(--color-gris)]">
                      {t.unidades}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function Tarjeta({
  etiqueta,
  valor,
  nota,
  destacada = false,
}: {
  etiqueta: string;
  valor: string;
  nota: string;
  destacada?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border p-4 ${
        destacada
          ? "border-[var(--color-tinta)] bg-[var(--color-humo)]"
          : "border-[var(--color-borde)]"
      }`}
    >
      <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-gris)]">
        {etiqueta}
      </p>
      <p className="cifra mt-1 text-2xl font-bold">{valor}</p>
      <p className="mt-1 text-xs text-[var(--color-gris)]">{nota}</p>
    </div>
  );
}

function formatearTalla(valor: number): string {
  return Number.isInteger(valor) ? String(valor) : valor.toFixed(1);
}
