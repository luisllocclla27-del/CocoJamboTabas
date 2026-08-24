/**
 * Notificaciones (webhooks) de Tupay.
 *
 * Dos requisitos que la propia documentación de Tupay exige y que aquí son
 * invariantes del diseño:
 *
 * 1. Verificar la firma de la notificación entrante. Un endpoint de webhook es
 *    una URL pública que mueve dinero: sin firma, cualquiera que la descubra
 *    puede marcar pedidos como pagados.
 * 2. **Una notificación puede llegar varias veces para el mismo `deposit_id`.**
 *    Por tanto la decisión de qué hacer no puede depender sólo del estado
 *    notificado: tiene que combinarlo con el estado actual del pedido y ser
 *    idempotente. Ese es el trabajo de `decidirAccion`, que es una función pura
 *    precisamente para poder probar la tabla completa de combinaciones.
 *
 * Y una regla sobre el cuerpo: la firma se verifica contra el **body crudo**, el
 * string exacto que llegó por la red. Si se hiciera `JSON.parse` y luego
 * `JSON.stringify` para verificar, el orden de claves, el escapado de Unicode o
 * la notación de los números podrían cambiar y toda notificación legítima se
 * rechazaría. En Next.js eso implica leer `await request.text()` en la ruta y
 * pasar ese string aquí, nunca `await request.json()`.
 */

import { z } from "zod";
import type { OrderStatus } from "@/lib/order-status";
import { isWithinDateWindow, verifyTupaySignature, VENTANA_DEFECTO_SEGUNDOS } from "./signature";
import { normalizarEstadoTupay } from "./tupay-provider";
import { solesToCents } from "./tupay-client";
import type { PaymentProviderStatus } from "./types";
import type { Cents } from "@/lib/money";

/**
 * Esquema de la notificación.
 *
 * `passthrough` por la misma razón que en las respuestas: los proveedores añaden
 * campos. Estricto en `deposit_id` porque es la clave de idempotencia; sin él la
 * notificación es inservible y debe rechazarse en el borde.
 */
const notificationSchema = z
  .object({
    deposit_id: z.string().min(1),
    status: z.string().optional(),
    /** Nuestro `invoice_id` (la referencia `COCO-XXXXXX`). */
    merchant_invoice_id: z.string().optional(),
    invoice_id: z.string().optional(),
    /** En SOLES decimales, como en el resto de la API. */
    amount: z.number().optional(),
    currency: z.string().optional(),
    payment_method: z.string().optional(),
    description: z.string().optional().nullable(),
    updated_at: z.string().optional().nullable(),
    created_at: z.string().optional().nullable(),
  })
  .passthrough();

export type TupayNotification = z.infer<typeof notificationSchema>;

export type ParseResult =
  | { readonly ok: true; readonly notificacion: TupayNotification }
  | { readonly ok: false; readonly motivo: string };

export function parseTupayNotification(raw: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, motivo: "cuerpo de la notificación no es JSON válido" };
  }
  const parsed = notificationSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      motivo: `notificación con forma inesperada: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    };
  }
  return { ok: true, notificacion: parsed.data };
}

export type VerifyAndParseInput = {
  /** El body TAL CUAL llegó. Ver la nota de la cabecera. */
  readonly rawBody: string;
  /** Cabecera `Authorization`, con o sin el prefijo `TUPAY `. */
  readonly signatureHeader: string | null | undefined;
  readonly xDate: string | null | undefined;
  readonly xLogin: string;
  readonly secret: string;
  readonly ahora: Date;
  readonly ventanaSegundos?: number;
};

export type VerifyAndParseResult =
  | { readonly ok: true; readonly notificacion: TupayNotification }
  | {
      readonly ok: false;
      /**
       * `firma` y `ventana` deben responderse con 401 y NO reintentarse;
       * `formato` con 400. Ninguno debe tocar el pedido.
       */
      readonly razon: "cabecera_ausente" | "firma" | "ventana" | "formato";
      readonly motivo: string;
    };

/**
 * Verifica firma y ventana temporal ANTES de parsear.
 *
 * El orden importa: parsear primero significaría ejecutar el validador de
 * esquema (y cualquier lógica posterior) sobre datos de un origen no
 * autenticado. Con la firma delante, un cuerpo no firmado se descarta sin que
 * nada más lo mire.
 */
export function verifyAndParse(input: VerifyAndParseInput): VerifyAndParseResult {
  const { rawBody, signatureHeader, xDate, xLogin, secret, ahora } = input;
  if (
    signatureHeader === null ||
    signatureHeader === undefined ||
    signatureHeader.trim() === "" ||
    xDate === null ||
    xDate === undefined ||
    xDate.trim() === ""
  ) {
    return {
      ok: false,
      razon: "cabecera_ausente",
      motivo: "faltan las cabeceras Authorization o X-Date",
    };
  }
  const ventana = input.ventanaSegundos ?? VENTANA_DEFECTO_SEGUNDOS;
  if (!isWithinDateWindow(xDate, ahora, ventana)) {
    // Se comprueba antes de la firma porque es barato y descarta los reenvíos de
    // una notificación capturada, cuya firma SÍ es válida.
    return {
      ok: false,
      razon: "ventana",
      motivo: `X-Date fuera de la ventana de ${ventana}s (posible replay)`,
    };
  }
  const firmaValida = verifyTupaySignature({
    signatureHeader,
    xDate,
    xLogin,
    payload: rawBody,
    secret,
  });
  if (!firmaValida) {
    return { ok: false, razon: "firma", motivo: "firma HMAC inválida" };
  }
  const parsed = parseTupayNotification(rawBody);
  if (!parsed.ok) return { ok: false, razon: "formato", motivo: parsed.motivo };
  return { ok: true, notificacion: parsed.notificacion };
}

/** Acción a ejecutar sobre el pedido. */
export type WebhookAccion = "aprobar_pago" | "rechazar_pago" | "ignorar" | "revisar";

export type WebhookOutcome = {
  readonly accion: WebhookAccion;
  /**
   * Camino de transiciones a aplicar EN ORDEN, o vacío si no hay que tocar el
   * pedido.
   *
   * Es un camino y no un solo estado porque la máquina de estados de
   * `@/lib/order-status` fue diseñada para el Yape manual y no permite
   * `pendiente_pago → verificado` directamente: exige pasar por
   * `comprobante_enviado`. Para un cobro por pasarela, la propia notificación
   * firmada ES el comprobante, así que se recorren los dos pasos. Devolver un
   * estado inalcanzable haría que la transición reventara en la base con el pago
   * ya cobrado, que es el peor momento posible para fallar.
   */
  readonly transiciones: readonly OrderStatus[];
  /** Estado final tras aplicar el camino, o `null` si el pedido no se toca. */
  readonly nuevoEstado: OrderStatus | null;
  /** Explicación para el log de auditoría y el panel de administración. */
  readonly motivo: string;
  /**
   * `true` cuando la situación exige que un humano mire antes de que el cliente
   * se lleve (o pierda) la mercadería. El endpoint debe seguir devolviendo 200:
   * un 500 haría que Tupay reintentara indefinidamente sin arreglar nada.
   */
  readonly requiereAtencionHumana: boolean;
};

/** Construye un outcome coherente: `nuevoEstado` es siempre el último paso. */
function outcome(
  accion: WebhookAccion,
  transiciones: readonly OrderStatus[],
  motivo: string,
  requiereAtencionHumana = false,
): WebhookOutcome {
  return {
    accion,
    transiciones,
    nuevoEstado: transiciones.length === 0 ? null : transiciones[transiciones.length - 1],
    motivo,
    requiereAtencionHumana,
  };
}

/**
 * Decide qué hacer combinando el estado notificado con el estado actual del
 * pedido. Pura y total: hay una rama para cada par.
 *
 * La propiedad clave es la idempotencia. Si el pedido ya está `verificado` y
 * llega otra notificación de aprobado (Tupay las repite), la acción es
 * `ignorar`, no "aprobar otra vez": aprobar dos veces dispararía dos veces los
 * efectos de lado (descontar stock, enviar el WhatsApp de confirmación, emitir
 * comprobante). El `deposit_id` es la clave con la que el llamador debe además
 * registrar la notificación ya procesada.
 */
export function decidirAccion(
  estadoTupay: PaymentProviderStatus,
  estadoActualPedido: OrderStatus,
): WebhookOutcome {
  switch (estadoTupay) {
    case "aprobado":
      return decidirAprobado(estadoActualPedido);
    case "rechazado":
      return decidirRechazado(estadoActualPedido);
    case "expirado":
      return decidirExpirado(estadoActualPedido);
    case "reembolsado":
      // Un reembolso puede llegar días después, con el pedido en cualquier
      // estado (incluso ya enviado). No se automatiza nada: implica decidir si se
      // recupera mercadería, y eso no lo resuelve un webhook.
      return outcome(
        "revisar",
        [],
        `reembolso o contracargo notificado sobre un pedido en estado ${estadoActualPedido}`,
        true,
      );
    case "pendiente":
      // Tupay notifica el paso intermedio (QR generado, cliente en el checkout).
      // No hay nada que hacer: el pedido ya está esperando.
      return outcome("ignorar", [], "notificación de estado intermedio: el cobro sigue en curso");
    case "desconocido":
      // Un estado que no sabemos interpretar no puede tratarse como aprobado (se
      // regalaría mercadería) ni como rechazado (se cancelaría un pago bueno).
      return outcome(
        "revisar",
        [],
        "estado notificado no reconocido: revisar manualmente en el panel de Tupay",
        true,
      );
  }
}

/**
 * Camino legal hasta `verificado`.
 *
 * Desde `pendiente_pago` hay que pasar por `comprobante_enviado` porque la
 * máquina de estados se diseñó para el flujo manual y no admite el salto
 * directo. Para un cobro por pasarela la notificación firmada ES el
 * comprobante, así que el paso intermedio es correcto también conceptualmente:
 * queda registrado que hubo una prueba de pago antes de la verificación.
 */
function decidirAprobado(estado: OrderStatus): WebhookOutcome {
  switch (estado) {
    case "pendiente_pago":
      return outcome(
        "aprobar_pago",
        ["comprobante_enviado", "verificado"],
        "pago confirmado por la pasarela",
      );
    case "comprobante_enviado":
      // El cliente subió un screenshot y además la pasarela confirma: la pasarela
      // es la fuente más fiable, se verifica sin esperar al admin.
      return outcome("aprobar_pago", ["verificado"], "pago confirmado por la pasarela");
    case "verificado":
    case "preparando":
    case "enviado":
    case "entregado":
      // ESTA es la rama que hace idempotente el webhook. Tupay repite la
      // notificación; el pedido ya avanzó. No se toca nada.
      return outcome(
        "ignorar",
        [],
        `notificación de aprobado duplicada: el pedido ya está en ${estado}`,
      );
    case "rechazado":
      // Alguien rechazó el pago a mano y la pasarela dice que sí se cobró.
      // Contradicción entre dos fuentes: decide un humano.
      return outcome(
        "revisar",
        [],
        "la pasarela confirma un pago que ya había sido rechazado manualmente",
        true,
      );
    case "cancelado":
    case "expirado":
      // Se cobró un pedido que ya no existe: hay que devolver el dinero o
      // reactivar el pedido si aún hay stock. Nunca automático.
      return outcome(
        "revisar",
        [],
        `cobro confirmado sobre un pedido ${estado}: requiere reembolso o reactivación`,
        true,
      );
  }
}

function decidirRechazado(estado: OrderStatus): WebhookOutcome {
  switch (estado) {
    case "pendiente_pago":
      // Mismo motivo que en el aprobado: `rechazado` sólo se alcanza desde
      // `comprobante_enviado`. Se prefiere `rechazado` a `expirado` (que sí sería
      // alcanzable directamente) porque `expirado` es terminal y `rechazado`
      // permite volver a `pendiente_pago` para que el cliente reintente con otro
      // medio: cerrar la venta por un rechazo de tarjeta sería perder el pedido.
      return outcome(
        "rechazar_pago",
        ["comprobante_enviado", "rechazado"],
        "la pasarela rechazó el pago",
      );
    case "comprobante_enviado":
      return outcome("rechazar_pago", ["rechazado"], "la pasarela rechazó el pago");
    case "rechazado":
      return outcome(
        "ignorar",
        [],
        "notificación de rechazo duplicada: el pedido ya está rechazado",
      );
    case "verificado":
    case "preparando":
    case "enviado":
    case "entregado":
      // El pedido ya se liberó y ahora llega un rechazo: o es una notificación
      // desordenada de un intento anterior, o es un contracargo. No se revierte
      // automáticamente un pedido en curso.
      return outcome(
        "revisar",
        [],
        `rechazo notificado sobre un pedido ya en ${estado}: posible contracargo o notificación desordenada`,
        true,
      );
    case "cancelado":
    case "expirado":
      return outcome("ignorar", [], `rechazo notificado sobre un pedido ${estado}: nada que hacer`);
  }
}

function decidirExpirado(estado: OrderStatus): WebhookOutcome {
  switch (estado) {
    case "pendiente_pago":
      // Aquí sí se usa `expirado`, que es alcanzable directamente: el cliente
      // nunca llegó a pagar y la reserva de stock debe liberarse. Es el mismo
      // final al que llegaría el trabajo de expiración de reservas, sólo que
      // antes.
      return outcome(
        "rechazar_pago",
        ["expirado"],
        "el cobro expiró sin completarse en la pasarela",
      );
    case "comprobante_enviado":
      // Desde aquí sólo se puede ir a `verificado` o `rechazado`; se elige
      // `rechazado`, que deja al cliente reintentar.
      return outcome(
        "rechazar_pago",
        ["rechazado"],
        "el cobro expiró sin completarse en la pasarela",
      );
    case "rechazado":
    case "cancelado":
    case "expirado":
      return outcome(
        "ignorar",
        [],
        `expiración notificada sobre un pedido ${estado}: nada que hacer`,
      );
    case "verificado":
    case "preparando":
    case "enviado":
    case "entregado":
      return outcome(
        "revisar",
        [],
        `expiración notificada sobre un pedido ya en ${estado}: notificación desordenada`,
        true,
      );
  }
}

export type ProcesarNotificacionInput = VerifyAndParseInput & {
  /** Estado actual del pedido, leído por el llamador a partir del `invoice_id`. */
  readonly estadoActualPedido: OrderStatus;
  /** Total que esperábamos cobrar, en céntimos. */
  readonly montoEsperadoCents: Cents;
  /**
   * `true` si este `deposit_id` ya se procesó (el llamador lo consulta en su
   * tabla de notificaciones). Es la segunda capa de idempotencia, la que cubre
   * el caso de dos notificaciones simultáneas.
   */
  readonly yaProcesado?: boolean;
};

export type ProcesarNotificacionResult =
  | {
      readonly ok: true;
      readonly notificacion: TupayNotification;
      readonly outcome: WebhookOutcome;
    }
  | {
      readonly ok: false;
      readonly razon: "cabecera_ausente" | "firma" | "ventana" | "formato";
      readonly motivo: string;
    };

/**
 * Pipeline completo: verificar → parsear → comparar monto → decidir.
 *
 * Se expone además de las piezas suelas porque el orden de los pasos es en sí
 * mismo la garantía de seguridad, y dejar que cada ruta lo reconstruya invita a
 * que una se olvide de un paso.
 */
export function procesarNotificacion(
  input: ProcesarNotificacionInput,
): ProcesarNotificacionResult {
  const verificado = verifyAndParse(input);
  if (!verificado.ok) return verificado;

  const notificacion = verificado.notificacion;

  if (input.yaProcesado === true) {
    return {
      ok: true,
      notificacion,
      outcome: outcome(
        "ignorar",
        [],
        "deposit_id ya procesado previamente: notificación repetida",
      ),
    };
  }

  const estadoTupay = normalizarEstadoTupay(notificacion.status);

  // El monto se compara SOLO cuando la notificación aprueba: un descalce en un
  // rechazo no cambia la decisión, pero aprobar un importe distinto al esperado
  // sería entregar mercadería por menos dinero.
  if (estadoTupay === "aprobado" && notificacion.amount !== undefined) {
    const cobradoCents = solesToCents(notificacion.amount);
    if (cobradoCents !== input.montoEsperadoCents) {
      return {
        ok: true,
        notificacion,
        outcome: outcome(
          "revisar",
          [],
          `monto cobrado (${cobradoCents} céntimos) distinto del esperado (${input.montoEsperadoCents} céntimos)`,
          true,
        ),
      };
    }
  }

  return {
    ok: true,
    notificacion,
    outcome: decidirAccion(estadoTupay, input.estadoActualPedido),
  };
}

/** Referencia del pedido a la que apunta la notificación, si viene. */
export function referenciaDe(notificacion: TupayNotification): string | null {
  return notificacion.merchant_invoice_id ?? notificacion.invoice_id ?? null;
}
