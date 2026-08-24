"use server";

/**
 * Creación de pedidos.
 *
 * Es el punto más delicado del sistema. Cuatro reglas que gobiernan este archivo:
 *
 * 1. NINGÚN IMPORTE VIENE DEL CLIENTE. El navegador manda `variantId` y
 *    `cantidad`; los precios los lee `create_order_with_reservations` de la base.
 *    Aquí se calculan totales solo para MOSTRARLOS, y si difirieran de los que
 *    calcula la función SQL, manda la base.
 *
 * 2. LA ATOMICIDAD LA DA POSTGRES. La función SQL bloquea cada variante con
 *    `FOR UPDATE` en orden ascendente de id antes de comprobar disponibilidad. Sin
 *    eso, dos compras simultáneas del último par verían ambas stock disponible.
 *    No se replica esa lógica en TypeScript: se delega.
 *
 * 3. LOS CÉNTIMOS ÚNICOS PUEDEN COLISIONAR. El índice parcial de la base garantiza
 *    la unicidad, así que un choque llega como error 23505. Es un resultado
 *    esperado, no un bug: se reintenta con otros céntimos.
 *
 * 4. SE USA LA SERVICE ROLE. Un comprador es anónimo y la RLS no le permite
 *    escribir en `orders`. La alternativa (abrir INSERT público) permitiría a
 *    cualquiera crear pedidos falsos y agotar el stock con reservas. Cada uso de
 *    este cliente está justificado y acotado a esta operación.
 *
 * Las constantes y esquemas viven en `config.ts`: un módulo con `"use server"` solo
 * puede exportar funciones asíncronas.
 */

import { headers } from "next/headers";
import { generateReference } from "@/lib/reference";
import {
  applyPaymentCents,
  NoPaymentCentsAvailableError,
  pickPaymentCents,
} from "@/lib/payment-cents";
import { percentOf, type Cents } from "@/lib/money";
import { calcularCotizacion } from "@/lib/shipping/quote";
import type { ShippingDestination } from "@/lib/shipping/types";
import { createAdminClient } from "@/lib/supabase/client";
import { leerCarrito, vaciarCarrito } from "@/lib/cart/actions";
import { resolverCarrito } from "@/lib/cart/resolve";
import { consumir, identificarPeticion, mensajeLimite } from "@/lib/rate-limit";
import {
  crearPedidoSchema,
  DESCUENTO_YAPE_PCT,
  MAX_INTENTOS_CENTIMOS,
  RESERVA_MINUTOS,
  type DatosEntrega,
  type EntradaCrearPedido,
  type ResultadoCrearPedido,
} from "./config";

export async function crearPedido(entrada: EntradaCrearPedido): Promise<ResultadoCrearPedido> {
  /**
   * El límite va primero, y aquí importa más que en ningún otro sitio: solo
   * existen 99 céntimos identificadores. Un bot creando pedidos en bucle los ocupa
   * todos y deja el checkout inservible para clientes reales, sin necesidad de
   * tumbar nada. Es la denegación de servicio más barata contra este diseño.
   */
  const limite = consumir("crearPedido", identificarPeticion(await headers()));
  if (!limite.permitido) {
    return { ok: false, error: mensajeLimite(limite.esperaSegundos) };
  }

  const parsed = crearPedidoSchema.safeParse(entrada);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      error: issue?.message ?? "Revisa los datos del formulario.",
      ...(issue !== undefined ? { campo: issue.path.join(".") } : {}),
    };
  }
  const datos = parsed.data;

  // El carrito se relee del servidor: lo que el navegador crea que tiene es
  // irrelevante.
  const carrito = await resolverCarrito(await leerCarrito());
  if (carrito.lineas.length === 0) {
    return { ok: false, error: "Tu carrito está vacío." };
  }
  if (carrito.hayProblemas) {
    return {
      ok: false,
      error: "Alguna talla se quedó sin stock. Vuelve al carrito para ajustarlo.",
    };
  }

  const envio = calcularCotizacion({
    destino: aDestino(datos.entrega),
    subtotalCents: carrito.subtotalCents,
  });

  const descuentoCents = percentOf(carrito.subtotalCents, DESCUENTO_YAPE_PCT);
  const baseCents = carrito.subtotalCents - descuentoCents + envio.costoCents;

  const supabase = createAdminClient();

  // Reintenta ante colisión de céntimos o de referencia. Ambas son colisiones de
  // índice único, es decir resultados esperados con probabilidad baja, no fallos.
  let ultimoError = "No pudimos crear tu pedido. Intenta de nuevo.";
  for (let intento = 0; intento < MAX_INTENTOS_CENTIMOS; intento++) {
    let paymentCents: number;
    try {
      paymentCents = pickPaymentCents(await centimosOcupados(supabase));
    } catch (error) {
      if (error instanceof NoPaymentCentsAvailableError) {
        // Se agotó el espacio de 99 identificadores: hay demasiados pedidos
        // esperando pago a la vez. No es un error del cliente.
        return {
          ok: false,
          error:
            "Estamos con muchos pedidos en curso. Espera unos minutos y vuelve a intentarlo, o escríbenos por WhatsApp.",
        };
      }
      throw error;
    }

    const { totalCents } = applyPaymentCents(baseCents, paymentCents);
    const reference = generateReference();

    const { data, error } = await supabase.rpc("create_order_with_reservations", {
      p_reference: reference,
      p_customer: {
        nombre: datos.cliente.nombre,
        apellidos: datos.cliente.apellidos,
        telefono: datos.cliente.telefono,
        email: datos.cliente.email === "" ? null : (datos.cliente.email ?? null),
        dni: datos.cliente.dni === "" ? null : (datos.cliente.dni ?? null),
      },
      p_items: carrito.lineas.map((l) => ({ variant_id: l.variantId, cantidad: l.cantidad })),
      p_payment_method: datos.metodoPago,
      p_shipping_mode: datos.entrega.modo,
      p_shipping_cents: envio.costoCents,
      p_discount_cents: descuentoCents,
      p_payment_cents: paymentCents,
      p_reserva_minutos: RESERVA_MINUTOS,
      p_direccion: datosDireccion(datos.entrega, datos.notas),
    });

    if (error === null) {
      // El pedido existe y el stock está reservado. Vaciar el carrito ahora evita
      // que al volver atrás se cree un segundo pedido con lo mismo.
      await vaciarCarrito();
      await registrarTotalEsperado(supabase, String(data), totalCents);
      return { ok: true, reference };
    }

    // 23505: violación de índice único. Puede ser los céntimos o la referencia;
    // en ambos casos se reintenta con valores nuevos.
    if (error.code === "23505") continue;

    // P0001 es el `raise exception` de la función: stock insuficiente. Reintentar
    // no ayuda, porque el par no existe.
    if (error.code === "P0001") {
      return {
        ok: false,
        error: "Una de tus tallas se acabó justo ahora. Vuelve al carrito para ajustarlo.",
      };
    }

    ultimoError = "No pudimos crear tu pedido. Intenta de nuevo en un momento.";
    break;
  }

  return { ok: false, error: ultimoError };
}

/**
 * Céntimos ya tomados por pedidos que esperan pago.
 *
 * Es una lectura orientativa: entre esta consulta y el INSERT puede entrar otro
 * pedido. La unicidad real la impone el índice parcial de la base, y de ahí que
 * el bucle de arriba reintente ante 23505.
 */
async function centimosOcupados(
  supabase: ReturnType<typeof createAdminClient>,
): Promise<number[]> {
  const { data, error } = await supabase
    .from("orders")
    .select("payment_cents")
    .eq("payment_method", "yape_manual")
    .in("status", ["pendiente_pago", "comprobante_enviado"]);

  if (error !== null) return [];
  return (data ?? [])
    .map((f) => f.payment_cents)
    .filter((c): c is number => typeof c === "number");
}

/**
 * Crea la fila de `payments` con el monto exacto que se espera recibir.
 *
 * Se guarda al crear el pedido y no al subir el comprobante porque es la
 * referencia contra la que se compara el voucher. Si se calculara en el momento
 * de la verificación, un cambio de precio del producto alteraría el monto
 * esperado de un pedido ya emitido.
 */
async function registrarTotalEsperado(
  supabase: ReturnType<typeof createAdminClient>,
  orderId: string,
  totalCents: Cents,
): Promise<void> {
  await supabase.from("payments").insert({
    order_id: orderId,
    method: "yape_manual",
    status: "pendiente",
    amount_cents: totalCents,
  });
}

function aDestino(entrega: DatosEntrega): ShippingDestination {
  switch (entrega.modo) {
    case "lima_domicilio":
      return { modo: "lima_domicilio", distrito: entrega.distrito };
    case "provincia_agencia":
      return {
        modo: "provincia_agencia",
        departamento: entrega.departamento,
        provincia: entrega.provincia,
        agenciaId: entrega.agencia,
      };
    case "recojo_tienda":
      return { modo: "recojo_tienda" };
  }
}

function datosDireccion(
  entrega: DatosEntrega,
  notas: string | undefined,
): Record<string, string | null> {
  const base = { notas: notas ?? null };
  switch (entrega.modo) {
    case "lima_domicilio":
      return { ...base, direccion: entrega.direccion, distrito: entrega.distrito };
    case "provincia_agencia":
      return {
        ...base,
        departamento: entrega.departamento,
        provincia: entrega.provincia,
        agencia_destino: entrega.agencia,
      };
    case "recojo_tienda":
      return base;
  }
}
