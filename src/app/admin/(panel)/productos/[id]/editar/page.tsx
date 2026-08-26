import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { listarMarcasAdmin, obtenerProductoAdminDetalle } from "@/lib/admin/queries";
import { FormularioEdicion } from "./formulario";

export const metadata: Metadata = {
  title: "Editar Producto",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function EditarProductoPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [producto, marcas] = await Promise.all([
    obtenerProductoAdminDetalle(id),
    listarMarcasAdmin(),
  ]);

  if (producto === null) {
    notFound();
  }

  return (
    <div>
      <FormularioEdicion producto={producto} marcas={marcas} />
    </div>
  );
}
