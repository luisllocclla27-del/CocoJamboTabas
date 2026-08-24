"use server";

/**
 * Server Actions del carrito.
 *
 * Toda mutación del carrito pasa por aquí, en el servidor. Lo importante: estas
 * funciones NUNCA aceptan un precio del cliente. Reciben `variantId` y `cantidad`,
 * y cualquier importe se lee de la base. Es la defensa contra manipular el total
 * desde el navegador.
 *
 * Devuelven un resultado en vez de lanzar porque el llamador es un componente de
 * cliente que tiene que mostrar el error junto al botón, no una pantalla de fallo.
 */

import { cookies, headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { consumir, identificarPeticion, mensajeLimite } from "@/lib/rate-limit";
import {
  agregarItem,
  COOKIE_CARRITO,
  COOKIE_MAX_AGE,
  deserializarCarrito,
  fijarCantidad,
  quitarItem,
  serializarCarrito,
  type Carrito,
} from "./cart";
import { createServerClient } from "@/lib/supabase/server";

export type ResultadoAccion = { ok: true } | { ok: false; error: string };

const entradaSchema = z.object({
  variantId: z.string().uuid("La talla seleccionada no es válida."),
  cantidad: z.number().int().min(1).max(5),
});

/** Lee el carrito de la cookie. */
export async function leerCarrito(): Promise<Carrito> {
  const store = await cookies();
  return deserializarCarrito(store.get(COOKIE_CARRITO)?.value);
}

async function guardarCarrito(carrito: Carrito): Promise<void> {
  const store = await cookies();
  store.set(COOKIE_CARRITO, serializarCarrito(carrito), {
    // No hace falta leerlo desde JavaScript, así que una XSS no puede tocarlo.
    httpOnly: true,
    sameSite: "lax",
    // En desarrollo el sitio es http://localhost, donde una cookie `secure` no se
    // guardaría y el carrito parecería no funcionar.
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  });
}

/**
 * Añade una talla al carrito.
 *
 * Comprueba la disponibilidad ANTES de guardar, para dar un error inmediato y
 * claro. Esa comprobación no es la que garantiza el stock: la definitiva ocurre
 * en `create_order_with_reservations`, con bloqueo `FOR UPDATE` en la base. Entre
 * este momento y el checkout puede pasar cualquier cosa, y por eso la
 * verificación aquí es una cortesía de UX, no una garantía.
 */
export async function agregarAlCarrito(entrada: {
  variantId: string;
  cantidad: number;
}): Promise<ResultadoAccion> {
  const limite = consumir("carrito", identificarPeticion(await headers()));
  if (!limite.permitido) return { ok: false, error: mensajeLimite(limite.esperaSegundos) };

  const parsed = entradaSchema.safeParse(entrada);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Datos inválidos." };
  }

  const disponibilidad = await comprobarDisponibilidad(parsed.data.variantId);
  if (!disponibilidad.existe) {
    return { ok: false, error: "Esa talla ya no está disponible." };
  }

  const carrito = await leerCarrito();
  const yaEnCarrito =
    carrito.items.find((i) => i.variantId === parsed.data.variantId)?.cantidad ?? 0;

  if (disponibilidad.disponible < yaEnCarrito + parsed.data.cantidad) {
    return {
      ok: false,
      error:
        disponibilidad.disponible === 0
          ? "Se acabó el stock de esa talla mientras la mirabas."
          : `Solo quedan ${disponibilidad.disponible} pares en esa talla.`,
    };
  }

  await guardarCarrito(agregarItem(carrito, parsed.data));
  revalidatePath("/carrito");
  return { ok: true };
}

export async function quitarDelCarrito(variantId: string): Promise<ResultadoAccion> {
  if (!z.string().uuid().safeParse(variantId).success) {
    return { ok: false, error: "Producto inválido." };
  }
  await guardarCarrito(quitarItem(await leerCarrito(), variantId));
  revalidatePath("/carrito");
  return { ok: true };
}

export async function cambiarCantidad(
  variantId: string,
  cantidad: number,
): Promise<ResultadoAccion> {
  if (!z.string().uuid().safeParse(variantId).success) {
    return { ok: false, error: "Producto inválido." };
  }
  if (!Number.isFinite(cantidad)) {
    return { ok: false, error: "Cantidad inválida." };
  }

  if (cantidad > 0) {
    const disponibilidad = await comprobarDisponibilidad(variantId);
    if (!disponibilidad.existe) return { ok: false, error: "Esa talla ya no está disponible." };
    if (disponibilidad.disponible < cantidad) {
      return { ok: false, error: `Solo quedan ${disponibilidad.disponible} pares en esa talla.` };
    }
  }

  await guardarCarrito(fijarCantidad(await leerCarrito(), variantId, cantidad));
  revalidatePath("/carrito");
  return { ok: true };
}

export async function vaciarCarrito(): Promise<void> {
  await guardarCarrito({ items: [] });
  revalidatePath("/carrito");
}

/**
 * Disponibilidad de una variante.
 *
 * Usa la función `available_stock()` de la base en lugar de replicar el cálculo
 * aquí: es la misma fuente de verdad que usa el checkout, y duplicar la fórmula
 * llevaría a que la ficha y el pedido discrepasen.
 */
async function comprobarDisponibilidad(
  variantId: string,
): Promise<{ existe: boolean; disponible: number }> {
  const supabase = await createServerClient();

  const { data: variante, error: errorVariante } = await supabase
    .from("variants")
    .select("id, activo")
    .eq("id", variantId)
    .eq("activo", true)
    .maybeSingle();

  if (errorVariante !== null || variante === null) return { existe: false, disponible: 0 };

  const { data, error } = await supabase.rpc("available_stock", { p_variant_id: variantId });
  // Si la RPC falla, se asume 0 en vez de permitir la compra: es mejor perder una
  // venta que vender un par que no existe y tener que devolver el dinero.
  if (error !== null) return { existe: true, disponible: 0 };

  return { existe: true, disponible: typeof data === "number" ? data : 0 };
}
