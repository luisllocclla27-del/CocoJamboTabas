import type { Metadata } from "next";
import Link from "next/link";
import { formatSoles, margin } from "@/lib/money";
import { listarProductosAdmin } from "@/lib/admin/queries";
import { FilaProducto } from "./fila";

export const metadata: Metadata = {
  title: "Productos",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function ProductosPage() {
  const productos = await listarProductosAdmin();

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="titular text-3xl">Productos y stock</h1>
          <p className="mt-1 text-sm text-[var(--color-gris)]">
            Ajusta el stock talla por talla al recibir mercadería. Los cambios se ven en la tienda
            al instante.
          </p>
        </div>
        <Link
          href="/admin/productos/nuevo"
          className="rounded-full bg-[var(--color-acento)] px-5 py-2.5 text-sm font-bold text-[var(--color-tinta)]"
        >
          Cargar producto nuevo
        </Link>
      </div>

      {productos.length === 0 ? (
        <p className="mt-10 rounded-xl border border-[var(--color-borde)] p-10 text-center text-sm text-[var(--color-gris)]">
          No hay productos cargados. Usa <strong>Cargar producto nuevo</strong>, o ejecuta{" "}
          <code>supabase/seed.sql</code> para ver el catálogo de ejemplo.
        </p>
      ) : (
        <ul className="mt-6 space-y-4">
          {productos.map((producto) => {
            const { porcentaje } = margin(producto.priceCents, producto.costCents);
            return (
              <li key={producto.id}>
                <FilaProducto
                  producto={producto}
                  margenTexto={`${formatSoles(producto.priceCents - producto.costCents)} (${porcentaje.toFixed(0)}%)`}
                />
              </li>
            );
          })}
        </ul>
      )}

      <p className="mt-8 rounded-lg bg-[var(--color-humo)] p-4 text-sm text-[var(--color-gris)]">
        Los productos nuevos nacen ocultos: se publican con{" "}
        <strong>Mostrar en la tienda</strong> cuando las fotos y las tallas están como quieres.
      </p>
    </div>
  );
}
