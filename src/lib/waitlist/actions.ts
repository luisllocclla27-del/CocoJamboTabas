"use server";

/**
 * Lista de espera por talla.
 *
 * Es la señal de reposición más valiosa del negocio: dice qué modelo y talla pide
 * la gente con su número de WhatsApp detrás, en vez de adivinar qué comprar. Por
 * eso la talla agotada se muestra en la ficha en lugar de ocultarse.
 *
 * La escritura va con la anon key y depende de la política RLS que permite INSERT
 * público en `waitlist`. No se usa la service_role aquí a propósito: sería
 * conceder permisos totales para una operación que la RLS ya autoriza de forma
 * acotada, y si mañana hay un bug en esta función, el daño posible queda limitado
 * a insertar filas en esa tabla.
 */

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { consumir, identificarPeticion, mensajeLimite } from "@/lib/rate-limit";
import { createServerClient } from "@/lib/supabase/server";

export type ResultadoListaEspera = { ok: true } | { ok: false; error: string };

/**
 * Celular peruano: 9 dígitos empezando en 9.
 *
 * Se normaliza antes de validar porque la gente lo escribe con espacios, guiones
 * o el prefijo +51. Rechazar "999 888 777" por el espacio sería perder el dato
 * por nada.
 */
const telefonoSchema = z
  .string()
  .transform((valor) => valor.replace(/[\s\-()]/g, "").replace(/^(\+?51)/, ""))
  .refine((valor) => /^9\d{8}$/.test(valor), {
    message: "Escribe un celular peruano de 9 dígitos, empezando en 9.",
  });

const entradaSchema = z.object({
  variantId: z.string().uuid("La talla seleccionada no es válida."),
  telefono: telefonoSchema,
});

export async function apuntarEnListaEspera(entrada: {
  variantId: string;
  telefono: string;
}): Promise<ResultadoListaEspera> {
  // El límite va antes de cualquier trabajo: sin él, un bot puede inundar la tabla
  // y dejar la señal de reposición inservible para decidir compras.
  const limite = consumir("listaEspera", identificarPeticion(await headers()));
  if (!limite.permitido) {
    return { ok: false, error: mensajeLimite(limite.esperaSegundos) };
  }

  const parsed = entradaSchema.safeParse(entrada);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Datos inválidos." };
  }

  const supabase = await createServerClient();
  const { error } = await supabase.from("waitlist").insert({
    variant_id: parsed.data.variantId,
    telefono: parsed.data.telefono,
  });

  if (error !== null) {
    // 23505 es la violación del índice único (variant_id, telefono): ya estaba
    // apuntado. Para el cliente eso es un éxito, no un error: pidió aviso y va a
    // recibirlo. Mostrarle un fallo le haría pensar que no quedó registrado.
    if (error.code === "23505") return { ok: true };

    return {
      ok: false,
      error: "No pudimos guardar tu aviso. Escríbenos por WhatsApp y te anotamos.",
    };
  }

  revalidatePath("/producto");
  return { ok: true };
}
