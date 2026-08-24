"use server";

/**
 * Gestión de stock desde el panel.
 *
 * Solo se expone lo que el comerciante realmente necesita a diario: ajustar el
 * stock de una talla al recibir mercadería o al detectar un descuadre. El alta
 * completa de productos vive en el SQL Editor de Supabase por ahora; construir un
 * formulario de alta con subida de fotos antes de que la tienda venda su primer par
 * sería resolver un problema que aún no existe.
 *
 * Los ajustes se registran en `order_events`... no: esa tabla es de pedidos. Un
 * historial de movimientos de inventario sería lo correcto y NO existe todavía;
 * queda anotado como deuda consciente, porque sin él un descuadre de stock no se
 * puede reconstruir.
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/client";
import { isAdmin } from "@/lib/supabase/server";

export type ResultadoStock = { ok: true; stock: number } | { ok: false; error: string };

const ajusteSchema = z.object({
  variantId: z.string().uuid(),
  // Tope alto pero finito: un dedo pegado al teclado no debe dejar 99999 pares en
  // el catálogo.
  stock: z.number().int().min(0).max(999),
});

export async function ajustarStock(entrada: {
  variantId: string;
  stock: number;
}): Promise<ResultadoStock> {
  const parsed = ajusteSchema.safeParse(entrada);
  if (!parsed.success) {
    return { ok: false, error: "El stock debe ser un número entero entre 0 y 999." };
  }
  if (!(await isAdmin())) return { ok: false, error: "No tienes permiso para esta acción." };

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("variants")
    .update({ stock: parsed.data.stock })
    .eq("id", parsed.data.variantId)
    .select("stock")
    .maybeSingle();

  if (error !== null || data === null) {
    return { ok: false, error: "No pudimos actualizar el stock." };
  }

  // El catálogo público está cacheado 60 s; se revalida para que la reposición se
  // vea de inmediato y no dentro de un minuto.
  revalidatePath("/catalogo");
  revalidatePath("/admin/productos");
  revalidatePath("/admin");
  return { ok: true, stock: data.stock };
}

const visibilidadSchema = z.object({
  productId: z.string().uuid(),
  activo: z.boolean(),
});

/**
 * Muestra u oculta un producto del catálogo.
 *
 * Se desactiva en lugar de borrar: un producto borrado se llevaría por delante el
 * historial de pedidos que lo referencian. Los `order_items` guardan un snapshot
 * del nombre justamente para sobrevivir a esto, pero desactivar es reversible y
 * borrar no.
 */
export async function cambiarVisibilidad(entrada: {
  productId: string;
  activo: boolean;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = visibilidadSchema.safeParse(entrada);
  if (!parsed.success) return { ok: false, error: "Datos inválidos." };
  if (!(await isAdmin())) return { ok: false, error: "No tienes permiso para esta acción." };

  const supabase = createAdminClient();
  const { error } = await supabase
    .from("products")
    .update({ activo: parsed.data.activo })
    .eq("id", parsed.data.productId);

  if (error !== null) return { ok: false, error: "No pudimos cambiar la visibilidad." };

  revalidatePath("/catalogo");
  revalidatePath("/admin/productos");
  return { ok: true };
}

const avisoSchema = z.object({ esperaId: z.string().uuid() });

/**
 * Marca un aviso de lista de espera como ya notificado.
 *
 * El WhatsApp lo manda el comerciante a mano (el enlace `wa.me` va prellenado en la
 * pantalla); esto solo registra que ya se hizo, para que el mismo cliente no reciba
 * tres avisos del mismo par.
 */
export async function marcarAvisado(entrada: {
  esperaId: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = avisoSchema.safeParse(entrada);
  if (!parsed.success) return { ok: false, error: "Datos inválidos." };
  if (!(await isAdmin())) return { ok: false, error: "No tienes permiso para esta acción." };

  const supabase = createAdminClient();
  const { error } = await supabase
    .from("waitlist")
    .update({ notificado: true })
    .eq("id", parsed.data.esperaId);

  if (error !== null) return { ok: false, error: "No pudimos marcar el aviso." };

  revalidatePath("/admin/espera");
  revalidatePath("/admin");
  return { ok: true };
}
