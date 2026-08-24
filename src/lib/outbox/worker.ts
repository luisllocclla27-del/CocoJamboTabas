/**
 * Worker del outbox.
 *
 * QUÉ RESUELVE: los avisos de WhatsApp se encolan en la misma transacción que el
 * cambio de estado del pedido. Si la transacción falla no se manda nada; si el
 * envío falla, el evento sigue en la cola y se reintenta. Sin este patrón, mandar
 * el mensaje en línea ataría la confirmación del cliente a que un servicio de
 * terceros responda, y un fallo de red dejaría el pedido creado pero al cliente sin
 * aviso.
 *
 * ESTADO DEL ENVÍO REAL, dicho sin rodeos: **no hay proveedor de WhatsApp
 * conectado**. La API de WhatsApp Business exige verificación del negocio y
 * plantillas aprobadas, algo que no se puede hacer desde el código. Por eso el
 * worker usa un `Notificador` inyectable, y la implementación por defecto es
 * `notificadorRegistro`, que deja el mensaje y su enlace `wa.me` en la tabla para
 * que el comerciante lo abra con un clic desde el panel.
 *
 * Eso NO es un adorno: hoy el flujo real de la tienda es que el comerciante escriba
 * por WhatsApp, y un enlace prellenado le ahorra redactar. Cuando haya proveedor, se
 * implementa la interfaz y el worker no cambia.
 */

import {
  construirMensaje,
  debeAbandonar,
  esperaReintentoMs,
  type MensajeListo,
} from "./messages";
import { createAdminClient } from "@/lib/supabase/client";

export type ResultadoEnvio =
  | { ok: true }
  /** `transitorio: true` reintenta; `false` marca el evento como fallido. */
  | { ok: false; motivo: string; transitorio: boolean };

export interface Notificador {
  readonly nombre: string;
  enviar(mensaje: MensajeListo): Promise<ResultadoEnvio>;
}

/**
 * Notificador por defecto: registra y da por bueno el evento.
 *
 * No finge haber enviado nada. Marca el evento como procesado porque el mensaje ya
 * está listo y accesible para el comerciante; dejarlo en la cola reintentándose
 * para siempre solo llenaría la tabla sin cambiar nada.
 */
export const notificadorRegistro: Notificador = {
  nombre: "registro",
  async enviar(mensaje) {
    // El teléfono se recorta en el log: es un dato personal y no aporta nada
    // completo para depurar.
    console.info(
      `[outbox] mensaje listo para ${mensaje.telefono.slice(0, 5)}****: ${mensaje.texto.slice(0, 80)}`,
    );
    return { ok: true };
  },
};

export type ResumenProcesado = {
  reclamados: number;
  enviados: number;
  reintentar: number;
  fallidos: number;
  descartados: number;
};

/**
 * Procesa un lote de eventos pendientes.
 *
 * El reclamo es atómico (`claim_outbox_events` usa `for update skip locked`), así
 * que dos ejecuciones solapadas del cron no pueden tomar el mismo evento y mandar
 * el mismo mensaje dos veces.
 */
export async function procesarOutbox(
  notificador: Notificador = notificadorRegistro,
  limite = 20,
): Promise<ResumenProcesado> {
  const supabase = createAdminClient();
  const resumen: ResumenProcesado = {
    reclamados: 0,
    enviados: 0,
    reintentar: 0,
    fallidos: 0,
    descartados: 0,
  };

  const { data, error } = await supabase.rpc("claim_outbox_events", { p_limite: limite });
  if (error !== null) throw new Error(`no se pudo reclamar eventos: ${error.message}`);

  type Evento = { id: string; tipo: string; payload: Record<string, unknown>; intentos: number };
  const eventos = (data ?? []) as unknown as Evento[];
  resumen.reclamados = eventos.length;

  for (const evento of eventos) {
    const mensaje = construirMensaje(evento.tipo, evento.payload);

    // Un payload al que le falta lo esencial no se puede redactar, y reintentarlo
    // daría el mismo resultado siempre. Se descarta con motivo en vez de dejarlo
    // rebotando en la cola.
    if (mensaje === null) {
      await cerrar(supabase, evento.id, false, `payload insuficiente para ${evento.tipo}`, null);
      resumen.descartados++;
      continue;
    }

    let resultado: ResultadoEnvio;
    try {
      resultado = await notificador.enviar(mensaje);
    } catch (error) {
      // Una excepción del proveedor se trata como transitoria: casi siempre es red
      // o un timeout, y dar el evento por perdido en ese caso sería tirar un aviso
      // que el cliente espera.
      resultado = {
        ok: false,
        motivo: error instanceof Error ? error.message : String(error),
        transitorio: true,
      };
    }

    if (resultado.ok) {
      await cerrar(supabase, evento.id, true, null, null);
      resumen.enviados++;
      continue;
    }

    const proximoIntento = evento.intentos + 1;
    if (!resultado.transitorio || debeAbandonar(proximoIntento)) {
      await cerrar(supabase, evento.id, false, resultado.motivo, null);
      resumen.fallidos++;
      continue;
    }

    await cerrar(
      supabase,
      evento.id,
      false,
      resultado.motivo,
      Math.round(esperaReintentoMs(proximoIntento) / 1000),
    );
    resumen.reintentar++;
  }

  return resumen;
}

async function cerrar(
  supabase: ReturnType<typeof createAdminClient>,
  id: string,
  ok: boolean,
  motivo: string | null,
  esperaSegundos: number | null,
): Promise<void> {
  const { error } = await supabase.rpc("release_outbox_event", {
    p_id: id,
    p_ok: ok,
    p_error: motivo,
    p_espera_segundos: esperaSegundos,
  });
  // Si el cierre falla, el evento queda en 'procesando' y lo rescata
  // `recover_stuck_outbox_events`. Se registra pero no se lanza: un evento que no
  // se pudo cerrar no debe abortar el procesado de los demás del lote.
  if (error !== null) {
    console.error(`[outbox] no se pudo cerrar el evento ${id}: ${error.message}`);
  }
}

/**
 * Rescata eventos que quedaron en `procesando`.
 *
 * Ocurre cuando el worker muere a mitad: timeout de la función serverless,
 * reinicio del proceso. Sin esto el aviso se pierde en silencio, que es el peor
 * modo de fallo posible: nadie ve un error y el cliente nunca recibe su mensaje.
 */
export async function recuperarAtascados(minutos = 15): Promise<number> {
  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("recover_stuck_outbox_events", {
    p_minutos: minutos,
  });
  if (error !== null) throw new Error(`no se pudo recuperar eventos: ${error.message}`);
  return typeof data === "number" ? data : 0;
}
