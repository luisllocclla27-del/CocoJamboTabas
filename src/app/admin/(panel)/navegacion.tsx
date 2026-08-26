"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export type MetricasNavegacion = {
  porVerificar: number;
  avisosPendientes: number;
  enEspera: number;
};

export function NavegacionPanelInteractiva({
  metricas,
}: {
  metricas?: MetricasNavegacion;
}) {
  const pathname = usePathname();

  const enlaces = [
    { href: "/admin", texto: "Resumen", exact: true },
    {
      href: "/admin/pagos",
      texto: "Verificar pagos",
      badge: metricas?.porVerificar && metricas.porVerificar > 0 ? metricas.porVerificar : null,
      badgeColor: "bg-[var(--color-alerta)] text-white",
    },
    { href: "/admin/pedidos", texto: "Pedidos" },
    { href: "/admin/productos", texto: "Productos y stock" },
    {
      href: "/admin/avisos",
      texto: "Avisos WhatsApp",
      badge: metricas?.avisosPendientes && metricas.avisosPendientes > 0 ? metricas.avisosPendientes : null,
      badgeColor: "bg-[var(--color-acento)] text-[var(--color-tinta)]",
    },
    {
      href: "/admin/espera",
      texto: "Lista de espera",
      badge: metricas?.enEspera && metricas.enEspera > 0 ? metricas.enEspera : null,
      badgeColor: "bg-[var(--color-humo)] text-[var(--color-tinta)] border border-[var(--color-borde)]",
    },
  ];

  return (
    <nav aria-label="Secciones del panel" className="mt-4 overflow-x-auto pb-1 scrollbar-none">
      <ul className="flex items-center gap-1.5 min-w-max">
        {enlaces.map((enlace) => {
          const activo = enlace.exact
            ? pathname === enlace.href
            : pathname === enlace.href || pathname.startsWith(`${enlace.href}/`);

          return (
            <li key={enlace.href}>
              <Link
                href={enlace.href}
                className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition ${
                  activo
                    ? "bg-[var(--color-tinta)] text-[var(--color-papel)] shadow-xs"
                    : "text-[var(--color-gris)] hover:bg-[var(--color-humo)] hover:text-[var(--color-tinta)]"
                }`}
              >
                <span>{enlace.texto}</span>
                {enlace.badge !== undefined && enlace.badge !== null && (
                  <span
                    className={`inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-bold ${enlace.badgeColor}`}
                  >
                    {enlace.badge}
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
