"use server";

/**
 * Gestión de stock desde el panel.
 *
 * Solo se expone lo que el comerciante realmente necesita a diario: ajustar el
 * stock de una talla al recibir mercadería o al detectar un descuadre. El alta de
 * productos nuevos vive en `products.ts`.
 *
 * Cada ajuste queda registrado en `inventory_moves`, y esa escritura ocurre dentro
 * de la función `adjust_stock()` en Postgres, no aquí. El motivo: son dos
 * escrituras (el stock y el movimiento) que tienen que pasar juntas o ninguna. Si
 * se hicieran desde el servidor con dos consultas, un fallo entre ellas dejaría el
 * stock cambiado sin rastro, que es justo el problema que el historial venía a
 * resolver.
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/client";
import { createServerClient, isAdmin } from "@/lib/supabase/server";
import { MAX_STOCK_VARIANTE, MOTIVOS_STOCK, type MotivoStock } from "./inventory-config";

export type ResultadoStock = { ok: true; stock: number } | { ok: false; error: string };

const ajusteSchema = z.object({
  variantId: z.string().uuid(),
  stock: z.number().int().min(0).max(MAX_STOCK_VARIANTE),
  motivo: z.enum(MOTIVOS_STOCK).default("ajuste_manual"),
  nota: z.string().trim().max(200).optional(),
});

/** Identidad del admin, para dejarla en el historial. `null` si no autorizado. */
async function actorAdmin(): Promise<string | null> {
  if (!(await isAdmin())) return null;
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user === null ? "admin:desconocido" : `admin:${user.id}`;
}

export async function ajustarStock(entrada: {
  variantId: string;
  stock: number;
  motivo?: MotivoStock;
  nota?: string;
}): Promise<ResultadoStock> {
  const parsed = ajusteSchema.safeParse(entrada);
  if (!parsed.success) {
    return {
      ok: false,
      error: `El stock debe ser un número entero entre 0 y ${MAX_STOCK_VARIANTE}.`,
    };
  }

  const actor = await actorAdmin();
  if (actor === null) return { ok: false, error: "No tienes permiso para esta acción." };

  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("adjust_stock", {
    p_variant_id: parsed.data.variantId,
    p_stock_nuevo: parsed.data.stock,
    p_motivo: parsed.data.motivo,
    p_nota: parsed.data.nota ?? null,
    p_actor: actor,
  });

  if (error !== null) {
    // PGRST202: la función no existe en el esquema. Es un despliegue con la
    // migración sin aplicar, y decirlo por su nombre ahorra media hora de
    // buscar por qué "no pudimos actualizar el stock".
    if (error.code === "PGRST202") {
      return {
        ok: false,
        error:
          "Falta aplicar supabase/migrations/0007_product_media.sql en Supabase: sin adjust_stock() no se puede registrar el movimiento.",
      };
    }
    return { ok: false, error: "No pudimos actualizar el stock." };
  }

  // El catálogo público está cacheado 60 s; se revalida para que la reposición se
  // vea de inmediato y no dentro de un minuto.
  revalidatePath("/catalogo");
  revalidatePath("/admin/productos");
  revalidatePath("/admin");
  // La función devuelve el stock resultante. Si no llegara un número, se refleja
  // lo pedido: la escritura sí ocurrió.
  return { ok: true, stock: typeof data === "number" ? data : parsed.data.stock };
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
