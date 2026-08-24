/**
 * Validación de variables de entorno en el arranque.
 *
 * La regla que gobierna este archivo: **una variable mal puesta debe romper el
 * build, no la venta**. Un `process.env.X!` disperso por el código falla en
 * producción, de noche, cuando un cliente está pagando. Aquí se valida todo de
 * una vez y con mensajes que dicen exactamente qué falta.
 *
 * Separación crítica entre los dos grupos:
 *
 * - `NEXT_PUBLIC_*` viaja al navegador. La `anon key` de Supabase va aquí, y es
 *   correcto: no otorga permisos por sí misma, las políticas RLS deciden qué
 *   puede leer. Es la RLS la que protege los datos, no el secreto de la clave.
 * - Todo lo demás es solo servidor. La `service_role key` **omite la RLS por
 *   completo**: si se filtrara al cliente, cualquiera podría leer los vouchers,
 *   los teléfonos y los DNI de todos los clientes. Por eso este módulo lanza si
 *   alguien intenta leerla desde el navegador.
 */

import { z } from "zod";

const publicSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z
    .string()
    .url("NEXT_PUBLIC_SUPABASE_URL debe ser una URL completa, ej. https://xxxx.supabase.co")
    /**
     * Normaliza la URL a su origen.
     *
     * El panel de Supabase muestra en varios sitios el endpoint completo
     * (`https://xxxx.supabase.co/rest/v1/`), y es natural copiar ese. Pero el
     * cliente añade su propia ruta encima, así que quedaría pidiendo
     * `/rest/v1//rest/v1/products` y devolviendo 404 con un mensaje que no apunta
     * a la causa. Recortar al origen convierte un fallo desconcertante en un caso
     * que simplemente funciona.
     */
    .transform((valor) => {
      try {
        return new URL(valor).origin;
      } catch {
        return valor.replace(/\/+$/, "");
      }
    }),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z
    .string()
    .min(20, "NEXT_PUBLIC_SUPABASE_ANON_KEY parece truncada"),
  NEXT_PUBLIC_SITE_URL: z.string().url().default("http://localhost:3000"),
});

const serverSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z
    .string()
    .min(20, "SUPABASE_SERVICE_ROLE_KEY parece truncada")
    .optional(),
  YAPE_NUMERO: z
    .string()
    .regex(/^9\d{8}$/, "YAPE_NUMERO debe ser un celular peruano de 9 dígitos que empiece en 9")
    .optional(),
  YAPE_TITULAR: z.string().min(3).optional(),
});

export type PublicEnv = z.infer<typeof publicSchema>;
export type ServerEnv = z.infer<typeof serverSchema>;

function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `  · ${i.path.join(".")}: ${i.message}`).join("\n");
}

let cachedPublic: PublicEnv | null = null;

/**
 * Entorno público. Se puede llamar desde componentes de cliente.
 *
 * En Next.js las `NEXT_PUBLIC_*` se reemplazan en tiempo de compilación, así que
 * hay que referenciarlas literalmente; un `process.env[nombre]` dinámico
 * devolvería `undefined` en el navegador.
 */
export function getPublicEnv(): PublicEnv {
  if (cachedPublic) return cachedPublic;
  const parsed = publicSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
  });
  if (!parsed.success) {
    throw new Error(
      `Faltan variables de entorno públicas. Copiá .env.example a .env.local y completá:\n${formatIssues(parsed.error)}`,
    );
  }
  cachedPublic = parsed.data;
  return cachedPublic;
}

let cachedServer: ServerEnv | null = null;

/** Entorno de servidor. Lanza si se invoca desde el navegador. */
export function getServerEnv(): ServerEnv {
  if (typeof window !== "undefined") {
    throw new Error(
      "getServerEnv() se llamó desde el navegador. Contiene la service_role key, que omite la RLS.",
    );
  }
  if (cachedServer) return cachedServer;
  const parsed = serverSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Variables de entorno de servidor inválidas:\n${formatIssues(parsed.error)}`);
  }
  cachedServer = parsed.data;
  return cachedServer;
}

/**
 * ¿Está Supabase configurado?
 *
 * El proyecto arranca y el catálogo se ve sin base de datos, con los datos de
 * demostración. Esto existe para que `npm run dev` recién clonado no explote:
 * un README que exige diez variables antes de ver algo es un README que nadie
 * sigue hasta el final.
 */
export function isSupabaseConfigured(): boolean {
  return (
    !!process.env.NEXT_PUBLIC_SUPABASE_URL && !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
}

/** ¿Hay service_role key? Sin ella el panel de admin no puede escribir. */
export function hasServiceRole(): boolean {
  return typeof window === "undefined" && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
}
