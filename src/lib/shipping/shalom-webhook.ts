/**
 * Webhooks de tracking de Shalom (vía el wrapper no oficial).
 *
 * Tres propiedades del transporte condicionan todo este archivo:
 *
 * 1. LA FIRMA SE CALCULA SOBRE EL CUERPO CRUDO. El header es
 *    `X-Shalom-Signature: t=<timestamp>,v1=<hmac_hex>` con
 *    `v1 = HMAC_SHA256(t + "." + cuerpo_crudo, signing_secret)`. Si la ruta de
 *    Next hace `await request.json()` y luego se re-serializa el objeto para
 *    verificar, la firma NO cuadra: `JSON.stringify` puede cambiar el orden de
 *    claves, el escapado de no-ASCII y el espaciado. Hay que leer
 *    `await request.text()` UNA vez, verificar sobre ese string y solo después
 *    parsearlo.
 *
 * 2. ENTREGA AT-LEAST-ONCE. Un reintento reusa el mismo `X-Shalom-Event-Id`, así
 *    que la deduplicación es obligatoria y la clave es ese header. Sin ella, un
 *    reintento de `tracking.delivered` podría disparar dos veces los efectos de
 *    lado (marcar entregado, mandar el WhatsApp de "califica tu compra").
 *
 * 3. EL PING NO SE REINTENTA. Al registrar el webhook, Shalom manda una vez un
 *    `webhook.ping` firmado con un `data.challenge`, y el endpoint tiene ~5 s
 *    para responder 2xx devolviendo ese challenge en el body. Si falla, el
 *    webhook queda DESHABILITADO y hay que volver a registrarlo (obteniendo un
 *    `signing_secret` nuevo, porque el anterior solo se muestra una vez). En
 *    consecuencia: desplegar el endpoint ANTES de registrar el webhook, nunca al
 *    revés.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { canTransition, type OrderStatus } from "@/lib/order-status";
import { normalizarTimeline, type ShalomTimelineEntry } from "./tracking-normalizer";
import type { TrackingState } from "./types";

/** Nombres de los headers, en un solo sitio para no equivocarse al leerlos. */
export const HEADER_FIRMA = "x-shalom-signature";
export const HEADER_EVENTO = "x-shalom-event";
export const HEADER_EVENT_ID = "x-shalom-event-id";

/** Ventana anti-replay por defecto: 5 minutos, como especifica la doc. */
export const VENTANA_DEFECTO_SEGUNDOS = 300;

// ---------------------------------------------------------------------------
// Firma
// ---------------------------------------------------------------------------

export type FirmaParseada = { readonly t: string; readonly v1: string };

/**
 * Parsea `t=1750000000,v1=abc...`.
 *
 * Tolera espacios y el orden invertido de los pares porque el formato del header
 * no está garantizado por contrato (es un wrapper de terceros), pero exige que
 * ambos campos existan: sin `t` no hay anti-replay y sin `v1` no hay firma.
 */
export function parseSignatureHeader(header: string): FirmaParseada | null {
  if (typeof header !== "string" || header.trim() === "") return null;
  let t: string | null = null;
  let v1: string | null = null;
  for (const parte of header.split(",")) {
    const idx = parte.indexOf("=");
    if (idx === -1) continue;
    const clave = parte.slice(0, idx).trim().toLowerCase();
    const valor = parte.slice(idx + 1).trim();
    if (clave === "t" && /^\d+$/.test(valor)) t = valor;
    else if (clave === "v1" && /^[0-9a-fA-F]+$/.test(valor)) v1 = valor.toLowerCase();
  }
  if (t === null || v1 === null) return null;
  return { t, v1 };
}

/**
 * HMAC esperado para un `t` y un cuerpo crudo dados.
 *
 * Recibe el cuerpo como string y no como objeto a propósito: aceptar un objeto
 * obligaría a serializar aquí, que es exactamente el bug que el diseño evita.
 */
export function computeShalomSignature(t: string, rawBody: string, secret: string): string {
  return createHmac("sha256", Buffer.from(secret, "utf8"))
    .update(Buffer.from(`${t}.${rawBody}`, "utf8"))
    .digest("hex");
}

export type VerifyInput = {
  /** Cuerpo EXACTO recibido, sin reparsear. Ver la cabecera del archivo. */
  readonly rawBody: string;
  readonly signatureHeader: string | null | undefined;
  readonly secret: string;
  readonly ahora: Date;
  readonly ventanaSegundos?: number;
};

export type VerifyResult =
  | { readonly ok: true; readonly t: Date }
  | {
      readonly ok: false;
      readonly razon: "header_ausente" | "header_malformado" | "firma_invalida" | "fuera_de_ventana" | "sin_secreto";
      readonly motivo: string;
    };

/**
 * Verifica la firma y la ventana temporal.
 *
 * Devuelve un resultado en vez de lanzar porque la ruta HTTP tiene que traducir
 * cada razón a un código distinto (401 para firma mala, 400 para header
 * malformado) y decidir si loguear la alerta de seguridad.
 *
 * La comparación es en tiempo constante con `timingSafeEqual`, que lanza si los
 * buffers difieren en longitud. Una firma truncada es justo lo que enviaría
 * alguien probando, así que se comparan las longitudes antes y se devuelve
 * `false` en lugar de propagar la excepción y tumbar el endpoint. Comparar
 * longitudes no filtra nada útil (la del HMAC es pública y fija); comparar el
 * contenido con `===` sí filtraría, byte a byte, cuánto prefijo se acertó.
 */
export function verifyShalomSignature({
  rawBody,
  signatureHeader,
  secret,
  ahora,
  ventanaSegundos = VENTANA_DEFECTO_SEGUNDOS,
}: VerifyInput): VerifyResult {
  if (secret.trim() === "") {
    // Sin secreto no hay verificación posible. Se trata como fallo explícito y no
    // como "firma inválida" para que el operador sepa que el problema es de
    // configuración y no un ataque.
    return {
      ok: false,
      razon: "sin_secreto",
      motivo: "SHALOM_WEBHOOK_SECRET no está configurado: no se puede verificar la firma",
    };
  }
  if (signatureHeader === null || signatureHeader === undefined || signatureHeader.trim() === "") {
    return { ok: false, razon: "header_ausente", motivo: `falta el header ${HEADER_FIRMA}` };
  }
  const parsed = parseSignatureHeader(signatureHeader);
  if (parsed === null) {
    return {
      ok: false,
      razon: "header_malformado",
      motivo: `header ${HEADER_FIRMA} sin el formato t=<timestamp>,v1=<hex>`,
    };
  }

  const esperada = Buffer.from(computeShalomSignature(parsed.t, rawBody, secret), "utf8");
  const recibida = Buffer.from(parsed.v1, "utf8");
  if (esperada.length !== recibida.length || !timingSafeEqual(esperada, recibida)) {
    return {
      ok: false,
      razon: "firma_invalida",
      motivo: "la firma no corresponde al cuerpo recibido (¿se re-serializó el JSON?)",
    };
  }

  // La firma es válida: solo ahora tiene sentido mirar la ventana. Al revés se
  // filtraría, por la vía del mensaje de error, información sobre payloads no
  // autenticados.
  const t = new Date(Number(parsed.t) * 1000);
  const deltaSegundos = Math.abs(ahora.getTime() - t.getTime()) / 1000;
  if (deltaSegundos > ventanaSegundos) {
    // Se rechaza también el futuro: un `t` adelantado dejaría la firma válida
    // durante horas y anularía el anti-replay.
    return {
      ok: false,
      razon: "fuera_de_ventana",
      motivo: `timestamp fuera de la ventana de ${ventanaSegundos}s (delta ${Math.round(deltaSegundos)}s)`,
    };
  }
  return { ok: true, t };
}

// ---------------------------------------------------------------------------
// Parseo del evento
// ---------------------------------------------------------------------------

export const EVENTOS_SHALOM = [
  "webhook.ping",
  "tracking.updated",
  "tracking.delivered",
  "tracking.expired",
] as const;

export type ShalomEventName = (typeof EVENTOS_SHALOM)[number];

const timelineEntrySchema = z
  .object({
    milestone: z.string(),
    fecha: z.string(),
    hora: z.string().nullish(),
    descripcion: z.string().nullish(),
    completo: z.boolean().nullish(),
  })
  .passthrough();

/**
 * `status` llega con la misma forma que en `GET /v1/tracking` (hitos nulables).
 * Se acepta como `unknown` y lo interpreta el normalizador: duplicar aquí el
 * esquema de los 7 hitos solo crearía un segundo sitio que mantener.
 */
const eventSchema = z
  .object({
    id: z.string().min(1, "el evento no trae id"),
    event: z.string().min(1),
    occurred_at: z.string().nullish(),
    data: z
      .object({
        numero: z.string().nullish(),
        ose_id: z.string().nullish(),
        codigo: z.string().nullish(),
        status: z.unknown().nullish(),
        previous_status: z.unknown().nullish(),
        delivered: z.boolean().nullish(),
        timeline: z.array(timelineEntrySchema).nullish(),
        /** Solo en `webhook.ping`. */
        challenge: z.string().nullish(),
      })
      .passthrough(),
  })
  // `passthrough` en todos los niveles: el wrapper es de terceros y puede añadir
  // campos sin avisar. Rechazar por un campo extra descartaría eventos legítimos.
  .passthrough();

export type ShalomEvent = z.infer<typeof eventSchema>;

export type ParseEventResult =
  | { readonly ok: true; readonly evento: ShalomEvent }
  | { readonly ok: false; readonly motivo: string };

export function parseShalomEvent(raw: string): ParseEventResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, motivo: "el cuerpo del webhook no es JSON válido" };
  }
  const parsed = eventSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      motivo: parsed.error.issues.map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`).join("; "),
    };
  }
  return { ok: true, evento: parsed.data };
}

export function esEventoConocido(nombre: string): nombre is ShalomEventName {
  return (EVENTOS_SHALOM as readonly string[]).includes(nombre);
}

// ---------------------------------------------------------------------------
// Ping
// ---------------------------------------------------------------------------

export type PingChallenge =
  | { readonly esPing: true; readonly challenge: string }
  | { readonly esPing: false };

/**
 * Extrae el challenge que hay que devolver en el body de la respuesta.
 *
 * El endpoint debe responder 2xx con este valor en ~5 s. Recordatorio operativo:
 * el ping se manda UNA sola vez al registrar y NO se reintenta; si el endpoint no
 * está desplegado todavía, el webhook queda deshabilitado y hay que registrarlo
 * de nuevo, lo que genera un `signing_secret` nuevo (el anterior no se puede
 * recuperar: solo se muestra en la respuesta del registro).
 *
 * Por eso el orden correcto de despliegue es: (1) desplegar la ruta, (2)
 * comprobar que responde, (3) llamar a `PUT /v1/webhooks`, (4) guardar el
 * `signing_secret` en el gestor de secretos antes de cerrar la terminal.
 */
export function handlePingChallenge(evento: ShalomEvent): PingChallenge {
  if (evento.event !== "webhook.ping") return { esPing: false };
  const challenge = evento.data.challenge;
  if (typeof challenge !== "string" || challenge.trim() === "") {
    // Un ping sin challenge no se puede contestar correctamente. Se devuelve el
    // id del evento como último recurso, que al menos prueba que se leyó el
    // cuerpo, en vez de responder vacío y garantizar el fallo del registro.
    return { esPing: true, challenge: evento.id };
  }
  return { esPing: true, challenge };
}

// ---------------------------------------------------------------------------
// Decisión
// ---------------------------------------------------------------------------

export type AccionEnvio =
  | "marcar_enviado"
  | "marcar_entregado"
  | "actualizar_hitos"
  | "ignorar"
  | "revisar";

export type DecisionEnvio = {
  readonly accion: AccionEnvio;
  /**
   * Camino de transiciones a aplicar EN ORDEN, o vacío si el pedido no se toca.
   *
   * Es un camino y no un estado único porque `@/lib/order-status` no permite
   * saltar de `preparando` a `entregado`: exige pasar por `enviado`. Shalom puede
   * mandar el primer webhook ya con el paquete entregado (si el cliente lo
   * recogió el mismo día y el evento anterior se perdió), y devolver un estado
   * inalcanzable haría reventar la transición en la base con el paquete ya
   * entregado.
   */
  readonly transiciones: readonly OrderStatus[];
  readonly nuevoEstado: OrderStatus | null;
  /** Estado de tracking derivado del evento, para persistir la línea de tiempo. */
  readonly tracking: TrackingState;
  readonly motivo: string;
  /**
   * `true` cuando hace falta que un humano mire. El endpoint debe seguir
   * respondiendo 2xx: un 500 solo hace que el wrapper reintente sin arreglar
   * nada, y a los 21 días la suscripción expira.
   */
  readonly requiereAtencionHumana: boolean;
};

function decision(
  accion: AccionEnvio,
  transiciones: readonly OrderStatus[],
  tracking: TrackingState,
  motivo: string,
  requiereAtencionHumana = false,
): DecisionEnvio {
  return {
    accion,
    transiciones,
    nuevoEstado: transiciones.length === 0 ? null : transiciones[transiciones.length - 1],
    tracking,
    motivo,
    requiereAtencionHumana,
  };
}

/**
 * Camino legal desde el estado actual hasta `enviado`.
 *
 * Devuelve `null` si no hay camino (pedido cancelado, expirado o aún sin pagar):
 * en ese caso hay una incoherencia real entre logística y pagos que un webhook
 * no debe resolver solo.
 */
function caminoAEnviado(estado: OrderStatus): readonly OrderStatus[] | null {
  if (estado === "enviado" || estado === "entregado") return [];
  if (canTransition(estado, "enviado")) return ["enviado"];
  if (canTransition(estado, "preparando") && canTransition("preparando", "enviado")) {
    return ["preparando", "enviado"];
  }
  return null;
}

/**
 * Qué hacer con el pedido ante un evento de tracking.
 *
 * Pura e IDEMPOTENTE: la propiedad clave es que aplicarla dos veces con el mismo
 * evento no produzca dos efectos. Si el pedido ya está `entregado` y llega otra
 * notificación de entrega (el wrapper entrega at-least-once), la acción es
 * `ignorar`, no "marcar entregado otra vez". La deduplicación por
 * `X-Shalom-Event-Id` es la segunda línea de defensa; esta función tiene que ser
 * correcta incluso si el registro de eventos procesados se pierde.
 */
export function decidirAccionEnvio(evento: ShalomEvent, estadoActualPedido: OrderStatus): DecisionEnvio {
  const timeline = (evento.data.timeline ?? []) as readonly ShalomTimelineEntry[];
  const tracking = normalizarTimeline(timeline);

  if (!esEventoConocido(evento.event)) {
    // Un evento nuevo del wrapper no puede tratarse como entrega (se cerraría un
    // pedido sin pruebas) ni descartarse en silencio.
    return decision(
      "revisar",
      [],
      tracking,
      `evento de Shalom no reconocido: ${evento.event}`,
      true,
    );
  }

  switch (evento.event) {
    case "webhook.ping":
      // El ping no habla de ningún pedido: lo resuelve `handlePingChallenge`.
      return decision("ignorar", [], tracking, "evento de verificación del webhook");

    case "tracking.delivered":
      return decidirEntregado(estadoActualPedido, tracking);

    case "tracking.updated":
      // `delivered: true` en un `updated` ocurre cuando el evento `delivered` se
      // perdió: se trata igual que una entrega para no dejar el pedido colgado.
      return evento.data.delivered === true
        ? decidirEntregado(estadoActualPedido, tracking)
        : decidirActualizacion(estadoActualPedido, tracking);

    case "tracking.expired":
      return decidirExpirado(estadoActualPedido, tracking);
  }
}

function decidirEntregado(estado: OrderStatus, tracking: TrackingState): DecisionEnvio {
  if (estado === "entregado") {
    // ESTE es el caso de la idempotencia: reintento del mismo evento o segundo
    // aviso de entrega. Volver a "entregar" dispararía otra vez los efectos de
    // lado (mensaje de valoración, cierre de garantía).
    return decision("ignorar", [], tracking, "el pedido ya estaba entregado: notificación repetida");
  }
  if (estado === "cancelado" || estado === "expirado") {
    // Shalom entregó un paquete de un pedido que aquí está cancelado. Puede ser
    // una guía reutilizada o una cancelación tardía; en cualquier caso implica
    // mercadería fuera de control y no lo arregla un webhook.
    return decision(
      "revisar",
      [],
      tracking,
      `Shalom notificó entrega de un pedido ${estado}: revisar si salió mercadería`,
      true,
    );
  }
  const camino = caminoAEnviado(estado);
  if (camino === null) {
    return decision(
      "revisar",
      [],
      tracking,
      `entrega notificada con el pedido en ${estado}, sin camino válido hasta enviado`,
      true,
    );
  }
  // `enviado → entregado` siempre es legal; el camino previo garantiza llegar a
  // `enviado` desde donde estuviera.
  return decision(
    "marcar_entregado",
    [...camino, "entregado"],
    tracking,
    "Shalom confirmó la entrega del paquete",
  );
}

function decidirActualizacion(estado: OrderStatus, tracking: TrackingState): DecisionEnvio {
  if (estado === "entregado") {
    // Un `updated` posterior a la entrega solo trae hitos administrativos que
    // Shalom cierra al final del día. No se toca el pedido, pero los hitos sí se
    // guardan: enriquecen la línea de tiempo sin cambiar el estado.
    return decision(
      "actualizar_hitos",
      [],
      tracking,
      "pedido ya entregado: solo se actualiza la línea de tiempo",
    );
  }
  if (estado === "cancelado" || estado === "expirado") {
    return decision(
      "revisar",
      [],
      tracking,
      `hay movimiento en Shalom de un pedido ${estado}`,
      true,
    );
  }

  // El paquete está físicamente en manos de Shalom, así que el pedido está
  // enviado aunque el panel no lo haya marcado. `origen` es el primer hito que lo
  // prueba: el paquete ya fue recibido en la agencia.
  const enManosDeShalom =
    tracking.ultimoHito !== null && tracking.ultimoHito !== "registrado";

  if (!enManosDeShalom) {
    // `registrado` solo significa que la guía existe. El paquete puede seguir en
    // la tienda, así que marcar "enviado" mentiría al cliente.
    return decision(
      "actualizar_hitos",
      [],
      tracking,
      "guía registrada en Shalom: el paquete aún no fue recibido en agencia",
    );
  }

  if (estado === "enviado") {
    return decision("actualizar_hitos", [], tracking, "avance de hitos sin cambio de estado");
  }

  const camino = caminoAEnviado(estado);
  if (camino === null || camino.length === 0) {
    return decision(
      "revisar",
      [],
      tracking,
      `movimiento en Shalom con el pedido en ${estado}: no hay transición válida a enviado`,
      true,
    );
  }
  return decision(
    "marcar_enviado",
    camino,
    tracking,
    `Shalom recibió el paquete (hito ${tracking.ultimoHito})`,
  );
}

function decidirExpirado(estado: OrderStatus, tracking: TrackingState): DecisionEnvio {
  if (estado === "entregado") {
    // La suscripción caducó después de la entrega: no hay nada que hacer.
    return decision("ignorar", [], tracking, "suscripción de rastreo cerrada tras la entrega");
  }
  // 21 días sin entregarse. En provincia esto suele significar que el cliente no
  // fue a recoger y Shalom va a devolver el paquete al remitente. Cobrar la
  // devolución o reenviar es una decisión comercial, no automatizable.
  return decision(
    "revisar",
    [],
    tracking,
    "el rastreo expiró (~21 días) sin entrega: probable paquete no recogido en agencia",
    true,
  );
}

// ---------------------------------------------------------------------------
// Deduplicación
// ---------------------------------------------------------------------------

/**
 * Registro de eventos ya procesados.
 *
 * Se define como interfaz y no como implementación porque en producción tiene
 * que ser una tabla con índice único sobre el `event_id`: un `Set` en memoria no
 * sirve cuando hay más de una instancia del servidor o cuando reinicia, y es
 * justo entonces cuando llegan los reintentos.
 */
export interface RegistroEventos {
  /** `true` si el evento ya se procesó. */
  yaProcesado(eventId: string): Promise<boolean>;
  marcarProcesado(eventId: string): Promise<void>;
}

/**
 * Dedup en memoria, para tests y para el entorno de desarrollo.
 *
 * NO usar en producción: no sobrevive a un reinicio ni se comparte entre
 * instancias.
 */
export class RegistroEventosEnMemoria implements RegistroEventos {
  private readonly vistos = new Set<string>();
  async yaProcesado(eventId: string): Promise<boolean> {
    return this.vistos.has(eventId);
  }
  async marcarProcesado(eventId: string): Promise<void> {
    this.vistos.add(eventId);
  }
}

export type ProcesarWebhookInput = {
  readonly rawBody: string;
  /** Headers en minúsculas. Next los entrega así vía `request.headers`. */
  readonly headers: Readonly<Record<string, string | null | undefined>>;
  readonly secret: string;
  readonly ahora: Date;
  readonly estadoActualPedido: OrderStatus;
  readonly registro?: RegistroEventos;
  readonly ventanaSegundos?: number;
};

export type ProcesarWebhookResult =
  | { readonly ok: false; readonly razon: string; readonly httpStatus: number }
  | {
      readonly ok: true;
      readonly tipo: "ping";
      readonly challenge: string;
    }
  | {
      readonly ok: true;
      readonly tipo: "evento";
      readonly eventId: string;
      readonly duplicado: boolean;
      readonly decision: DecisionEnvio;
    };

/**
 * Orquesta el flujo completo: verificar, parsear, deduplicar, decidir.
 *
 * El orden importa. Verificar ANTES de parsear evita gastar CPU en payloads no
 * autenticados y, más importante, evita que un JSON malicioso llegue al esquema.
 * Deduplicar DESPUÉS de verificar evita que alguien sin la clave pueda envenenar
 * el registro de ids procesados y bloquear eventos legítimos.
 */
export async function procesarWebhookShalom(
  input: ProcesarWebhookInput,
): Promise<ProcesarWebhookResult> {
  const verificacion = verifyShalomSignature({
    rawBody: input.rawBody,
    signatureHeader: input.headers[HEADER_FIRMA],
    secret: input.secret,
    ahora: input.ahora,
    ...(input.ventanaSegundos !== undefined ? { ventanaSegundos: input.ventanaSegundos } : {}),
  });
  if (!verificacion.ok) {
    // 400 para lo que es culpa del formato, 401 para lo que es culpa de la clave.
    const httpStatus =
      verificacion.razon === "header_malformado" || verificacion.razon === "header_ausente" ? 400 : 401;
    return { ok: false, razon: verificacion.motivo, httpStatus };
  }

  const parsed = parseShalomEvent(input.rawBody);
  if (!parsed.ok) return { ok: false, razon: parsed.motivo, httpStatus: 400 };
  const evento = parsed.evento;

  const ping = handlePingChallenge(evento);
  if (ping.esPing) {
    // El ping no se deduplica: no se reintenta nunca y responderlo dos veces no
    // tiene efectos de lado.
    return { ok: true, tipo: "ping", challenge: ping.challenge };
  }

  // El id del header manda sobre el del cuerpo: es el que el wrapper reusa en los
  // reintentos. Coinciden en la práctica, pero el contrato de deduplicación está
  // definido sobre el header.
  const eventId = input.headers[HEADER_EVENT_ID]?.trim() || evento.id;

  if (input.registro !== undefined && (await input.registro.yaProcesado(eventId))) {
    return {
      ok: true,
      tipo: "evento",
      eventId,
      duplicado: true,
      decision: decision(
        "ignorar",
        [],
        normalizarTimeline((evento.data.timeline ?? []) as readonly ShalomTimelineEntry[]),
        `evento ${eventId} ya procesado: entrega at-least-once`,
      ),
    };
  }

  const resultado = decidirAccionEnvio(evento, input.estadoActualPedido);
  // Se marca antes de devolver, pero el llamador es responsable de que marcar y
  // aplicar las transiciones ocurran en la MISMA transacción: si se marca aquí y
  // la transición falla después, el reintento se descartaría como duplicado y el
  // pedido quedaría desactualizado para siempre.
  await input.registro?.marcarProcesado(eventId);
  return { ok: true, tipo: "evento", eventId, duplicado: false, decision: resultado };
}
