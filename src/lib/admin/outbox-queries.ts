/**
 * Avisos encolados en el outbox, vistos desde el panel.
 *
 * POR QUÉ EXISTE ESTA CONSULTA: no hay proveedor de WhatsApp conectado (la API de
 * WhatsApp Business exige verificación de negocio y plantillas aprobadas). El
 * notificador por defecto del worker solo registra el mensaje y cierra el evento,
 * así que sin esta pantalla los avisos se redactan y nadie los ve nunca. Acá el
 * comerciante lee el mensaje ya escrito, abre el enlace `wa.me` y registra que lo
 * mandó.
 *
 * OJO CON EL SIGNIFICADO DE `enviado`: con el notificador de registro quiere decir
 * "el mensaje quedó listo", NO "el cliente lo recibió". Por eso la consulta también
 * trae los últimos cerrados: si el cron pasó antes que el comerciante, el evento ya
 * está en `enviado` y el mensaje seguiría siendo invisible. Son pocos y de solo
 * lectura, para poder recuperar el texto sin entrar a la base.
 *
 * Va con la service_role key porque la RLS del outbox exige `is_admin()` y esta
 * pantalla necesita leer la cola completa, incluidos los eventos cuyo payload ya no
 * corresponde a ningún pedido legible. La autorización se comprobó en el layout del
 * panel y las políticas siguen activas por debajo.
 */

import { createAdminClient } from "@/lib/supabase/client";
import {
  construirMensaje,
  esTipoConocido,
  normalizarTelefono,
  type MensajeListo,
  type TipoOutbox,
} from "@/lib/outbox/messages";

export type EstadoOutbox = "pendiente" | "procesando" | "enviado" | "fallido";

/**
 * A quién va dirigido el aviso.
 *
 * Es la distinción que decide la UI: el comerciante no se manda un WhatsApp a sí
 * mismo, así que en sus propios avisos el enlace útil es el del panel.
 */
export type DestinoAviso = "cliente" | "comerciante";

export type AvisoOutbox = {
  id: string;
  tipo: string;
  etiqueta: string;
  destino: DestinoAviso;
  status: EstadoOutbox;
  intentos: number;
  ultimoError: string | null;
  creadoEn: string;
  /** Momento programado, solo si todavía no venció. `null` si ya toca procesarlo. */
  esperaHasta: string | null;
  reference: string | null;
  /** Mensaje redactado, o `null` si al payload le falta lo mínimo. */
  mensaje: MensajeListo | null;
  /** Qué dato falta, en lenguaje llano. Solo cuando `mensaje` es `null`. */
  faltante: string | null;
};

export type AvisosPanel = {
  /** Pendientes en orden FIFO, el mismo con el que los toma el worker. */
  pendientes: AvisoOutbox[];
  /** Fallidos, del más reciente al más antiguo: lo último que se rompió importa más. */
  fallidos: AvisoOutbox[];
  /** Últimos cerrados, solo como contexto de lectura. */
  enviados: AvisoOutbox[];
};

/** Cuántos cerrados se traen: los de hoy caben de sobra y no infla la página. */
const LIMITE_ENVIADOS = 10;

/**
 * Tope de eventos accionables.
 *
 * Una cola sana tiene un puñado de eventos. Si esta pantalla llega al tope, el
 * problema no es la paginación: es que nadie está vaciando la cola.
 */
const LIMITE_ACCIONABLES = 200;

const ETIQUETA_TIPO: Readonly<Record<TipoOutbox, string>> = {
  whatsapp_comprobante_recibido: "Comprobante nuevo por revisar",
  whatsapp_pago_aprobado: "Pago aprobado",
  whatsapp_pago_rechazado: "Pago rechazado",
  whatsapp_pedido_enviado: "Pedido enviado",
  restock_aviso: "Volvió el stock",
};

/** Nombre legible del evento. Un tipo desconocido se muestra tal cual: esconderlo dejaría una fila sin explicación. */
export function etiquetaAviso(tipo: string): string {
  return esTipoConocido(tipo) ? ETIQUETA_TIPO[tipo] : tipo;
}

export function destinoAviso(tipo: string): DestinoAviso {
  // `whatsapp_comprobante_recibido` se encola para avisar al comerciante de que hay
  // trabajo pendiente, aunque el payload lleve el teléfono del cliente.
  return tipo === "whatsapp_comprobante_recibido" ? "comerciante" : "cliente";
}

function textoDePayload(payload: Record<string, unknown>, clave: string): string | null {
  const valor = payload[clave];
  return typeof valor === "string" && valor.trim() !== "" ? valor.trim() : null;
}

/**
 * Traduce a lenguaje llano por qué no se pudo redactar el mensaje.
 *
 * La fuente de verdad de si un evento es redactable sigue siendo `construirMensaje`:
 * esto solo se consulta cuando ya devolvió `null`, para no tener dos decisiones que
 * puedan discrepar. Existe porque "payload insuficiente" no le dice nada al
 * comerciante, y saber que falta el teléfono sí: le dice que el aviso hay que darlo
 * a mano y que el evento se puede descartar.
 */
export function faltanteDelPayload(
  tipo: string,
  payload: Record<string, unknown>,
): string | null {
  if (!esTipoConocido(tipo)) return "un tipo de evento que el sistema sepa redactar";
  if (normalizarTelefono(payload.telefono) === null) return "el teléfono del cliente";
  if (textoDePayload(payload, "reference") === null) return "la referencia del pedido";
  if (tipo === "whatsapp_pedido_enviado" && textoDePayload(payload, "guia") === null) {
    return "el número de guía";
  }
  if (
    tipo === "restock_aviso" &&
    (textoDePayload(payload, "modelo") === null || typeof payload.size_us !== "number")
  ) {
    return "el modelo o la talla";
  }
  return null;
}

type FilaOutbox = {
  id: string;
  tipo: string;
  payload: Record<string, unknown> | null;
  status: EstadoOutbox;
  intentos: number;
  ultimo_error: string | null;
  procesar_despues_de: string;
  created_at: string;
};

/**
 * Convierte una fila del outbox en lo que la pantalla necesita.
 *
 * Se separa de la consulta para poder probarla sin base de datos: es donde vive la
 * decisión de qué se puede mandar y qué no.
 */
export function adaptarAviso(fila: FilaOutbox, ahora: Date = new Date()): AvisoOutbox {
  const payload = fila.payload ?? {};
  const mensaje = construirMensaje(fila.tipo, payload);
  const espera = new Date(fila.procesar_despues_de);

  return {
    id: fila.id,
    tipo: fila.tipo,
    etiqueta: etiquetaAviso(fila.tipo),
    destino: destinoAviso(fila.tipo),
    status: fila.status,
    intentos: fila.intentos,
    ultimoError: fila.ultimo_error,
    creadoEn: fila.created_at,
    esperaHasta: espera.getTime() > ahora.getTime() ? fila.procesar_despues_de : null,
    reference: textoDePayload(payload, "reference"),
    mensaje,
    // El `??` cubre una deriva futura: si `construirMensaje` empieza a exigir un
    // dato que acá no se contempla, la fila sigue explicándose en vez de mostrar un
    // hueco.
    faltante:
      mensaje === null
        ? (faltanteDelPayload(fila.tipo, payload) ?? "algún dato obligatorio")
        : null,
  };
}

const COLUMNAS =
  "id, tipo, payload, status, intentos, ultimo_error, procesar_despues_de, created_at";

/**
 * Lista los avisos del outbox agrupados por lo que hay que hacer con ellos.
 *
 * `procesando` queda fuera a propósito: son eventos que el worker tiene tomados en
 * este instante. Mostrarlos invitaría a mandar a mano un mensaje que el worker está
 * cerrando, y los que se quedaron colgados los devuelve a `pendiente`
 * `recover_stuck_outbox_events`, así que reaparecen solos.
 */
export async function listarAvisos(): Promise<AvisosPanel> {
  const supabase = createAdminClient();

  const [accionables, cerrados] = await Promise.all([
    supabase
      .from("outbox")
      .select(COLUMNAS)
      .in("status", ["pendiente", "fallido"])
      .order("created_at", { ascending: true })
      .limit(LIMITE_ACCIONABLES),

    supabase
      .from("outbox")
      .select(COLUMNAS)
      .eq("status", "enviado")
      .order("created_at", { ascending: false })
      .limit(LIMITE_ENVIADOS),
  ]);

  if (accionables.error !== null) {
    throw new Error(`no se pudieron leer los avisos: ${accionables.error.message}`);
  }

  const ahora = new Date();
  const filas = (accionables.data ?? []) as unknown as FilaOutbox[];
  const avisos = filas.map((fila) => adaptarAviso(fila, ahora));

  // Un fallo leyendo el historial no puede tumbar la pantalla: lo accionable es lo
  // que la justifica, y los cerrados son solo contexto.
  const enviados =
    cerrados.error !== null
      ? []
      : ((cerrados.data ?? []) as unknown as FilaOutbox[]).map((fila) =>
          adaptarAviso(fila, ahora),
        );

  return {
    pendientes: avisos.filter((a) => a.status === "pendiente"),
    fallidos: avisos.filter((a) => a.status === "fallido").reverse(),
    enviados,
  };
}
