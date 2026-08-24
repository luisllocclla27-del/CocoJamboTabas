import type { Metadata } from "next";
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
      <h1 className="titular text-3xl">Productos y stock</h1>
      <p className="mt-1 text-sm text-[var(--color-gris)]">
        Ajusta el stock talla por talla al recibir mercadería. Los cambios se ven en la tienda al
        instante.
      </p>

      {productos.length === 0 ? (
        <p className="mt-10 rounded-xl border border-[var(--color-borde)] p-10 text-center text-sm text-[var(--color-gris)]">
          No hay productos cargados. Ejecuta <code>supabase/seed.sql</code> para ver el catálogo de
          ejemplo.
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
        Para dar de alta un producto nuevo con sus fotos, por ahora se hace desde el SQL Editor de
        Supabase. El formulario de alta es lo siguiente en la lista.
      </p>
    </div>
  );
}
