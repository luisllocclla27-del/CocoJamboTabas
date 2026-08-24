import Link from "next/link";
import { redirect } from "next/navigation";
import { isSupabaseConfigured } from "@/lib/env";
import { createServerClient, isAdmin } from "@/lib/supabase/server";
import { cerrarSesion } from "@/lib/admin/auth";

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

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--color-borde)] pb-4">
        <div>
          <p className="titular text-xl">Panel</p>
          <p className="text-xs text-[var(--color-gris)]">{user.email}</p>
        </div>
        <form action={cerrarSesion}>
          <button
            type="submit"
            className="rounded-full border border-[var(--color-borde)] px-4 py-1.5 text-sm font-medium hover:border-[var(--color-tinta)]"
          >
            Cerrar sesión
          </button>
        </form>
      </div>

      <NavegacionPanel />

      <div className="mt-6">{children}</div>
    </div>
  );
}

function NavegacionPanel() {
  const enlaces = [
    { href: "/admin", texto: "Resumen" },
    { href: "/admin/pagos", texto: "Verificar pagos" },
    { href: "/admin/pedidos", texto: "Pedidos" },
    { href: "/admin/productos", texto: "Productos" },
    { href: "/admin/espera", texto: "Lista de espera" },
  ];
  return (
    <nav aria-label="Secciones del panel" className="mt-4 overflow-x-auto">
      <ul className="flex gap-1">
        {enlaces.map((enlace) => (
          <li key={enlace.href}>
            <Link
              href={enlace.href}
              className="block whitespace-nowrap rounded-full px-4 py-2 text-sm font-medium hover:bg-[var(--color-humo)]"
            >
              {enlace.texto}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
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
