import type { Metadata } from "next";
import Link from "next/link";
import { formatSoles } from "@/lib/money";
import { ETIQUETA_ADMIN, ORDER_STATUSES, type OrderStatus } from "@/lib/order-status";
import { listarPedidos } from "@/lib/admin/queries";
import { FichaPedido } from "./ficha";

export const metadata: Metadata = {
  title: "Pedidos",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function PedidosPage({
  searchParams,
}: {
  searchParams: Promise<{ estado?: string }>;
}) {
  const { estado } = await searchParams;
  // El filtro viene de la URL, que es texto arbitrario: se acota al enum.
  const filtro = (ORDER_STATUSES as readonly string[]).includes(estado ?? "")
    ? (estado as OrderStatus)
    : undefined;

  const pedidos = await listarPedidos(filtro);

  return (
    <div>
      <h1 className="titular text-3xl">Pedidos</h1>
      <p className="mt-1 text-sm text-[var(--color-gris)]">
        {pedidos.length === 0
          ? "Sin pedidos que mostrar."
          : `${pedidos.length} ${pedidos.length === 1 ? "pedido" : "pedidos"} (máximo 100 más recientes)`}
      </p>

      <div className="mt-5 flex flex-wrap gap-2">
        <Chip href="/admin/pedidos" activo={filtro === undefined}>
          Todos
        </Chip>
        {ORDER_STATUSES.map((s) => (
          <Chip key={s} href={`/admin/pedidos?estado=${s}`} activo={filtro === s}>
            {ETIQUETA_ADMIN[s]}
          </Chip>
        ))}
      </div>

      {pedidos.length === 0 ? (
        <p className="mt-10 rounded-xl border border-[var(--color-borde)] p-10 text-center text-sm text-[var(--color-gris)]">
          No hay pedidos con ese filtro.
        </p>
      ) : (
        <ul className="mt-6 space-y-4">
          {pedidos.map((pedido) => (
            <li key={pedido.id}>
              <FichaPedido pedido={pedido} />
            </li>
          ))}
        </ul>
      )}

      <p className="mt-8 text-sm text-[var(--color-gris)]">
        Ganancia total de lo mostrado:{" "}
        <span className="cifra font-semibold">
          {formatSoles(pedidos.reduce((s, p) => s + p.gananciaCents, 0))}
        </span>
      </p>
    </div>
  );
}

function Chip({
  href,
  activo,
  children,
}: {
  href: string;
  activo: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={activo ? "true" : undefined}
      className={`rounded-full border px-3.5 py-1.5 text-sm transition ${
        activo
          ? "border-[var(--color-tinta)] bg-[var(--color-tinta)] font-semibold text-[var(--color-papel)]"
          : "border-[var(--color-borde)] hover:border-[var(--color-tinta)]"
      }`}
    >
      {children}
    </Link>
  );
}
