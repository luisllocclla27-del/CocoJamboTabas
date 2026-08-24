/**
 * Clientes de Supabase, uno por contexto de ejecución.
 *
 * Hay tres, y confundirlos es el error de seguridad más fácil de cometer en este
 * proyecto:
 *
 * 1. `createBrowserClient()` — navegador. Usa la `anon key`, que es pública por
 *    diseño. Lo que impide que un visitante lea pedidos ajenos son las políticas
 *    RLS, no el secreto de la clave.
 *
 * 2. `createServerClient()` — componentes de servidor y Server Actions. También
 *    usa la `anon key`, pero propaga la sesión del usuario desde las cookies, de
 *    modo que la RLS puede evaluar `auth.uid()` y aplicar `is_admin()`.
 *
 * 3. `createAdminClient()` — **omite la RLS por completo**. Solo para las
 *    operaciones que legítimamente necesitan saltarse las políticas: crear un
 *    pedido de un visitante anónimo, procesar un webhook firmado, o firmar la
 *    URL de un voucher. Cada llamada a este cliente es una decisión de seguridad
 *    y debería tener al lado un comentario que la justifique.
 *
 * El módulo lanza si el cliente admin se construye en el navegador. Es una
 * barrera en tiempo de ejecución sobre algo que el tipado no puede garantizar.
 */

import { createBrowserClient as createSsrBrowserClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { getPublicEnv } from "@/lib/env";

/** Cliente para el navegador. Sujeto a RLS. */
export function createBrowserClient() {
  const env = getPublicEnv();
  return createSsrBrowserClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

/**
 * Cliente que omite la RLS. Solo servidor.
 *
 * @throws si falta la service_role key o si se invoca desde el navegador.
 */
export function createAdminClient() {
  if (typeof window !== "undefined") {
    throw new Error(
      "createAdminClient() se invocó en el navegador. La service_role key omite la RLS y no puede salir del servidor.",
    );
  }
  const env = getPublicEnv();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    throw new Error(
      "Falta SUPABASE_SERVICE_ROLE_KEY. Está en el panel de Supabase → Project Settings → API → service_role.",
    );
  }
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, serviceRoleKey, {
    auth: {
      // Este cliente no representa a un usuario: no debe persistir ni refrescar
      // sesión, o acabaría reutilizando el token de otra petición.
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
