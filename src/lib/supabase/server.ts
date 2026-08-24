/**
 * Cliente de Supabase para componentes de servidor y Server Actions.
 *
 * Está en su propio archivo porque importa `next/headers`, que solo existe en el
 * runtime de servidor. Si viviera junto al cliente de navegador, el bundler lo
 * arrastraría al bundle del cliente y fallaría el build.
 */

import { createServerClient as createSsrServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getPublicEnv } from "@/lib/env";

/**
 * Cliente con la sesión del usuario propagada desde las cookies, para que la RLS
 * pueda evaluar `auth.uid()` y por tanto `is_admin()`.
 */
export async function createServerClient() {
  const env = getPublicEnv();
  const cookieStore = await cookies();

  return createSsrServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: Array<{ name: string; value: string; options: CookieOptions }>) {
          // En un componente de servidor (no una Server Action ni una Route
          // Handler) escribir cookies lanza. No es un error recuperable ni algo
          // que haya que reportar: el middleware ya refrescó la sesión, así que
          // ignorarlo aquí es correcto y es el patrón que documenta Supabase.
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Intencionalmente vacío. Ver comentario de arriba.
          }
        },
      },
    },
  );
}

/**
 * ¿El usuario de la sesión actual es admin?
 *
 * Consulta `admin_users` en vez de confiar en un claim del JWT: revocar el
 * acceso a alguien debe surtir efecto de inmediato, no cuando expire su token.
 */
export async function isAdmin(): Promise<boolean> {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return false;

  const { data, error } = await supabase
    .from("admin_users")
    .select("id")
    .eq("id", user.id)
    .maybeSingle();

  return !error && data !== null;
}
