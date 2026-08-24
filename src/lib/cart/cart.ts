/**
 * Carrito en cookie firmada.
 *
 * POR QUÉ NO EN LA BASE DE DATOS: un carrito de visitante anónimo en una tabla
 * obliga a crear una fila por cada persona que toca un producto y a limpiarlas
 * después. Con este volumen no aporta nada.
 *
 * POR QUÉ FIRMADA Y NO SOLO JSON: el carrito solo guarda `variantId` y
 * `cantidad`, nunca precios. Los precios se leen de la base al mostrar y otra vez
 * al crear el pedido. Aun así, la cookie se firma con HMAC para detectar
 * manipulación: sin firma, alguien podría meter cantidades absurdas o ids
 * inventados y provocar errores raros más adelante. La firma no protege dinero
 * (eso lo hace leer el precio en el servidor), protege la integridad del dato.
 *
 * POR QUÉ `httpOnly`: el carrito no necesita leerse desde JavaScript del cliente,
 * y así una vulnerabilidad de XSS no puede leerlo ni reescribirlo.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const COOKIE_CARRITO = "cj_carrito";

/** 7 días: suficiente para volver a un carrito abandonado, sin ser eterno. */
export const COOKIE_MAX_AGE = 60 * 60 * 24 * 7;

/**
 * Tope por talla. No es una regla de negocio arbitraria: en reventa urbana nadie
 * compra 20 pares del mismo modelo y talla, y un número alto permite a un bot
 * agotar el stock disponible reservándolo sin pagar.
 */
export const MAX_POR_VARIANTE = 5;

/** Tope de líneas distintas, para acotar el tamaño de la cookie. */
export const MAX_LINEAS = 20;

const itemSchema = z.object({
  variantId: z.string().uuid(),
  cantidad: z.number().int().min(1).max(MAX_POR_VARIANTE),
});

const carritoSchema = z.object({
  items: z.array(itemSchema).max(MAX_LINEAS),
});

export type ItemCarrito = z.infer<typeof itemSchema>;
export type Carrito = z.infer<typeof carritoSchema>;

export const CARRITO_VACIO: Carrito = { items: [] };

/**
 * Clave de firma.
 *
 * Reutiliza la `service_role` key como material de clave en vez de exigir otra
 * variable de entorno: ya es un secreto de servidor obligatorio, y así hay una
 * variable menos que configurar mal. Se deriva con HMAC y un contexto fijo para
 * no usar la clave en crudo.
 */
function claveFirma(): string {
  const base = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (base === undefined || base === "") {
    throw new Error(
      "No hay material para firmar la cookie del carrito: falta SUPABASE_SERVICE_ROLE_KEY.",
    );
  }
  return createHmac("sha256", base).update("cookie-carrito-v1").digest("hex");
}

function firmar(payload: string): string {
  return createHmac("sha256", claveFirma()).update(payload).digest("hex");
}

/** Serializa a `base64url.firma`. */
export function serializarCarrito(carrito: Carrito): string {
  const payload = Buffer.from(JSON.stringify(carrito), "utf8").toString("base64url");
  return `${payload}.${firmar(payload)}`;
}

/**
 * Deserializa y verifica.
 *
 * Devuelve el carrito vacío ante cualquier problema en lugar de lanzar: una
 * cookie corrupta o de una versión anterior del formato no debe romper la tienda,
 * solo vaciar el carrito. Lanzar aquí produciría un 500 en la home a cualquiera
 * con una cookie vieja.
 */
export function deserializarCarrito(valor: string | undefined): Carrito {
  if (valor === undefined || valor === "") return CARRITO_VACIO;

  const separador = valor.lastIndexOf(".");
  if (separador === -1) return CARRITO_VACIO;

  const payload = valor.slice(0, separador);
  const firmaRecibida = valor.slice(separador + 1);

  let esperada: string;
  try {
    esperada = firmar(payload);
  } catch {
    return CARRITO_VACIO;
  }

  // Comparación en tiempo constante, comprobando longitudes antes porque
  // `timingSafeEqual` lanza si difieren.
  const a = Buffer.from(esperada, "utf8");
  const b = Buffer.from(firmaRecibida, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return CARRITO_VACIO;

  try {
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    const parsed = carritoSchema.safeParse(json);
    return parsed.success ? parsed.data : CARRITO_VACIO;
  } catch {
    return CARRITO_VACIO;
  }
}

/**
 * Añade o incrementa una línea.
 *
 * Función pura: recibe un carrito y devuelve otro. Así la lógica se testea sin
 * cookies ni base de datos, y las Server Actions solo orquestan.
 */
export function agregarItem(carrito: Carrito, item: ItemCarrito): Carrito {
  const existente = carrito.items.find((i) => i.variantId === item.variantId);

  if (existente === undefined) {
    if (carrito.items.length >= MAX_LINEAS) return carrito;
    return { items: [...carrito.items, item] };
  }

  return {
    items: carrito.items.map((i) =>
      i.variantId === item.variantId
        ? // Se acota al tope en vez de rechazar: sumar 3 a un carrito que ya tiene
          // 4 deja 5, no falla. Rechazar obligaría a explicar un límite que al
          // cliente no le interesa.
          { ...i, cantidad: Math.min(i.cantidad + item.cantidad, MAX_POR_VARIANTE) }
        : i,
    ),
  };
}

export function quitarItem(carrito: Carrito, variantId: string): Carrito {
  return { items: carrito.items.filter((i) => i.variantId !== variantId) };
}

/** Fija la cantidad. Con 0 o menos, elimina la línea. */
export function fijarCantidad(carrito: Carrito, variantId: string, cantidad: number): Carrito {
  if (cantidad <= 0) return quitarItem(carrito, variantId);
  const acotada = Math.min(Math.floor(cantidad), MAX_POR_VARIANTE);
  return {
    items: carrito.items.map((i) => (i.variantId === variantId ? { ...i, cantidad: acotada } : i)),
  };
}

export function totalUnidades(carrito: Carrito): number {
  return carrito.items.reduce((suma, i) => suma + i.cantidad, 0);
}

export function estaVacio(carrito: Carrito): boolean {
  return carrito.items.length === 0;
}
