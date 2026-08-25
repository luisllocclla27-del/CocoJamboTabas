"use server";

/**
 * Acciones sobre los avisos del outbox.
 *
 * El envío lo hace una persona desde el enlace `wa.me`, así que lo único que falta
 * es registrar la decisión: ya lo mandé, esto no se puede mandar, o inténtalo otra
 * vez. Nada de esto redacta ni envía mensajes.
 *
 * El cierre se delega en `release_outbox_event`, la misma función que usa el worker.
 * Duplicar acá el UPDATE llevaría a dos formas distintas de cerrar un evento (una
 * incrementando `intentos`, otra no) y a un historial que no se puede leer.
 *
 * Cada acción revalida la autorización. Una Server Action es un endpoint HTTP: quien
 * conozca su identificador puede invocarla sin pasar por la página.
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/client";
import { isAdmin } from "@/lib/supabase/server";

export type ResultadoAviso = { ok: true } | { ok: false; error: string };

const NO_AUTORIZADO: ResultadoAviso = {
  ok: false,
  error: "No tienes permiso para esta acción.",
};

const avisoSchema = z.object({ id: z.string().uuid() });

/** Rutas que muestran la cola. Se revalidan juntas para no dejar cifras viejas. */
function revalidarAvisos(): void {
  revalidatePath("/admin/avisos");
  revalidatePath("/admin");
}

/**
 * Marca un aviso como ya mandado.
 *
 * Con el notificador de registro, `enviado` significa "el mensaje salió", y acá el
 * que lo afirma es el comerciante después de pulsar el enlace. No se comprueba que
 * el evento siguiera en `pendiente`: si el cron lo cerró en medio, el resultado que
 * el comerciante quería ya se cumplió y avisar de un conflicto solo confundiría.
 */
export async function marcarAvisoEnviado(id: string): Promise<ResultadoAviso> {
  const parsed = avisoSchema.safeParse({ id });
  if (!parsed.success) return { ok: false, error: "Aviso inválido." };
  if (!(await isAdmin())) return NO_AUTORIZADO;

  const supabase = createAdminClient();
  const { error } = await supabase.rpc("release_outbox_event", {
    p_id: parsed.data.id,
    p_ok: true,
    p_error: null,
    p_espera_segundos: null,
  });

  if (error !== null) return { ok: false, error: "No pudimos marcar el aviso como enviado." };

  revalidarAvisos();
  return { ok: true };
}

/**
 * Descarta un aviso que no se va a mandar.
 *
 * El caso típico es un payload al que le falta el teléfono: el mensaje no se puede
 * redactar y reintentarlo daría el mismo resultado siempre. Queda en `fallido` con
 * el motivo, no borrado: el outbox es el rastro de qué se avisó y qué no, y borrar
 * la fila deja el hueco sin explicación.
 */
export async function descartarAviso(id: string): Promise<ResultadoAviso> {
  const parsed = avisoSchema.safeParse({ id });
  if (!parsed.success) return { ok: false, error: "Aviso inválido." };
  if (!(await isAdmin())) return NO_AUTORIZADO;

  const supabase = createAdminClient();
  // `p_espera_segundos` en null es lo que le dice a la función que el fallo no es
  // transitorio, y por tanto que lo deje en 'fallido' en vez de reprogramarlo.
  const { error } = await supabase.rpc("release_outbox_event", {
    p_id: parsed.data.id,
    p_ok: false,
    p_error: "descartado desde el panel: el aviso no se va a mandar",
    p_espera_segundos: null,
  });

  if (error !== null) return { ok: false, error: "No pudimos descartar el aviso." };

  revalidarAvisos();
  return { ok: true };
}

/**
 * Devuelve un aviso fallido a la cola.
 *
 * Va por UPDATE directo y no por `release_outbox_event` porque esa función solo sabe
 * cerrar un evento reclamado: sus tres caminos son enviado, fallido y reintento con
 * espera, y ninguno reabre algo que ya está en `fallido` sin sumar un intento de
 * castigo. Reabrir a mano es lo correcto acá: el intento no lo gastó el worker, lo
 * está decidiendo una persona.
 *
 * `procesar_despues_de` se pone en el momento actual para que el siguiente pase del
 * cron lo tome, en lugar de heredar la espera que traía del último fallo.
 */
export async function reintentarAviso(id: string): Promise<ResultadoAviso> {
  const parsed = avisoSchema.safeParse({ id });
  if (!parsed.success) return { ok: false, error: "Aviso inválido." };
  if (!(await isAdmin())) return NO_AUTORIZADO;

  const supabase = createAdminClient();
  const { error } = await supabase
    .from("outbox")
    .update({
      status: "pendiente",
      ultimo_error: null,
      procesar_despues_de: new Date().toISOString(),
    })
    .eq("id", parsed.data.id)
    // Acotar al estado de origen evita reabrir un evento que el worker acaba de
    // tomar: sin esto, un clic a destiempo lo sacaría de 'procesando' y podría
    // acabar mandado dos veces.
    .eq("status", "fallido");

  if (error !== null) return { ok: false, error: "No pudimos devolver el aviso a la cola." };

  revalidarAvisos();
  return { ok: true };
}
