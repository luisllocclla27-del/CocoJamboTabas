"use server";

/**
 * Verificación de pagos.
 *
 * LA DECISIÓN LA TOMA UN HUMANO. Este módulo ejecuta lo que el admin decidió; no
 * aprueba nada por su cuenta. El score de riesgo ordena la cola y marca lo dudoso,
 * pero aprobar un pago mueve dinero y rechazarlo deja a un cliente legítimo sin su
 * compra: ninguna de las dos cosas se automatiza.
 *
 * Cada acción exige revalidar la autorización, aunque el layout del panel ya la
 * comprobó. Una Server Action es un endpoint HTTP: quien conozca su identificador
 * puede invocarla directamente, sin pasar por la página. Confiar en que "solo se
 * llama desde el panel" es el error que convierte un panel protegido en una API
 * abierta.
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/client";
import { createServerClient, isAdmin } from "@/lib/supabase/server";

export type ResultadoVerificacion = { ok: true } | { ok: false; error: string };

const NO_AUTORIZADO: ResultadoVerificacion = {
  ok: false,
  error: "No tienes permiso para esta acción.",
};

const aprobarSchema = z.object({ paymentId: z.string().uuid() });

const rechazarSchema = z.object({
  paymentId: z.string().uuid(),
  motivo: z
    .string()
    .trim()
    .min(10, "Escribe un motivo de al menos 10 caracteres: el cliente lo va a leer.")
    .max(300),
});

/** Identidad del admin, para la auditoría. `null` si no está autorizado. */
async function adminActual(): Promise<string | null> {
  if (!(await isAdmin())) return null;
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.id ?? null;
}

/**
 * Aprueba un pago y pasa el pedido a preparación.
 *
 * El paso a `preparando` es el que descuenta el stock físico y confirma las
 * reservas, dentro de `transition_order_status`. Por eso se hace en la base y no
 * aquí: si se descontara desde el servidor con dos consultas, un fallo entre ellas
 * dejaría el pago aprobado y el stock sin descontar.
 */
export async function aprobarPago(entrada: { paymentId: string }): Promise<ResultadoVerificacion> {
  const parsed = aprobarSchema.safeParse(entrada);
  if (!parsed.success) return { ok: false, error: "Pago inválido." };

  const adminId = await adminActual();
  if (adminId === null) return NO_AUTORIZADO;

  const supabase = createAdminClient();

  // Se relee el estado en vez de confiar en lo que la pantalla mostraba: entre que
  // el admin cargó la cola y pulsó el botón, otro admin puede haber resuelto el
  // mismo pago.
  const { data, error } = await supabase
    .from("payments")
    .select("id, order_id, status, orders!inner(reference, status, customers!inner(telefono))")
    .eq("id", parsed.data.paymentId)
    .maybeSingle();

  if (error !== null || data === null) return { ok: false, error: "No encontramos ese pago." };

  const fila = data as unknown as {
    id: string;
    order_id: string;
    status: string;
    orders: { reference: string; status: string; customers: { telefono: string } };
  };

  if (fila.status !== "en_revision") {
    return { ok: false, error: "Ese pago ya fue resuelto por alguien más." };
  }

  const { error: errorPago } = await supabase
    .from("payments")
    .update({
      status: "aprobado",
      reviewed_by: adminId,
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", fila.id)
    // Condición de carrera: si otro admin lo aprobó en este instante, el `eq`
    // sobre el estado anterior hace que este update no afecte a ninguna fila.
    .eq("status", "en_revision");

  if (errorPago !== null) return { ok: false, error: "No pudimos aprobar el pago." };

  // `verificado` y luego `preparando`: la máquina de estados de la base exige el
  // paso intermedio, y es el segundo el que descuenta stock.
  for (const destino of ["verificado", "preparando"] as const) {
    const { error: errorEstado } = await supabase.rpc("transition_order_status", {
      p_order_id: fila.order_id,
      p_to: destino,
      p_actor: `admin:${adminId}`,
      p_motivo: null,
    });
    if (errorEstado !== null) {
      return {
        ok: false,
        error: `Pago aprobado, pero el pedido quedó en un estado inconsistente (${errorEstado.message}). Revísalo.`,
      };
    }
  }

  // El teléfono va en el payload, no solo la referencia: `construirMensaje`
  // descarta el evento sin un celular normalizable, y sin él el aviso más
  // importante de la tienda (te confirmamos el pago) no se llegaba a redactar.
  await supabase.from("outbox").insert({
    tipo: "whatsapp_pago_aprobado",
    payload: {
      reference: fila.orders.reference,
      telefono: fila.orders.customers.telefono,
    },
  });

  revalidatePath("/admin/pagos");
  revalidatePath("/admin/avisos");
  revalidatePath("/admin");
  revalidatePath(`/seguimiento/${fila.orders.reference}`);
  return { ok: true };
}

/**
 * Rechaza un pago con motivo obligatorio.
 *
 * El motivo se guarda y se le muestra al cliente: un rechazo sin explicación
 * genera un reclamo por WhatsApp que consume más tiempo que escribirlo. El pedido
 * vuelve a `rechazado`, desde donde el cliente puede enviar otro comprobante.
 *
 * Ojo con las reservas: al pasar a `rechazado` la base las libera, así que si el
 * cliente reintenta hay que revalidar disponibilidad. Está documentado en el SQL.
 */
export async function rechazarPago(entrada: {
  paymentId: string;
  motivo: string;
}): Promise<ResultadoVerificacion> {
  const parsed = rechazarSchema.safeParse(entrada);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Datos inválidos." };
  }

  const adminId = await adminActual();
  if (adminId === null) return NO_AUTORIZADO;

  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("payments")
    .select("id, order_id, status, orders!inner(reference, customers!inner(telefono))")
    .eq("id", parsed.data.paymentId)
    .maybeSingle();

  if (error !== null || data === null) return { ok: false, error: "No encontramos ese pago." };

  const fila = data as unknown as {
    id: string;
    order_id: string;
    status: string;
    orders: { reference: string; customers: { telefono: string } };
  };

  if (fila.status !== "en_revision") {
    return { ok: false, error: "Ese pago ya fue resuelto por alguien más." };
  }

  const { error: errorPago } = await supabase
    .from("payments")
    .update({
      status: "rechazado",
      rejection_reason: parsed.data.motivo,
      reviewed_by: adminId,
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", fila.id)
    .eq("status", "en_revision");

  if (errorPago !== null) return { ok: false, error: "No pudimos rechazar el pago." };

  const { error: errorEstado } = await supabase.rpc("transition_order_status", {
    p_order_id: fila.order_id,
    p_to: "rechazado",
    p_actor: `admin:${adminId}`,
    p_motivo: parsed.data.motivo,
  });

  if (errorEstado !== null) {
    return { ok: false, error: "Pago rechazado, pero el pedido no cambió de estado. Revísalo." };
  }

  await supabase.from("outbox").insert({
    tipo: "whatsapp_pago_rechazado",
    payload: {
      reference: fila.orders.reference,
      telefono: fila.orders.customers.telefono,
      motivo: parsed.data.motivo,
    },
  });

  revalidatePath("/admin/pagos");
  revalidatePath("/admin/avisos");
  revalidatePath("/admin");
  revalidatePath(`/seguimiento/${fila.orders.reference}`);
  return { ok: true };
}

/**
 * Devuelve una URL firmada del voucher.
 *
 * Se expone como acción y no como dato de la página para que la URL se genere solo
 * cuando el admin decide mirar el comprobante. Precargar 30 URLs firmadas al abrir
 * la cola dejaría 30 accesos abiertos a documentos con datos personales, la
 * mayoría sin usarse.
 */
export async function verVoucher(ruta: string): Promise<{ url: string } | { error: string }> {
  if (!(await isAdmin())) return { error: "No autorizado." };
  // La ruta se acota al bucket esperado: sin esto, un parámetro manipulado podría
  // pedir la firma de cualquier objeto del proyecto.
  if (ruta.includes("..") || ruta.startsWith("/")) return { error: "Ruta inválida." };

  const supabase = createAdminClient();
  const { data, error } = await supabase.storage.from("vouchers").createSignedUrl(ruta, 300);
  if (error !== null || data === null) return { error: "No pudimos abrir el comprobante." };
  return { url: data.signedUrl };
}
