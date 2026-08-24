import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { OrderStatus } from "@/lib/order-status";
import {
  computeShalomSignature,
  decidirAccionEnvio,
  esEventoConocido,
  handlePingChallenge,
  HEADER_EVENT_ID,
  HEADER_FIRMA,
  parseShalomEvent,
  parseSignatureHeader,
  procesarWebhookShalom,
  RegistroEventosEnMemoria,
  VENTANA_DEFECTO_SEGUNDOS,
  verifyShalomSignature,
  type ShalomEvent,
} from "./shalom-webhook";

const SECRETO = "9f8b1c".padEnd(64, "a");
const AHORA = new Date("2026-07-30T15:04:05.000Z");

/** Firma un cuerpo como lo haría Shalom, para no duplicar la fórmula en cada test. */
function firmar(rawBody: string, ahora: Date = AHORA, secret = SECRETO): string {
  const t = String(Math.floor(ahora.getTime() / 1000));
  return `t=${t},v1=${computeShalomSignature(t, rawBody, secret)}`;
}

function eventoJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "evt_812_tracking.updated_destino",
    event: "tracking.updated",
    occurred_at: "2026-07-30T15:04:05Z",
    data: {
      numero: "80574902",
      ose_id: "84048736",
      status: "destino",
      previous_status: "transito",
      delivered: false,
      timeline: [
        { milestone: "registrado", fecha: "2026-07-28", hora: "09:12", completo: true },
        { milestone: "transito", fecha: "2026-07-29", hora: "14:30", completo: true },
        { milestone: "destino", fecha: "2026-07-30", hora: "10:05", completo: false },
      ],
    },
    ...overrides,
  });
}

function comoEvento(json: string): ShalomEvent {
  const parsed = parseShalomEvent(json);
  if (!parsed.ok) throw new Error(`el fixture no parsea: ${parsed.motivo}`);
  return parsed.evento;
}

describe("parseSignatureHeader", () => {
  it("parsea el formato documentado", () => {
    expect(parseSignatureHeader("t=1782140645,v1=abc123")).toEqual({
      t: "1782140645",
      v1: "abc123",
    });
  });

  it("tolera espacios y el orden invertido", () => {
    // El formato no está garantizado por contrato: es un wrapper de terceros.
    expect(parseSignatureHeader(" v1=ABC123 , t=1782140645 ")).toEqual({
      t: "1782140645",
      v1: "abc123",
    });
  });

  it("exige ambos campos", () => {
    // Sin `t` no hay anti-replay; sin `v1` no hay firma.
    expect(parseSignatureHeader("t=1782140645")).toBeNull();
    expect(parseSignatureHeader("v1=abc123")).toBeNull();
    expect(parseSignatureHeader("")).toBeNull();
    expect(parseSignatureHeader("basura")).toBeNull();
  });

  it("rechaza valores con formato inválido", () => {
    expect(parseSignatureHeader("t=ayer,v1=abc123")).toBeNull();
    expect(parseSignatureHeader("t=1782140645,v1=nohexadecimal!")).toBeNull();
  });
});

describe("verifyShalomSignature", () => {
  const cuerpo = eventoJson();

  it("acepta una firma válida", () => {
    const r = verifyShalomSignature({
      rawBody: cuerpo,
      signatureHeader: firmar(cuerpo),
      secret: SECRETO,
      ahora: AHORA,
    });
    expect(r.ok).toBe(true);
  });

  it("rechaza una firma calculada con otro secreto", () => {
    const r = verifyShalomSignature({
      rawBody: cuerpo,
      signatureHeader: firmar(cuerpo, AHORA, "secreto-del-atacante"),
      secret: SECRETO,
      ahora: AHORA,
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.razon).toBe("firma_invalida");
  });

  it("rechaza si el cuerpo cambió aunque sea un byte", () => {
    const header = firmar(cuerpo);
    const alterado = cuerpo.replace("80574902", "80574903");
    const r = verifyShalomSignature({
      rawBody: alterado,
      signatureHeader: header,
      secret: SECRETO,
      ahora: AHORA,
    });
    expect(r.ok).toBe(false);
  });

  it("devuelve false sin lanzar cuando la firma tiene otra longitud", () => {
    // `timingSafeEqual` lanza si los buffers difieren en longitud, y una firma
    // truncada es justo lo que enviaría alguien probando el endpoint.
    const t = String(Math.floor(AHORA.getTime() / 1000));
    for (const v1 of ["ab", "abc123", "f".repeat(63), "f".repeat(65), "f".repeat(200)]) {
      const r = verifyShalomSignature({
        rawBody: cuerpo,
        signatureHeader: `t=${t},v1=${v1}`,
        secret: SECRETO,
        ahora: AHORA,
      });
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.razon).toBe("firma_invalida");
    }
  });

  it("rechaza un timestamp viejo: anti-replay", () => {
    const viejo = new Date(AHORA.getTime() - (VENTANA_DEFECTO_SEGUNDOS + 60) * 1000);
    const r = verifyShalomSignature({
      rawBody: cuerpo,
      signatureHeader: firmar(cuerpo, viejo),
      secret: SECRETO,
      ahora: AHORA,
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.razon).toBe("fuera_de_ventana");
  });

  it("rechaza un timestamp del futuro", () => {
    // Un `t` adelantado dejaría la firma válida durante horas y anularía el
    // anti-replay.
    const futuro = new Date(AHORA.getTime() + (VENTANA_DEFECTO_SEGUNDOS + 60) * 1000);
    const r = verifyShalomSignature({
      rawBody: cuerpo,
      signatureHeader: firmar(cuerpo, futuro),
      secret: SECRETO,
      ahora: AHORA,
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.razon).toBe("fuera_de_ventana");
  });

  it("acepta dentro de la ventana en ambos sentidos", () => {
    for (const delta of [-VENTANA_DEFECTO_SEGUNDOS + 5, -30, 0, 30, VENTANA_DEFECTO_SEGUNDOS - 5]) {
      const t = new Date(AHORA.getTime() + delta * 1000);
      const r = verifyShalomSignature({
        rawBody: cuerpo,
        signatureHeader: firmar(cuerpo, t),
        secret: SECRETO,
        ahora: AHORA,
      });
      expect(r.ok, `delta ${delta}s`).toBe(true);
    }
  });

  it("distingue la falta de configuración de un ataque", () => {
    // Sin secreto el problema es del operador, no de quien llama.
    const r = verifyShalomSignature({
      rawBody: cuerpo,
      signatureHeader: firmar(cuerpo),
      secret: "   ",
      ahora: AHORA,
    });
    expect(r.ok === false && r.razon).toBe("sin_secreto");
    expect(r.ok === false && r.motivo).toMatch(/SHALOM_WEBHOOK_SECRET/);
  });

  it("distingue header ausente de header malformado", () => {
    const sin = verifyShalomSignature({
      rawBody: cuerpo,
      signatureHeader: null,
      secret: SECRETO,
      ahora: AHORA,
    });
    expect(sin.ok === false && sin.razon).toBe("header_ausente");

    const malo = verifyShalomSignature({
      rawBody: cuerpo,
      signatureHeader: "esto-no-es-una-firma",
      secret: SECRETO,
      ahora: AHORA,
    });
    expect(malo.ok === false && malo.razon).toBe("header_malformado");
  });

  it("el cuerpo re-serializado NO valida: hay que usar el crudo", () => {
    // Este es el bug número uno de las integraciones de webhooks. Si la ruta de
    // Next hace `await request.json()` y luego re-serializa para verificar, el
    // resultado casi nunca coincide byte a byte con lo que se firmó.
    //
    // El caso que se reproduce aquí es el espaciado: el emisor manda JSON con
    // saltos de línea e indentación (lo hace cualquier servidor que serialice con
    // `JSON.stringify(obj, null, 2)`), y `JSON.stringify` lo devuelve compacto.
    // El orden de claves también puede cambiar, pero no es la única vía: basta un
    // espacio de diferencia para que el HMAC sea otro.
    const crudo = `{\n  "id": "evt_1",\n  "event": "tracking.updated",\n  "data": {\n    "numero": "805",\n    "timeline": []\n  }\n}`;
    const header = firmar(crudo);

    // Verificar sobre el crudo funciona.
    expect(
      verifyShalomSignature({
        rawBody: crudo,
        signatureHeader: header,
        secret: SECRETO,
        ahora: AHORA,
      }).ok,
    ).toBe(true);

    // Re-serializar produce otros bytes y la firma deja de cuadrar.
    const reserializado = JSON.stringify(JSON.parse(crudo));
    expect(reserializado).not.toBe(crudo);
    const r = verifyShalomSignature({
      rawBody: reserializado,
      signatureHeader: header,
      secret: SECRETO,
      ahora: AHORA,
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.motivo).toMatch(/re-serializó/);
  });

  it("tampoco valida si se reordenan las claves", () => {
    // La otra forma de romperlo: reconstruir el objeto con las claves en otro
    // orden, algo que ocurre al pasar el payload por un mapeo intermedio.
    const crudo = '{"event":"tracking.updated","id":"evt_1","data":{"numero":"805","timeline":[]}}';
    const header = firmar(crudo);
    const original = JSON.parse(crudo) as Record<string, unknown>;
    const reordenado = JSON.stringify({
      id: original.id,
      event: original.event,
      data: original.data,
    });
    expect(reordenado).not.toBe(crudo);
    expect(
      verifyShalomSignature({
        rawBody: reordenado,
        signatureHeader: header,
        secret: SECRETO,
        ahora: AHORA,
      }).ok,
    ).toBe(false);
  });

  it("un cuerpo con no-ASCII sobrevive a la firma", () => {
    // El escapado de tildes y eñes cambia entre serializadores; firmar bytes UTF-8
    // del cuerpo crudo lo hace irrelevante.
    const conTildes = JSON.stringify({
      id: "evt_1",
      event: "tracking.updated",
      data: { numero: "805", timeline: [], descripcion: "Recibido en agencia Ñuñoa — Perú" },
    });
    expect(
      verifyShalomSignature({
        rawBody: conTildes,
        signatureHeader: firmar(conTildes),
        secret: SECRETO,
        ahora: AHORA,
      }).ok,
    ).toBe(true);
  });
});

describe("computeShalomSignature", () => {
  it("implementa exactamente HMAC_SHA256(t + '.' + cuerpo, secreto)", () => {
    // Se recalcula a mano para verificar la fórmula documentada, no la
    // implementación consigo misma.
    const t = "1782140645";
    const cuerpo = '{"a":1}';
    const esperado = createHmac("sha256", Buffer.from(SECRETO, "utf8"))
      .update(Buffer.from(`${t}.${cuerpo}`, "utf8"))
      .digest("hex");
    expect(computeShalomSignature(t, cuerpo, SECRETO)).toBe(esperado);
  });

  it("es determinista y de 64 caracteres hex", () => {
    const a = computeShalomSignature("1", "x", SECRETO);
    expect(a).toBe(computeShalomSignature("1", "x", SECRETO));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("parseShalomEvent", () => {
  it("parsea el payload documentado", () => {
    const r = parseShalomEvent(eventoJson());
    expect(r.ok).toBe(true);
    expect(r.ok && r.evento.event).toBe("tracking.updated");
    expect(r.ok && r.evento.data.timeline).toHaveLength(3);
  });

  it("rechaza un cuerpo que no es JSON", () => {
    const r = parseShalomEvent("<html>502 Bad Gateway</html>");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.motivo).toMatch(/no es JSON/);
  });

  it("exige el id, que es la clave de deduplicación", () => {
    const r = parseShalomEvent(JSON.stringify({ event: "tracking.updated", data: {} }));
    expect(r.ok).toBe(false);
  });

  it("acepta campos extra que el wrapper añada sin avisar", () => {
    // Rechazar por un campo nuevo convertiría una mejora suya en una caída nuestra.
    const r = parseShalomEvent(
      JSON.stringify({
        id: "evt_1",
        event: "tracking.updated",
        campo_nuevo: "algo",
        data: { numero: "805", timeline: [], otro_campo_nuevo: 42 },
      }),
    );
    expect(r.ok).toBe(true);
  });
});

describe("esEventoConocido", () => {
  it("reconoce los cuatro eventos documentados", () => {
    for (const e of ["webhook.ping", "tracking.updated", "tracking.delivered", "tracking.expired"]) {
      expect(esEventoConocido(e), e).toBe(true);
    }
  });

  it("no reconoce un evento inventado", () => {
    expect(esEventoConocido("tracking.returned")).toBe(false);
  });
});

describe("handlePingChallenge", () => {
  it("devuelve el challenge que hay que responder en el body", () => {
    const evento = comoEvento(
      JSON.stringify({
        id: "evt_ping_1",
        event: "webhook.ping",
        data: { challenge: "abc-123-challenge" },
      }),
    );
    expect(handlePingChallenge(evento)).toEqual({ esPing: true, challenge: "abc-123-challenge" });
  });

  it("no confunde un evento de tracking con un ping", () => {
    expect(handlePingChallenge(comoEvento(eventoJson()))).toEqual({ esPing: false });
  });

  it("cae al id del evento si el ping llega sin challenge", () => {
    // Responder vacío garantizaría el fallo del registro; devolver el id al menos
    // prueba que se leyó el cuerpo.
    const evento = comoEvento(
      JSON.stringify({ id: "evt_ping_2", event: "webhook.ping", data: {} }),
    );
    expect(handlePingChallenge(evento)).toEqual({ esPing: true, challenge: "evt_ping_2" });
  });
});

/** Timeline con el paquete recibido en la agencia de origen. */
const TIMELINE_EN_AGENCIA = [
  { milestone: "registrado", fecha: "2026-07-28", hora: "09:12" },
  { milestone: "origen", fecha: "2026-07-28", hora: "09:30" },
];

function eventoEntregado(): ShalomEvent {
  return comoEvento(
    JSON.stringify({
      id: "evt_delivered_1",
      event: "tracking.delivered",
      data: {
        numero: "80574902",
        delivered: true,
        timeline: [
          ...TIMELINE_EN_AGENCIA,
          { milestone: "entregado", fecha: "2026-07-30", hora: "11:40" },
        ],
      },
    }),
  );
}

describe("decidirAccionEnvio: entrega", () => {
  it("marca entregado pasando por los estados intermedios legales", () => {
    // La máquina de estados no permite saltar de `preparando` a `entregado`: hay
    // que pasar por `enviado`. Devolver un estado inalcanzable reventaría la
    // transición en la base con el paquete ya entregado.
    const d = decidirAccionEnvio(eventoEntregado(), "preparando");
    expect(d.accion).toBe("marcar_entregado");
    expect(d.transiciones).toEqual(["enviado", "entregado"]);
    expect(d.nuevoEstado).toBe("entregado");
  });

  it("desde enviado solo falta la entrega", () => {
    const d = decidirAccionEnvio(eventoEntregado(), "enviado");
    expect(d.transiciones).toEqual(["entregado"]);
  });

  it("IDEMPOTENCIA: un segundo aviso de entrega no vuelve a entregar", () => {
    // El wrapper entrega at-least-once. Volver a "entregar" dispararía otra vez
    // los efectos de lado (WhatsApp de valoración, cierre de garantía).
    const d = decidirAccionEnvio(eventoEntregado(), "entregado");
    expect(d.accion).toBe("ignorar");
    expect(d.transiciones).toEqual([]);
    expect(d.nuevoEstado).toBeNull();
    expect(d.requiereAtencionHumana).toBe(false);
  });

  it("aplicar la decisión dos veces converge al mismo estado", () => {
    // Simula el ciclo real: primera notificación aplica, segunda no hace nada.
    let estado: OrderStatus = "preparando";
    const primera = decidirAccionEnvio(eventoEntregado(), estado);
    estado = primera.nuevoEstado ?? estado;
    const segunda = decidirAccionEnvio(eventoEntregado(), estado);
    expect(estado).toBe("entregado");
    expect(segunda.accion).toBe("ignorar");
    expect(segunda.nuevoEstado).toBeNull();
  });

  it("pide revisión si Shalom entrega un pedido cancelado o expirado", () => {
    // Implica mercadería fuera de control: guía reutilizada o cancelación tardía.
    for (const estado of ["cancelado", "expirado"] as const) {
      const d = decidirAccionEnvio(eventoEntregado(), estado);
      expect(d.accion, estado).toBe("revisar");
      expect(d.requiereAtencionHumana).toBe(true);
      expect(d.transiciones).toEqual([]);
    }
  });

  it("pide revisión si no hay camino legal hasta enviado", () => {
    // Un pedido con el pago rechazado no debería tener paquete en la calle.
    const d = decidirAccionEnvio(eventoEntregado(), "comprobante_enviado");
    expect(d.accion).toBe("revisar");
    expect(d.requiereAtencionHumana).toBe(true);
  });

  it("trata un updated con delivered:true como entrega", () => {
    // Ocurre cuando el evento `delivered` se perdió: si no, el pedido quedaría
    // colgado en "enviado" para siempre.
    const evento = comoEvento(
      JSON.stringify({
        id: "evt_upd_delivered",
        event: "tracking.updated",
        data: {
          numero: "805",
          delivered: true,
          timeline: [
            ...TIMELINE_EN_AGENCIA,
            { milestone: "entregado", fecha: "2026-07-30", hora: "11:40" },
          ],
        },
      }),
    );
    expect(decidirAccionEnvio(evento, "enviado").accion).toBe("marcar_entregado");
  });

  it("conserva la línea de tiempo incluso cuando ignora el evento", () => {
    // Los hitos se guardan siempre: enriquecen el seguimiento sin cambiar estado.
    const d = decidirAccionEnvio(eventoEntregado(), "entregado");
    expect(d.tracking.entregado).toBe(true);
    expect(d.tracking.eventos.length).toBeGreaterThan(0);
  });
});

function eventoActualizado(timeline: readonly Record<string, unknown>[]): ShalomEvent {
  return comoEvento(
    JSON.stringify({
      id: "evt_upd_1",
      event: "tracking.updated",
      data: { numero: "80574902", delivered: false, timeline },
    }),
  );
}

describe("decidirAccionEnvio: avance de hitos", () => {
  it("solo registrado NO marca enviado: el paquete puede seguir en la tienda", () => {
    // `registrado` significa que la guía existe, no que el paquete se despachó.
    // Marcar "enviado" aquí le mentiría al cliente.
    const d = decidirAccionEnvio(
      eventoActualizado([{ milestone: "registrado", fecha: "2026-07-28", hora: "09:12" }]),
      "preparando",
    );
    expect(d.accion).toBe("actualizar_hitos");
    expect(d.transiciones).toEqual([]);
  });

  it("recibido en agencia de origen sí marca enviado", () => {
    // `origen` es el primer hito que prueba que el paquete está en manos de Shalom.
    const d = decidirAccionEnvio(eventoActualizado(TIMELINE_EN_AGENCIA), "preparando");
    expect(d.accion).toBe("marcar_enviado");
    expect(d.transiciones).toEqual(["enviado"]);
  });

  it("pasa por preparando cuando el pedido venía de verificado", () => {
    const d = decidirAccionEnvio(eventoActualizado(TIMELINE_EN_AGENCIA), "verificado");
    expect(d.transiciones).toEqual(["preparando", "enviado"]);
  });

  it("un avance con el pedido ya enviado solo actualiza hitos", () => {
    const d = decidirAccionEnvio(
      eventoActualizado([
        ...TIMELINE_EN_AGENCIA,
        { milestone: "transito", fecha: "2026-07-29", hora: "14:30" },
      ]),
      "enviado",
    );
    expect(d.accion).toBe("actualizar_hitos");
    expect(d.transiciones).toEqual([]);
  });

  it("un avance posterior a la entrega no toca el pedido pero guarda los hitos", () => {
    // Shalom cierra hitos administrativos al final del día.
    const d = decidirAccionEnvio(
      eventoActualizado([
        ...TIMELINE_EN_AGENCIA,
        { milestone: "destino", fecha: "2026-07-30", hora: "23:59" },
      ]),
      "entregado",
    );
    expect(d.accion).toBe("actualizar_hitos");
    expect(d.transiciones).toEqual([]);
    expect(d.requiereAtencionHumana).toBe(false);
  });

  it("pide revisión si hay movimiento de un pedido cancelado o expirado", () => {
    for (const estado of ["cancelado", "expirado"] as const) {
      const d = decidirAccionEnvio(eventoActualizado(TIMELINE_EN_AGENCIA), estado);
      expect(d.accion, estado).toBe("revisar");
      expect(d.requiereAtencionHumana).toBe(true);
    }
  });

  it("pide revisión si hay movimiento con el pago sin verificar", () => {
    const d = decidirAccionEnvio(eventoActualizado(TIMELINE_EN_AGENCIA), "comprobante_enviado");
    expect(d.accion).toBe("revisar");
    expect(d.requiereAtencionHumana).toBe(true);
  });

  it("es idempotente: repetir el mismo avance no vuelve a transicionar", () => {
    const evento = eventoActualizado(TIMELINE_EN_AGENCIA);
    let estado: OrderStatus = "preparando";
    estado = decidirAccionEnvio(evento, estado).nuevoEstado ?? estado;
    expect(estado).toBe("enviado");
    const segunda = decidirAccionEnvio(evento, estado);
    expect(segunda.accion).toBe("actualizar_hitos");
    expect(segunda.transiciones).toEqual([]);
  });
});

describe("decidirAccionEnvio: expiración y eventos desconocidos", () => {
  function eventoExpirado(): ShalomEvent {
    return comoEvento(
      JSON.stringify({
        id: "evt_exp_1",
        event: "tracking.expired",
        data: { numero: "805", timeline: TIMELINE_EN_AGENCIA },
      }),
    );
  }

  it("un rastreo expirado sin entrega pide revisión", () => {
    // 21 días sin entregarse: en provincia suele ser un paquete no recogido que
    // Shalom devuelve. Cobrar la devolución o reenviar es decisión comercial.
    const d = decidirAccionEnvio(eventoExpirado(), "enviado");
    expect(d.accion).toBe("revisar");
    expect(d.requiereAtencionHumana).toBe(true);
    expect(d.motivo).toMatch(/no recogido|expir/i);
  });

  it("un rastreo expirado tras la entrega se ignora", () => {
    const d = decidirAccionEnvio(eventoExpirado(), "entregado");
    expect(d.accion).toBe("ignorar");
    expect(d.requiereAtencionHumana).toBe(false);
  });

  it("un evento nuevo del wrapper no se trata como entrega ni se descarta", () => {
    // Tratarlo como entrega cerraría un pedido sin pruebas; descartarlo en
    // silencio perdería información.
    const evento = comoEvento(
      JSON.stringify({
        id: "evt_x",
        event: "tracking.returned",
        data: { numero: "805", timeline: [] },
      }),
    );
    const d = decidirAccionEnvio(evento, "enviado");
    expect(d.accion).toBe("revisar");
    expect(d.requiereAtencionHumana).toBe(true);
    expect(d.motivo).toContain("tracking.returned");
  });

  it("el ping no habla de ningún pedido", () => {
    const evento = comoEvento(
      JSON.stringify({ id: "evt_ping", event: "webhook.ping", data: { challenge: "c" } }),
    );
    const d = decidirAccionEnvio(evento, "preparando");
    expect(d.accion).toBe("ignorar");
    expect(d.transiciones).toEqual([]);
  });
});

describe("procesarWebhookShalom", () => {
  it("rechaza con 401 una firma inválida y NO llega a parsear", () => {
    // Verificar antes de parsear evita que un JSON malicioso llegue al esquema.
    return procesarWebhookShalom({
      rawBody: "{ esto no es json valido",
      headers: { [HEADER_FIRMA]: "t=1782140645,v1=" + "f".repeat(64) },
      secret: SECRETO,
      ahora: new Date(1782140645 * 1000),
      estadoActualPedido: "enviado",
    }).then((r) => {
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.httpStatus).toBe(401);
    });
  });

  it("devuelve 400 cuando el header está malformado", async () => {
    const r = await procesarWebhookShalom({
      rawBody: eventoJson(),
      headers: { [HEADER_FIRMA]: "basura" },
      secret: SECRETO,
      ahora: AHORA,
      estadoActualPedido: "enviado",
    });
    expect(r.ok === false && r.httpStatus).toBe(400);
  });

  it("responde el challenge del ping sin tocar el pedido", async () => {
    const cuerpo = JSON.stringify({
      id: "evt_ping_3",
      event: "webhook.ping",
      data: { challenge: "reto-abc" },
    });
    const r = await procesarWebhookShalom({
      rawBody: cuerpo,
      headers: { [HEADER_FIRMA]: firmar(cuerpo) },
      secret: SECRETO,
      ahora: AHORA,
      estadoActualPedido: "preparando",
    });
    expect(r.ok && r.tipo).toBe("ping");
    expect(r.ok && r.tipo === "ping" && r.challenge).toBe("reto-abc");
  });

  it("procesa un evento legítimo y lo marca como visto", async () => {
    const cuerpo = eventoJson();
    const registro = new RegistroEventosEnMemoria();
    const r = await procesarWebhookShalom({
      rawBody: cuerpo,
      headers: { [HEADER_FIRMA]: firmar(cuerpo), [HEADER_EVENT_ID]: "evt_812" },
      secret: SECRETO,
      ahora: AHORA,
      estadoActualPedido: "preparando",
      registro,
    });
    expect(r.ok && r.tipo).toBe("evento");
    expect(r.ok && r.tipo === "evento" && r.duplicado).toBe(false);
    expect(await registro.yaProcesado("evt_812")).toBe(true);
  });

  it("DEDUPLICA por X-Shalom-Event-Id: el reintento no vuelve a actuar", async () => {
    // Un reintento reusa el mismo id. Sin dedup, `tracking.delivered` dispararía
    // dos veces los efectos de lado.
    const cuerpo = eventoJson();
    const headers = { [HEADER_FIRMA]: firmar(cuerpo), [HEADER_EVENT_ID]: "evt_812" };
    const registro = new RegistroEventosEnMemoria();
    const entrada = {
      rawBody: cuerpo,
      headers,
      secret: SECRETO,
      ahora: AHORA,
      estadoActualPedido: "preparando" as OrderStatus,
      registro,
    };

    const primera = await procesarWebhookShalom(entrada);
    expect(primera.ok && primera.tipo === "evento" && primera.decision.accion).toBe(
      "marcar_enviado",
    );

    const segunda = await procesarWebhookShalom(entrada);
    expect(segunda.ok && segunda.tipo === "evento" && segunda.duplicado).toBe(true);
    expect(segunda.ok && segunda.tipo === "evento" && segunda.decision.accion).toBe("ignorar");
    expect(segunda.ok && segunda.tipo === "evento" && segunda.decision.transiciones).toEqual([]);
  });

  it("usa el id del cuerpo cuando falta el header", async () => {
    const cuerpo = eventoJson();
    const registro = new RegistroEventosEnMemoria();
    const r = await procesarWebhookShalom({
      rawBody: cuerpo,
      headers: { [HEADER_FIRMA]: firmar(cuerpo) },
      secret: SECRETO,
      ahora: AHORA,
      estadoActualPedido: "preparando",
      registro,
    });
    expect(r.ok && r.tipo === "evento" && r.eventId).toBe(
      "evt_812_tracking.updated_destino",
    );
  });

  it("un payload no autenticado no puede envenenar el registro de dedup", async () => {
    // Deduplicar después de verificar evita que alguien sin la clave bloquee
    // eventos legítimos marcando ids como procesados.
    const cuerpo = eventoJson();
    const registro = new RegistroEventosEnMemoria();
    await procesarWebhookShalom({
      rawBody: cuerpo,
      headers: { [HEADER_FIRMA]: `t=${Math.floor(AHORA.getTime() / 1000)},v1=${"f".repeat(64)}` },
      secret: SECRETO,
      ahora: AHORA,
      estadoActualPedido: "preparando",
      registro,
    });
    expect(await registro.yaProcesado("evt_812_tracking.updated_destino")).toBe(false);
  });

  it("funciona sin registro, aunque entonces no deduplica", async () => {
    const cuerpo = eventoJson();
    const r = await procesarWebhookShalom({
      rawBody: cuerpo,
      headers: { [HEADER_FIRMA]: firmar(cuerpo) },
      secret: SECRETO,
      ahora: AHORA,
      estadoActualPedido: "preparando",
    });
    expect(r.ok && r.tipo === "evento" && r.duplicado).toBe(false);
  });
});
