import { describe, expect, it } from "vitest";
import { canTransition, ORDER_STATUSES, type OrderStatus } from "@/lib/order-status";
import { computeTupaySignature } from "./signature";
import {
  decidirAccion,
  parseTupayNotification,
  procesarNotificacion,
  referenciaDe,
  verifyAndParse,
} from "./webhook";
import type { PaymentProviderStatus } from "./types";

const SECRET = "signature-super-secreta-de-prueba";
const LOGIN = "api-key-de-prueba";
const AHORA = new Date("2026-08-19T10:30:00Z");
const X_DATE = "2026-08-19T10:30:00Z";

function cuerpo(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    deposit_id: "dep_123",
    status: "APPROVED",
    merchant_invoice_id: "COCO-7F3K2M",
    amount: 249.37,
    currency: "PEN",
    ...overrides,
  });
}

function firmar(rawBody: string): string {
  return computeTupaySignature({ xDate: X_DATE, xLogin: LOGIN, payload: rawBody, secret: SECRET });
}

function entrada(rawBody: string, overrides: Record<string, unknown> = {}) {
  return {
    rawBody,
    signatureHeader: `TUPAY ${firmar(rawBody)}`,
    xDate: X_DATE,
    xLogin: LOGIN,
    secret: SECRET,
    ahora: AHORA,
    ...overrides,
  };
}

describe("parseTupayNotification", () => {
  it("acepta una notificación con campos extra del proveedor", () => {
    const r = parseTupayNotification(cuerpo({ campo_futuro: { x: 1 } }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.notificacion.deposit_id).toBe("dep_123");
  });

  it("rechaza una notificación sin deposit_id: sin él no hay clave de idempotencia", () => {
    const r = parseTupayNotification(JSON.stringify({ status: "APPROVED" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toContain("deposit_id");
  });

  it("rechaza un cuerpo que no es JSON", () => {
    const r = parseTupayNotification("<html>502</html>");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toMatch(/no es JSON/);
  });
});

describe("verifyAndParse", () => {
  it("acepta una notificación firmada y dentro de la ventana", () => {
    const r = verifyAndParse(entrada(cuerpo()));
    expect(r.ok).toBe(true);
  });

  it("verifica contra el cuerpo CRUDO, no contra el JSON re-serializado", () => {
    // Un cuerpo con orden de claves y espaciado propios de Tupay: si verificáramos
    // sobre `JSON.stringify(JSON.parse(body))` la firma no cuadraría y
    // rechazaríamos notificaciones legítimas.
    const raw = '{\n  "status": "APPROVED",\n  "deposit_id": "dep_123",\n  "amount": 249.37\n}';
    expect(JSON.stringify(JSON.parse(raw))).not.toBe(raw);
    const r = verifyAndParse(entrada(raw));
    expect(r.ok).toBe(true);
  });

  it("un webhook con firma inválida NO llega a parsearse", () => {
    // La firma va delante del parseo: un cuerpo no autenticado no debe pasar por
    // el validador de esquema ni por nada posterior. Aquí el cuerpo es basura
    // sintáctica: si se hubiera parseado primero, el motivo sería 'formato'.
    const r = verifyAndParse(entrada("{ esto no es json", { signatureHeader: "TUPAY " + "a".repeat(64) }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.razon).toBe("firma");
      expect(r.razon).not.toBe("formato");
    }
  });

  it("rechaza una firma calculada sobre un cuerpo distinto (manipulación del monto)", () => {
    const original = cuerpo({ amount: 249.37 });
    const manipulado = cuerpo({ amount: 1 });
    const r = verifyAndParse({ ...entrada(original), rawBody: manipulado });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.razon).toBe("firma");
  });

  it("rechaza un X-Date viejo aunque la firma sea válida: es el replay de una notificación capturada", () => {
    const raw = cuerpo();
    const viejo = "2026-08-19T09:00:00Z";
    const r = verifyAndParse({
      ...entrada(raw),
      xDate: viejo,
      signatureHeader: `TUPAY ${computeTupaySignature({
        xDate: viejo,
        xLogin: LOGIN,
        payload: raw,
        secret: SECRET,
      })}`,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.razon).toBe("ventana");
  });

  it("rechaza un X-Date del futuro", () => {
    const raw = cuerpo();
    const futuro = "2026-08-19T12:00:00Z";
    const r = verifyAndParse({
      ...entrada(raw),
      xDate: futuro,
      signatureHeader: `TUPAY ${computeTupaySignature({
        xDate: futuro,
        xLogin: LOGIN,
        payload: raw,
        secret: SECRET,
      })}`,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.razon).toBe("ventana");
  });

  it("rechaza si faltan las cabeceras, sin lanzar", () => {
    for (const overrides of [
      { signatureHeader: null },
      { signatureHeader: "" },
      { xDate: null },
      { xDate: undefined },
    ]) {
      const r = verifyAndParse(entrada(cuerpo(), overrides));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.razon).toBe("cabecera_ausente");
    }
  });

  it("rechaza un cuerpo firmado pero con forma inválida", () => {
    const raw = JSON.stringify({ status: "APPROVED" });
    const r = verifyAndParse(entrada(raw));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.razon).toBe("formato");
  });
});

describe("decidirAccion: idempotencia", () => {
  it("aprueba el pago cuando el pedido está esperando", () => {
    const r = decidirAccion("aprobado", "pendiente_pago");
    expect(r.accion).toBe("aprobar_pago");
    expect(r.nuevoEstado).toBe("verificado");
    // Desde `pendiente_pago` la máquina de estados no admite el salto directo a
    // `verificado`: la notificación firmada hace de comprobante y se recorren los
    // dos pasos.
    expect(r.transiciones).toEqual(["comprobante_enviado", "verificado"]);
    expect(r.requiereAtencionHumana).toBe(false);
  });

  it("verifica en un solo paso si el cliente ya había subido comprobante", () => {
    const r = decidirAccion("aprobado", "comprobante_enviado");
    expect(r.accion).toBe("aprobar_pago");
    expect(r.transiciones).toEqual(["verificado"]);
  });

  it("IGNORA una segunda notificación de aprobado sobre un pedido ya verificado", () => {
    // Requisito explícito de la doc de Tupay: la notificación puede enviarse
    // varias veces y un depósito no debe liberarse más de una vez.
    const r = decidirAccion("aprobado", "verificado");
    expect(r.accion).toBe("ignorar");
    expect(r.nuevoEstado).toBeNull();
    expect(r.requiereAtencionHumana).toBe(false);
  });

  it("IGNORA el aprobado si el pedido ya avanzó más allá de verificado", () => {
    for (const estado of ["preparando", "enviado", "entregado"] as const) {
      const r = decidirAccion("aprobado", estado);
      expect(r.accion).toBe("ignorar");
      expect(r.nuevoEstado).toBeNull();
      expect(r.transiciones).toEqual([]);
    }
  });

  it("es idempotente ante N notificaciones repetidas: sólo la primera actúa", () => {
    // Simula el reenvío real: se aplica el camino al estado y se vuelve a decidir.
    let estado: OrderStatus = "pendiente_pago";
    const acciones: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = decidirAccion("aprobado", estado);
      acciones.push(r.accion);
      if (r.nuevoEstado !== null) estado = r.nuevoEstado;
    }
    expect(acciones).toEqual(["aprobar_pago", "ignorar", "ignorar", "ignorar", "ignorar"]);
    expect(estado).toBe("verificado");
  });

  it("también es idempotente con los rechazos repetidos", () => {
    let estado: OrderStatus = "pendiente_pago";
    const acciones: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = decidirAccion("rechazado", estado);
      acciones.push(r.accion);
      if (r.nuevoEstado !== null) estado = r.nuevoEstado;
    }
    expect(acciones).toEqual(["rechazar_pago", "ignorar", "ignorar"]);
  });
});

describe("decidirAccion: casos que exigen a un humano", () => {
  it("marca para revisión un aprobado sobre un pedido rechazado a mano", () => {
    const r = decidirAccion("aprobado", "rechazado");
    expect(r.accion).toBe("revisar");
    expect(r.requiereAtencionHumana).toBe(true);
  });

  it("marca para revisión un cobro sobre un pedido cancelado o expirado", () => {
    for (const estado of ["cancelado", "expirado"] as const) {
      const r = decidirAccion("aprobado", estado);
      expect(r.accion).toBe("revisar");
      expect(r.motivo).toMatch(/reembolso|reactivación/);
    }
  });

  it("no revierte automáticamente un pedido ya en curso ante un rechazo tardío", () => {
    for (const estado of ["verificado", "preparando", "enviado", "entregado"] as const) {
      const r = decidirAccion("rechazado", estado);
      expect(r.accion).toBe("revisar");
      expect(r.nuevoEstado).toBeNull();
    }
  });

  it("nunca automatiza un reembolso o contracargo", () => {
    for (const estado of ORDER_STATUSES) {
      const r = decidirAccion("reembolsado", estado);
      expect(r.accion).toBe("revisar");
      expect(r.requiereAtencionHumana).toBe(true);
    }
  });

  it("un estado no reconocido no se aprueba ni se rechaza", () => {
    for (const estado of ORDER_STATUSES) {
      const r = decidirAccion("desconocido", estado);
      expect(r.accion).toBe("revisar");
      expect(r.nuevoEstado).toBeNull();
    }
  });
});

describe("decidirAccion: estados intermedios y expiración", () => {
  it("ignora las notificaciones de estado pendiente", () => {
    for (const estado of ORDER_STATUSES) {
      expect(decidirAccion("pendiente", estado).accion).toBe("ignorar");
    }
  });

  it("una expiración sin pago libera la reserva pasando a expirado", () => {
    const r = decidirAccion("expirado", "pendiente_pago");
    expect(r.accion).toBe("rechazar_pago");
    expect(r.nuevoEstado).toBe("expirado");
  });

  it("si ya había comprobante, la expiración pasa a rechazado para dejar reintentar", () => {
    // `expirado` no es alcanzable desde `comprobante_enviado`, y `rechazado`
    // permite volver a `pendiente_pago`: no se cierra la venta sin necesidad.
    const r = decidirAccion("expirado", "comprobante_enviado");
    expect(r.accion).toBe("rechazar_pago");
    expect(r.nuevoEstado).toBe("rechazado");
  });

  it("ignora una expiración sobre un pedido ya cerrado", () => {
    for (const estado of ["rechazado", "cancelado", "expirado"] as const) {
      expect(decidirAccion("expirado", estado).accion).toBe("ignorar");
    }
  });
});

describe("decidirAccion: totalidad", () => {
  const ESTADOS_TUPAY: readonly PaymentProviderStatus[] = [
    "pendiente",
    "aprobado",
    "rechazado",
    "expirado",
    "reembolsado",
    "desconocido",
  ];

  it("devuelve una decisión para cada par de estados, sin lanzar", () => {
    for (const estadoTupay of ESTADOS_TUPAY) {
      for (const estadoPedido of ORDER_STATUSES) {
        const r = decidirAccion(estadoTupay, estadoPedido);
        expect(["aprobar_pago", "rechazar_pago", "ignorar", "revisar"]).toContain(r.accion);
        expect(r.motivo.length).toBeGreaterThan(0);
      }
    }
  });

  it("sólo propone caminos que la máquina de estados permite, paso a paso", () => {
    // Devolver un estado inalcanzable haría que la transición reventara en la base
    // con el pago ya cobrado. Se valida el camino completo, no sólo el destino.
    for (const estadoTupay of ESTADOS_TUPAY) {
      for (const estadoPedido of ORDER_STATUSES) {
        const r = decidirAccion(estadoTupay, estadoPedido);
        let desde = estadoPedido;
        for (const paso of r.transiciones) {
          expect(canTransition(desde, paso), `${desde} → ${paso}`).toBe(true);
          desde = paso;
        }
        expect(r.nuevoEstado).toBe(r.transiciones.length === 0 ? null : desde);
      }
    }
  });

  it("no propone ninguna transición cuando la acción es ignorar o revisar", () => {
    for (const estadoTupay of ESTADOS_TUPAY) {
      for (const estadoPedido of ORDER_STATUSES) {
        const r = decidirAccion(estadoTupay, estadoPedido);
        if (r.accion === "ignorar" || r.accion === "revisar") {
          expect(r.transiciones).toEqual([]);
          expect(r.nuevoEstado).toBeNull();
        } else {
          expect(r.transiciones.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("nunca aprueba un pago sobre un pedido en estado terminal", () => {
    for (const estado of ["entregado", "cancelado", "expirado"] as const) {
      expect(decidirAccion("aprobado", estado).accion).not.toBe("aprobar_pago");
    }
  });
});

describe("procesarNotificacion", () => {
  const base = {
    estadoActualPedido: "pendiente_pago" as OrderStatus,
    montoEsperadoCents: 24937,
  };

  it("aprueba cuando la firma, la ventana y el monto cuadran", () => {
    const r = procesarNotificacion({ ...entrada(cuerpo()), ...base });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.outcome.accion).toBe("aprobar_pago");
      expect(r.outcome.nuevoEstado).toBe("verificado");
      expect(r.outcome.transiciones).toEqual(["comprobante_enviado", "verificado"]);
    }
  });

  it("no toca el pedido si la firma es inválida", () => {
    const r = procesarNotificacion({
      ...entrada(cuerpo()),
      ...base,
      signatureHeader: "TUPAY " + "b".repeat(64),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.razon).toBe("firma");
  });

  it("ignora la notificación si el deposit_id ya se procesó", () => {
    // Segunda capa de idempotencia: cubre dos notificaciones simultáneas, donde el
    // estado del pedido aún no ha cambiado cuando llega la segunda.
    const r = procesarNotificacion({ ...entrada(cuerpo()), ...base, yaProcesado: true });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.outcome.accion).toBe("ignorar");
      expect(r.outcome.transiciones).toEqual([]);
      expect(r.outcome.motivo).toMatch(/ya procesado/);
    }
  });

  it("exige revisión si el monto cobrado no es el esperado", () => {
    // Aprobar a ciegas un importe menor sería entregar zapatillas por menos plata.
    const r = procesarNotificacion({ ...entrada(cuerpo({ amount: 100 })), ...base });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.outcome.accion).toBe("revisar");
      expect(r.outcome.requiereAtencionHumana).toBe(true);
      expect(r.outcome.motivo).toContain("10000");
    }
  });

  it("acepta el monto con céntimos identificadores sin error de redondeo", () => {
    const r = procesarNotificacion({
      ...entrada(cuerpo({ amount: 249.07 })),
      ...base,
      montoEsperadoCents: 24907,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.outcome.accion).toBe("aprobar_pago");
  });

  it("no compara el monto cuando la notificación es de rechazo", () => {
    const r = procesarNotificacion({
      ...entrada(cuerpo({ status: "REJECTED", amount: 1 })),
      ...base,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.outcome.accion).toBe("rechazar_pago");
  });

  it("traduce las grafías de estado que usa Tupay", () => {
    for (const status of ["APPROVED", "PAID", "COMPLETED", "approved"]) {
      const r = procesarNotificacion({ ...entrada(cuerpo({ status })), ...base });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.outcome.accion).toBe("aprobar_pago");
    }
  });

  it("pide revisión ante un status que no conocemos, en vez de adivinar", () => {
    const r = procesarNotificacion({ ...entrada(cuerpo({ status: "SOMETHING_NEW" })), ...base });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.outcome.accion).toBe("revisar");
  });
});

describe("referenciaDe", () => {
  it("prefiere merchant_invoice_id y cae a invoice_id", () => {
    const conMerchant = parseTupayNotification(cuerpo());
    expect(conMerchant.ok && referenciaDe(conMerchant.notificacion)).toBe("COCO-7F3K2M");

    const soloInvoice = parseTupayNotification(
      JSON.stringify({ deposit_id: "d", invoice_id: "COCO-AAAAAA" }),
    );
    expect(soloInvoice.ok && referenciaDe(soloInvoice.notificacion)).toBe("COCO-AAAAAA");

    const sinNada = parseTupayNotification(JSON.stringify({ deposit_id: "d" }));
    expect(sinNada.ok && referenciaDe(sinNada.notificacion)).toBeNull();
  });
});
