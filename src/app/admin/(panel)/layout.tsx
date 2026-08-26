import Link from "next/link";
import { redirect } from "next/navigation";
import { isSupabaseConfigured } from "@/lib/env";
import { createServerClient, isAdmin } from "@/lib/supabase/server";
import { cerrarSesion } from "@/lib/admin/auth";
import { obtenerResumen } from "@/lib/admin/queries";
import { NavegacionPanelInteractiva } from "./navegacion";

/**
 * Layout del panel.
 *
 * AQUÍ ESTÁ LA AUTORIZACIÓN REAL, no en el middleware. El middleware solo
 * comprueba que exista una sesión; esta comprobación verifica que ese usuario esté
 * en `admin_users`, y lo hace consultando la tabla en cada carga en lugar de
 * confiar en un claim del JWT: revocar el acceso a alguien tiene que surtir efecto
 * de inmediato, no cuando caduque su token.
 *
 * Y sigue habiendo una tercera capa por debajo: las políticas RLS de Postgres.
 * Incluso si este layout tuviera un bug, un usuario sin permisos no podría leer un
 * voucher ni un teléfono, porque `is_admin()` se evalúa dentro de la base.
 */

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  if (!isSupabaseConfigured()) redirect("/");

  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user === null) redirect("/admin/login");

  if (!(await isAdmin())) return <SinPermisos email={user.email ?? ""} />;

  let metricas = undefined;
  try {
    const resumen = await obtenerResumen();
    metricas = {
      porVerificar: resumen.porVerificar,
      avisosPendientes: resumen.avisosPendientes,
      enEspera: resumen.enEspera,
    };
  } catch {
    // Si falla el resumen (ej: migraciones pendientes), el panel debe seguir cargando
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--color-borde)] pb-4">
        <div className="flex items-center gap-3">
          <Link href="/" className="titular text-xl tracking-tight text-[var(--color-tinta)] hover:opacity-80">
            COCO<span className="text-[var(--color-acento-oscuro)]">JAMBO</span>
          </Link>
          <span className="text-xs font-bold uppercase tracking-wider bg-[var(--color-humo)] px-2 py-0.5 rounded text-[var(--color-gris)]">
            Admin
          </span>
          <span className="text-xs text-[var(--color-gris)] hidden sm:inline">{user.email}</span>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/"
            target="_blank"
            className="text-xs font-semibold text-[var(--color-gris)] hover:text-[var(--color-tinta)]"
          >
            Ir a la tienda ↗
          </Link>
          <form action={cerrarSesion}>
            <button
              type="submit"
              className="rounded-full border border-[var(--color-borde)] px-4 py-1.5 text-xs font-semibold hover:border-[var(--color-tinta)] cursor-pointer"
            >
              Cerrar sesión
            </button>
          </form>
        </div>
      </div>

      <NavegacionPanelInteractiva metricas={metricas} />

      <div className="mt-6">{children}</div>
    </div>
  );
}

/**
 * Sesión válida sin permisos de admin.
 *
 * Se distingue de "no has iniciado sesión" a propósito: si a alguien del equipo se
 * le olvidó darle permisos, un mensaje claro ahorra media hora de confusión.
 */
function SinPermisos({ email }: { email: string }) {
  return (
    <div className="mx-auto max-w-lg px-4 py-20">
      <h1 className="titular text-3xl">Sin acceso al panel</h1>
      <p className="mt-3 text-[var(--color-gris)]">
        Tu cuenta ({email}) inició sesión, pero no está autorizada como administradora.
      </p>
      <p className="mt-4 rounded-lg bg-[var(--color-humo)] p-4 text-sm">
        Para autorizarla, ejecuta esto en el SQL Editor de Supabase:
      </p>
      <pre className="mt-2 overflow-x-auto rounded-lg bg-[var(--color-tinta)] p-4 text-xs text-[var(--color-papel)]">
        {`insert into admin_users (id, rol)
select id, 'admin' from auth.users
where email = '${email}';`}
      </pre>
      <form action={cerrarSesion} className="mt-6">
        <button type="submit" className="text-sm underline underline-offset-4">
          Cerrar sesión
        </button>
      </form>
    </div>
  );
}
