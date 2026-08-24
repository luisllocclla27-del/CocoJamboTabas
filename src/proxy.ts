import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";

/**
 * Proxy (antes `middleware`): refresco de sesión y puerta del panel.
 *
 * Se llama `proxy.ts` porque Next 16 deprecó el nombre `middleware`. Es el mismo
 * concepto: se ejecuta antes de cada petición que casa con el `matcher`.
 *
 * Dos funciones, y el orden importa:
 *
 * 1. REFRESCAR LA SESIÓN. Los tokens de Supabase caducan; sin refrescarlos en cada
 *    petición, un admin trabajando en la cola de verificación empezaría a recibir
 *    errores de permisos a mitad de sesión. `getUser()` fuerza la validación
 *    contra el servidor de Supabase y renueva las cookies.
 *
 * 2. BLOQUEAR `/admin` A QUIEN NO HAYA INICIADO SESIÓN. Esto es una PRIMERA
 *    barrera, no la única: es conveniencia de UX (redirige al login en vez de
 *    mostrar una pantalla vacía). La autorización real la imponen las políticas
 *    RLS de Postgres y la comprobación `is_admin()` en el layout del panel.
 *    Confiar solo en esta capa sería un error clásico: no ve las peticiones que no
 *    pasan por ella, y un fallo de configuración la dejaría inerte sin que nadie
 *    lo note.
 *
 * Deliberadamente NO se comprueba aquí si el usuario está en `admin_users`: eso
 * exigiría una consulta a la base en cada petición del sitio entero. La
 * comprobación de rol vive en el layout del panel, que es donde importa.
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // Sin configuración no hay sesión que refrescar. Se deja pasar para que la app
  // pueda arrancar y mostrar sus instrucciones de configuración.
  if (url === undefined || anonKey === undefined) return response;

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: Array<{ name: string; value: string; options: CookieOptions }>) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        // La respuesta se reconstruye con la petición ya actualizada: si no, las
        // cookies renovadas no llegan al navegador y la sesión caduca igual.
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const esRutaAdmin = request.nextUrl.pathname.startsWith("/admin");
  const esLogin = request.nextUrl.pathname === "/admin/login";

  if (esRutaAdmin && !esLogin && user === null) {
    const login = new URL("/admin/login", request.url);
    // Se conserva el destino para volver ahí tras iniciar sesión, en vez de
    // dejar al admin en la home teniendo que navegar otra vez.
    login.searchParams.set("volver", request.nextUrl.pathname);
    return NextResponse.redirect(login);
  }

  // Un admin ya autenticado que abre el login va directo al panel.
  if (esLogin && user !== null) {
    return NextResponse.redirect(new URL("/admin", request.url));
  }

  return response;
}

export const config = {
  /**
   * Se excluyen los assets estáticos y las imágenes.
   *
   * No es solo rendimiento: cada invocación hace una llamada de validación de
   * sesión a Supabase, y aplicarlo a cada archivo estático multiplicaría ese
   * tráfico por el número de recursos de la página.
   */
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
