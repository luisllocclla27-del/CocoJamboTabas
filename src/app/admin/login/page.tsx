import type { Metadata } from "next";
import { FormularioLogin } from "./formulario";

export const metadata: Metadata = {
  title: "Acceso al panel",
  // El login del panel no debe aparecer en buscadores.
  robots: { index: false, follow: false },
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ volver?: string }>;
}) {
  const { volver } = await searchParams;
  return (
    <div className="mx-auto flex min-h-[70vh] max-w-sm flex-col justify-center px-4 py-12">
      <h1 className="titular text-3xl">Panel Coco Jambo</h1>
      <p className="mt-2 text-sm text-[var(--color-gris)]">
        Acceso solo para el equipo de la tienda.
      </p>
      <FormularioLogin volver={volver ?? "/admin"} />
    </div>
  );
}
