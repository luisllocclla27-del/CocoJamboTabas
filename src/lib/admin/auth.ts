"use server";

/**
 * Autenticación del panel.
 *
 * `iniciarSesion` deliberadamente NO distingue entre "email no existe" y
 * "contraseña incorrecta": responder distinto permitiría enumerar qué correos
 * tienen cuenta de administrador. Un único mensaje para ambos casos.
 *
 * Tampoco se comprueba aquí si el usuario está en `admin_users`. Iniciar sesión y
 * tener permisos son cosas distintas: la sesión se crea, y el layout del panel es
 * el que decide si esa sesión puede ver algo. Así un usuario sin permisos recibe
 * un "no tienes acceso" claro en vez de un error de credenciales confuso.
 */

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { consumir, identificarPeticion, mensajeLimite } from "@/lib/rate-limit";
import { createServerClient } from "@/lib/supabase/server";

export type ResultadoLogin = { ok: false; error: string };

const schema = z.object({
  email: z.string().trim().email("Escribe un correo válido."),
  password: z.string().min(1, "Escribe tu contraseña."),
});

export async function iniciarSesion(datos: FormData): Promise<ResultadoLogin | undefined> {
  // Frena la fuerza bruta contra la contraseña del panel. Supabase tiene sus
  // propios límites, pero son generosos y no conocen nuestro contexto: aquí 8
  // intentos cada 10 minutos son de sobra para una persona que se equivoca.
  const limite = consumir("login", identificarPeticion(await headers()));
  if (!limite.permitido) {
    return { ok: false, error: mensajeLimite(limite.esperaSegundos) };
  }

  const parsed = schema.safeParse({
    email: String(datos.get("email") ?? ""),
    password: String(datos.get("password") ?? ""),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Datos inválidos." };
  }

  const supabase = await createServerClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });

  if (error !== null) {
    // Mensaje único a propósito: ver la nota de arriba sobre enumeración.
    return { ok: false, error: "Correo o contraseña incorrectos." };
  }

  const destinoCrudo = String(datos.get("volver") ?? "/admin");
  // Solo se acepta una ruta interna del panel. Sin esta comprobación, un enlace
  // con `?volver=https://sitio-falso.com` convertiría el login en un redirector
  // abierto, útil para phishing con nuestro dominio como carnada.
  const destino = destinoCrudo.startsWith("/admin") ? destinoCrudo : "/admin";

  revalidatePath("/admin", "layout");
  redirect(destino);
}

export async function cerrarSesion(): Promise<void> {
  const supabase = await createServerClient();
  await supabase.auth.signOut();
  revalidatePath("/admin", "layout");
  redirect("/admin/login");
}
