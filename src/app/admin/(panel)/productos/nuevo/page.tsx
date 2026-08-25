import type { Metadata } from "next";
import Link from "next/link";
import { listarMarcasAdmin } from "@/lib/admin/queries";
import { FormularioAlta } from "./formulario";

export const metadata: Metadata = {
  title: "Nuevo producto",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function NuevoProductoPage() {
  const marcas = await listarMarcasAdmin();

  return (
    <div className="max-w-3xl">
      <Link href="/admin/productos" className="text-sm underline underline-offset-4">
        ← Volver a productos
      </Link>
      <h1 className="titular mt-3 text-3xl">Cargar producto nuevo</h1>
      <p className="mt-1 text-sm text-[var(--color-gris)]">
        Llegó mercadería: márcala acá y queda lista para publicar.
      </p>

      {marcas.length === 0 ? (
        <p className="mt-10 rounded-xl border border-[var(--color-borde)] p-10 text-center text-sm text-[var(--color-gris)]">
          No hay marcas cargadas. Ejecuta <code>supabase/seed.sql</code> o inserta al menos una
          marca antes de dar de alta productos.
        </p>
      ) : (
        <div className="mt-8">
          <FormularioAlta marcas={marcas} />
        </div>
      )}
    </div>
  );
}
