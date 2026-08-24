/**
 * Normalización del tracking de Shalom a un `TrackingState` único.
 *
 * Hay dos formas de recibir lo mismo y las dos tienen que producir el mismo
 * resultado:
 *
 * 1. `GET /v1/tracking` devuelve un objeto `status` con los 7 hitos como claves,
 *    donde los que aún no ocurrieron llegan literalmente en `null`.
 * 2. El webhook manda `data.timeline[]`, un array con `fecha` y `hora` en campos
 *    SEPARADOS.
 *
 * Si cada consumidor interpretara su formato, la línea de tiempo del cliente y
 * la del panel se desincronizarían. De ahí que todo pase por aquí.
 *
 * ZONA HORARIA — la trampa principal de este archivo:
 *
 * Shalom manda `"2026-04-16 11:40:45"`, sin zona y sin `T`. Son las 11:40 en
 * PERÚ (UTC-05:00, sin horario de verano desde 1994). `new Date("2026-04-16
 * 11:40:45")` en Node interpreta el string en la zona LOCAL del servidor, y
 * `Date.parse("2026-04-16T11:40:45Z")` lo interpretaría como UTC. Ninguna de las
 * dos es correcta:
 *
 * - Como UTC, el evento se mostraría a las 06:40 de Perú: cinco horas antes de
 *   que ocurriera, y un envío entregado por la tarde aparecería entregado por la
 *   mañana.
 * - Como hora local del servidor, el resultado depende de dónde se despliegue.
 *   En un runtime serverless en UTC coincidiría con el bug anterior; en uno en
 *   Europa el desfase sería de 6 o 7 horas y variaría con el horario de verano.
 *
 * Por eso se construye el instante sumando explícitamente el offset de Perú, sin
 * depender de `TZ` ni de `Intl`. Perú no aplica DST, así que el offset es una
 * constante y no hace falta una librería de zonas.
 */

import {
  ORDEN_HITOS,
  type TrackingEvent,
  type TrackingMilestone,
  type TrackingState,
} from "./types";

/** Offset fijo de Perú (PET). Constante porque Perú no observa horario de verano. */
export const PERU_UTC_OFFSET_MINUTOS = -300;

const RE_FECHA_HORA = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;
const RE_SOLO_FECHA = /^(\d{4})-(\d{2})-(\d{2})$/;
const RE_SOLO_HORA = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * Convierte `"YYYY-MM-DD HH:MM:SS"` en hora de Perú al instante absoluto.
 *
 * Devuelve `null` en vez de una fecha inválida: un hito con fecha corrupta debe
 * omitirse de la línea de tiempo, no envenenarla con un `Invalid Date` que luego
 * rompe el ordenamiento y se renderiza como "NaN".
 */
export function parsearFechaPeru(texto: string): Date | null {
  const m = RE_FECHA_HORA.exec(texto.trim());
  if (m === null) return null;
  const [, y, mes, d, h, min, seg] = m;
  return construirInstantePeru(
    Number(y),
    Number(mes),
    Number(d),
    Number(h),
    Number(min),
    seg === undefined ? 0 : Number(seg),
  );
}

/**
 * Variante para el webhook, que parte la fecha y la hora en dos campos.
 *
 * `hora` puede faltar: el timeline la omite en hitos que Shalom registra solo a
 * nivel de día. En ese caso se asume medianoche de Perú, que ordena el evento en
 * el día correcto aunque pierda precisión horaria.
 */
export function parsearFechaHoraPeru(fecha: string, hora?: string | null): Date | null {
  const f = RE_SOLO_FECHA.exec(fecha.trim());
  if (f === null) {
    // Algunos payloads mandan la fecha ya completa en `fecha` e ignoran `hora`.
    return parsearFechaPeru(fecha);
  }
  const [, y, mes, d] = f;
  let h = 0;
  let min = 0;
  let seg = 0;
  if (hora !== undefined && hora !== null && hora.trim() !== "") {
    const t = RE_SOLO_HORA.exec(hora.trim());
    if (t === null) return null;
    h = Number(t[1]);
    min = Number(t[2]);
    seg = t[3] === undefined ? 0 : Number(t[3]);
  }
  return construirInstantePeru(Number(y), Number(mes), Number(d), h, min, seg);
}

/**
 * `Date.UTC` de los componentes tal cual, menos el offset de Perú.
 *
 * Restar un offset negativo suma 5 horas: las 11:40 de Perú son las 16:40 UTC.
 * Se valida que los componentes sobrevivan el viaje de ida y vuelta para
 * rechazar fechas imposibles como `2026-02-30`, que `Date.UTC` normalizaría en
 * silencio al 2 de marzo.
 */
function construirInstantePeru(
  y: number,
  mes: number,
  d: number,
  h: number,
  min: number,
  seg: number,
): Date | null {
  if (mes < 1 || mes > 12 || d < 1 || d > 31) return null;
  if (h > 23 || min > 59 || seg > 59) return null;
  const utcMs = Date.UTC(y, mes - 1, d, h, min, seg) - PERU_UTC_OFFSET_MINUTOS * 60_000;
  const fecha = new Date(utcMs);
  if (Number.isNaN(fecha.getTime())) return null;
  // Rechaza el desbordamiento de día (31 de abril, 30 de febrero).
  const comprobacion = new Date(utcMs + PERU_UTC_OFFSET_MINUTOS * 60_000);
  if (comprobacion.getUTCMonth() !== mes - 1 || comprobacion.getUTCDate() !== d) return null;
  return fecha;
}

/**
 * Formatea un instante como hora de Perú, para mostrarlo al cliente.
 *
 * Se implementa a mano en vez de con `Intl.DateTimeFormat("es-PE", { timeZone:
 * "America/Lima" })` porque la base de datos de zonas de un runtime serverless
 * mínimo puede no incluir `America/Lima`, y en ese caso `Intl` cae silenciosamente
 * a UTC: el mismo desfase de 5 horas que este módulo existe para evitar.
 */
export function formatearFechaPeru(fecha: Date): string {
  const local = new Date(fecha.getTime() + PERU_UTC_OFFSET_MINUTOS * 60_000);
  const dos = (n: number) => String(n).padStart(2, "0");
  return (
    `${local.getUTCFullYear()}-${dos(local.getUTCMonth() + 1)}-${dos(local.getUTCDate())} ` +
    `${dos(local.getUTCHours())}:${dos(local.getUTCMinutes())}`
  );
}

// ---------------------------------------------------------------------------
// Descripciones
// ---------------------------------------------------------------------------

/**
 * Textos para el cliente. Deliberadamente menos técnicos que los nombres de
 * Shalom: "en tránsito" le dice más que "transito", y "demora" a secas suena a
 * error del sistema en vez de a lo que es.
 */
export const DESCRIPCION_HITO: Readonly<Record<TrackingMilestone, string>> = {
  registrado: "Pedido registrado en Shalom",
  origen: "Recibido en la agencia de origen",
  transito: "En tránsito hacia el destino",
  demora: "Con demora en el traslado",
  destino: "Llegó a la agencia de destino",
  reparto: "En reparto a domicilio",
  entregado: "Entregado",
};

const POSICION_HITO: Readonly<Record<TrackingMilestone, number>> = ORDEN_HITOS.reduce(
  (acc, hito, i) => ({ ...acc, [hito]: i }),
  {} as Record<TrackingMilestone, number>,
);

// ---------------------------------------------------------------------------
// Entradas crudas
// ---------------------------------------------------------------------------

/** Un hito del objeto `status`, tal cual lo manda Shalom. */
export type ShalomStatusHito = {
  readonly fecha?: string | null;
  readonly completo?: boolean | null;
  /** Solo en `transito`. Se guarda para enriquecer la descripción. */
  readonly carguero?: string | null;
  readonly cargueros?: readonly string[] | null;
} & Record<string, unknown>;

/**
 * El objeto `status`. Los 7 hitos son opcionales Y nulables: Shalom manda `null`
 * en los que no ocurrieron, y eso es lo normal, no un error.
 */
export type ShalomStatus = {
  readonly [K in TrackingMilestone]?: ShalomStatusHito | null;
};

/** Una entrada del `timeline[]` del webhook. */
export type ShalomTimelineEntry = {
  readonly milestone: string;
  readonly fecha: string;
  readonly hora?: string | null;
  readonly descripcion?: string | null;
  readonly completo?: boolean | null;
};

function esHitoConocido(valor: string): valor is TrackingMilestone {
  return (ORDEN_HITOS as readonly string[]).includes(valor);
}

// ---------------------------------------------------------------------------
// Normalización
// ---------------------------------------------------------------------------

/**
 * Ordena por instante ascendente y, ante empate exacto, por el orden canónico
 * del flujo.
 *
 * El desempate no es cosmético: Shalom reporta a segundo y `registrado` y
 * `origen` caen a menudo en el mismo segundo. Sin él, el orden dependería de la
 * estabilidad del sort sobre el orden de claves del JSON, y la línea de tiempo
 * podría mostrar "recibido en origen" antes de "registrado".
 */
function ordenar(eventos: TrackingEvent[]): TrackingEvent[] {
  return [...eventos].sort((a, b) => {
    const dt = a.fecha.getTime() - b.fecha.getTime();
    if (dt !== 0) return dt;
    return POSICION_HITO[a.milestone] - POSICION_HITO[b.milestone];
  });
}

/**
 * Deriva el estado agregado a partir de los eventos ya ordenados.
 *
 * `entregado` y `enReparto` se leen de la presencia del hito y no del último
 * evento porque el orden por fecha puede dejar otro hito al final: Shalom a
 * veces registra `destino` con una fecha posterior a `entregado` cuando el
 * personal de la agencia cierra los registros al final del día.
 *
 * `ultimoHito` sí es el más avanzado según el flujo canónico, no el más reciente
 * por fecha, por la misma razón: es lo que se muestra como "estado actual" y
 * retroceder de "entregado" a "en agencia de destino" confundiría al cliente.
 */
function derivar(eventos: readonly TrackingEvent[]): TrackingState {
  const hitos = new Set(eventos.map((e) => e.milestone));
  let ultimoHito: TrackingMilestone | null = null;
  for (const e of eventos) {
    if (ultimoHito === null || POSICION_HITO[e.milestone] > POSICION_HITO[ultimoHito]) {
      ultimoHito = e.milestone;
    }
  }
  return {
    entregado: hitos.has("entregado"),
    // Una vez entregado ya no está en reparto, aunque el hito `reparto` siga
    // presente: son estados acumulativos en Shalom, no excluyentes.
    enReparto: hitos.has("reparto") && !hitos.has("entregado"),
    // La demora se considera resuelta si el paquete ya llegó a destino o se
    // entregó; mantenerla activa alarmaría al cliente sobre un problema pasado.
    conDemora: hitos.has("demora") && !hitos.has("destino") && !hitos.has("entregado"),
    ultimoHito,
    eventos,
  };
}

/**
 * Normaliza el objeto `status` de `GET /v1/tracking`.
 *
 * Los hitos en `null`, ausentes o con fecha impareseable se omiten en silencio:
 * son el caso mayoritario (un envío recién registrado tiene 6 de 7 en `null`) y
 * tratarlos como error haría que el rastreo fallara para casi todos los pedidos.
 */
export function normalizarStatus(status: ShalomStatus | null | undefined): TrackingState {
  if (status === null || status === undefined) return derivar([]);
  const eventos: TrackingEvent[] = [];
  for (const hito of ORDEN_HITOS) {
    const bruto = status[hito];
    if (bruto === null || bruto === undefined) continue;
    const textoFecha = typeof bruto.fecha === "string" ? bruto.fecha : "";
    if (textoFecha.trim() === "") continue;
    const fecha = parsearFechaPeru(textoFecha);
    if (fecha === null) continue;
    eventos.push({
      milestone: hito,
      fecha,
      descripcion: descripcionConCarguero(hito, bruto),
      // `completo` solo viene en `transito` y `destino`. Ausente significa que
      // Shalom no lo reporta para ese hito, no que esté incompleto.
      completo: typeof bruto.completo === "boolean" ? bruto.completo : true,
    });
  }
  return derivar(ordenar(eventos));
}

/**
 * Añade el nombre del carguero a la descripción de `transito` cuando Shalom lo
 * manda: es el dato que más piden los clientes por WhatsApp ("¿con qué empresa
 * va mi paquete?") y tenerlo evita una consulta manual.
 */
function descripcionConCarguero(hito: TrackingMilestone, bruto: ShalomStatusHito): string {
  const base = DESCRIPCION_HITO[hito];
  if (hito !== "transito") return base;
  const nombres =
    typeof bruto.carguero === "string" && bruto.carguero.trim() !== ""
      ? [bruto.carguero.trim()]
      : Array.isArray(bruto.cargueros)
        ? bruto.cargueros.filter((c): c is string => typeof c === "string" && c.trim() !== "")
        : [];
  return nombres.length === 0 ? base : `${base} (${nombres.join(", ")})`;
}

/**
 * Normaliza el `timeline[]` del webhook.
 *
 * Descarta hitos desconocidos en vez de fallar: si Shalom añade un octavo hito,
 * el webhook debe seguir procesándose y actualizando los siete que sí conocemos.
 * Devolver un 500 por un hito nuevo haría que el wrapper reintentara para
 * siempre y, a los 21 días, la suscripción expiraría sin haber avanzado nada.
 */
export function normalizarTimeline(
  timeline: readonly ShalomTimelineEntry[] | null | undefined,
): TrackingState {
  if (timeline === null || timeline === undefined) return derivar([]);
  const eventos: TrackingEvent[] = [];
  for (const entrada of timeline) {
    if (typeof entrada.milestone !== "string" || !esHitoConocido(entrada.milestone)) continue;
    if (typeof entrada.fecha !== "string") continue;
    const fecha = parsearFechaHoraPeru(entrada.fecha, entrada.hora ?? null);
    if (fecha === null) continue;
    const descripcion =
      typeof entrada.descripcion === "string" && entrada.descripcion.trim() !== ""
        ? entrada.descripcion.trim()
        : DESCRIPCION_HITO[entrada.milestone];
    eventos.push({
      milestone: entrada.milestone,
      fecha,
      descripcion,
      completo: typeof entrada.completo === "boolean" ? entrada.completo : true,
    });
  }
  return derivar(ordenar(deduplicar(eventos)));
}

/**
 * Un mismo hito no puede aparecer dos veces en la línea de tiempo.
 *
 * El webhook reenvía el timeline completo en cada evento, y al fusionar estados
 * (por ejemplo tras un reintento) es fácil acabar con `transito` duplicado. Se
 * conserva la aparición más reciente por fecha, que es la que trae el `completo`
 * y la descripción más actualizados.
 */
function deduplicar(eventos: readonly TrackingEvent[]): TrackingEvent[] {
  const porHito = new Map<TrackingMilestone, TrackingEvent>();
  for (const e of eventos) {
    const previo = porHito.get(e.milestone);
    if (previo === undefined || e.fecha.getTime() >= previo.fecha.getTime()) {
      porHito.set(e.milestone, e);
    }
  }
  return [...porHito.values()];
}

/**
 * Fusiona dos estados del mismo envío.
 *
 * Necesario porque las dos fuentes conviven: el webhook llega con el timeline y
 * un `GET` posterior puede traer hitos que el webhook no incluía (o al revés, si
 * un webhook se perdió). Perder hitos al refrescar haría que la línea de tiempo
 * del cliente diera marcha atrás.
 */
export function fusionarTracking(a: TrackingState, b: TrackingState): TrackingState {
  return derivar(ordenar(deduplicar([...a.eventos, ...b.eventos])));
}

/** Estado vacío, para pedidos sin guía todavía. */
export function trackingVacio(): TrackingState {
  return derivar([]);
}
