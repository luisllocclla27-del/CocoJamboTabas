"use server";

/**
 * Gestión de pedidos desde el panel.
 *
 * Las transiciones se delegan a `transition_order_status` en Postgres: es la que
 * conoce la máquina de estados y la que descuenta o libera stock. Duplicar esas
 * reglas aquí llevaría a que la app y la base discreparan, y el estado de un
 * pedido es justo el dato donde eso no puede pasar.
 *
 * Cada acción revalida la autorización. Una Server Action es un endpoint HTTP:
 * quien conozca su identificador puede invocarla sin pasar por la página.
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ORDER_STATUSES, type OrderStatus } from "@/lib/order-status";
import { isValidPickupCode } from "@/lib/shipping/pickup-code";
import { createAdminClient } from "@/lib/supabase/client";
import { createServerClient, isAdmin } from "@/lib/supabase/server";

export type ResultadoPedido = { ok: true } | { ok: false; error: string };

const NO_AUTORIZADO: ResultadoPedido = {
  ok: false,
  error: "No tienes permiso para esta acción.",
};

async function adminActual(): Promise<string | null> {
  if (!(await isAdmin())) return null;
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.id ?? null;
}

const transicionSchema = z.object({
  orderId: z.string().uuid(),
  destino: z.enum(ORDER_STATUSES as unknown as [OrderStatus, ...OrderStatus[]]),
  motivo: z.string().trim().max(300).optional(),
});

/**
 * Cambia el estado de un pedido.
 *
 * Si la transición no es válida, la función SQL lanza y aquí se traduce a un
 * mensaje legible. No se comprueba antes con `canTransition` para evitar tener dos
 * fuentes de verdad: la base decide.
 */
export async function cambiarEstadoPedido(entrada: {
  orderId: string;
  destino: OrderStatus;
  motivo?: string;
}): Promise<ResultadoPedido> {
  const parsed = transicionSchema.safeParse(entrada);
  if (!parsed.success) return { ok: false, error: "Datos inválidos." };

  const adminId = await adminActual();
  if (adminId === null) return NO_AUTORIZADO;

  const supabase = createAdminClient();
  const { error } = await supabase.rpc("transition_order_status", {
    p_order_id: parsed.data.orderId,
    p_to: parsed.data.destino,
    p_actor: `admin:${adminId}`,
    p_motivo: parsed.data.motivo ?? null,
  });

  if (error !== null) {
    // El mensaje de la función SQL nombra los estados implicados, que es
    // exactamente lo que el admin necesita saber.
    return { ok: false, error: `No se pudo cambiar el estado: ${error.message}` };
  }

  revalidatePath("/admin/pedidos");
  revalidatePath("/admin");
  return { ok: true };
}

const envioSchema = z.object({
  orderId: z.string().uuid(),
  guia: z.string().trim().min(3, "El número de guía es demasiado corto."),
  codigo: z.string().trim().min(3, "El código de rastreo es demasiado corto."),
  claveRetiro: z.string().trim(),
  agencia: z.string().trim().min(2, "Indica la agencia de destino."),
});

/**
 * Registra la guía emitida en el mostrador y marca el pedido como enviado.
 *
 * Este es el camino manual, que es el proveedor por defecto: el admin emite la
 * guía en la agencia y transcribe los datos. No depende del wrapper no oficial de
 * Shalom, así que funciona siempre.
 *
 * La clave de retiro se valida con las mismas reglas que exige Shalom (ni
 * repetida ni consecutiva) aunque aquí solo se transcriba: si el admin la teclea
 * mal, el cliente no puede recoger el paquete.
 */
export async function registrarEnvio(entrada: {
  orderId: string;
  guia: string;
  codigo: string;
  claveRetiro: string;
  agencia: string;
}): Promise<ResultadoPedido> {
  const parsed = envioSchema.safeParse(entrada);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Datos inválidos." };
  }

  const validacion = isValidPickupCode(parsed.data.claveRetiro);
  if (!validacion.valido) {
    return { ok: false, error: validacion.motivo ?? "Clave de retiro inválida." };
  }

  const adminId = await adminActual();
  if (adminId === null) return NO_AUTORIZADO;

  const supabase = createAdminClient();

  const { data: pedido, error: errorLectura } = await supabase
    .from("orders")
    .select("id, reference, status, customers!inner(telefono)")
    .eq("id", parsed.data.orderId)
    .maybeSingle();

  if (errorLectura !== null || pedido === null) {
    return { ok: false, error: "No encontramos ese pedido." };
  }

  const fila = pedido as unknown as {
    id: string;
    reference: string;
    status: OrderStatus;
    customers: { telefono: string };
  };

  // Un envío solo tiene sentido con el pago ya resuelto: registrar la guía de un
  // pedido sin pagar significaría que la mercadería salió sin cobrar.
  if (fila.status !== "preparando" && fila.status !== "verificado") {
    return {
      ok: false,
      error: `El pedido está en "${fila.status}". Solo se puede registrar el envío de un pedido en preparación.`,
    };
  }

  // `upsert` sobre order_id: si el admin corrige un dato mal tecleado, se
  // actualiza la fila en vez de crear un segundo envío para el mismo pedido.
  //
  // Requiere la restricción única `ux_shipments_order_id` de
  // 0006_shipments_unique.sql: sin ella Postgres responde 42P10 porque el
  // `on conflict` no encuentra ningún índice único que corresponda.
  const { error: errorEnvio } = await supabase.from("shipments").upsert(
    {
      order_id: parsed.data.orderId,
      provider: "manual",
      guia: parsed.data.guia,
      codigo: parsed.data.codigo,
      pickup_code: parsed.data.claveRetiro,
      tracking_url: "https://shalom.com.pe/rastrea-tu-envio",
    },
    { onConflict: "order_id" },
  );

  if (errorEnvio !== null) {
    // El código de Postgres se incluye en el mensaje técnico porque distingue una
    // migración sin aplicar de un problema de datos, y sin él el admin solo ve
    // "no pudimos guardar" sin ninguna pista de qué hacer.
    const falta42P10 = errorEnvio.code === "42P10";
    return {
      ok: false,
      error: falta42P10
        ? "Falta aplicar la migración 0006_shipments_unique.sql en Supabase: sin la restricción única no se puede guardar el envío."
        : `No pudimos guardar los datos del envío (${errorEnvio.code ?? "sin código"}).`,
    };
  }

  await supabase
    .from("orders")
    .update({ agencia_destino: parsed.data.agencia })
    .eq("id", parsed.data.orderId);

  // Si venía de `verificado`, hay que pasar por `preparando` primero: la máquina
  // de estados no permite el salto.
  const camino: OrderStatus[] =
    fila.status === "verificado" ? ["preparando", "enviado"] : ["enviado"];

  for (const destino of camino) {
    const { error } = await supabase.rpc("transition_order_status", {
      p_order_id: parsed.data.orderId,
      p_to: destino,
      p_actor: `admin:${adminId}`,
      p_motivo: null,
    });
    if (error !== null) {
      return {
        ok: false,
        error: `Envío guardado, pero el pedido no cambió de estado: ${error.message}`,
      };
    }
  }

  await supabase.from("outbox").insert({
    tipo: "whatsapp_pedido_enviado",
    payload: {
      reference: fila.reference,
      telefono: fila.customers.telefono,
      guia: parsed.data.guia,
      clave_retiro: parsed.data.claveRetiro,
      agencia: parsed.data.agencia,
    },
  });

  revalidatePath("/admin/pedidos");
  revalidatePath("/admin/avisos");
  revalidatePath(`/seguimiento/${fila.reference}`);
  return { ok: true };
}
