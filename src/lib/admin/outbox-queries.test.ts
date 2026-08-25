/**
 * Tests de la adaptación de avisos del outbox.
 *
 * Lo que se prueba acá es la decisión que gobierna la pantalla: qué aviso se puede
 * mandar y qué falta cuando no. Un fallo en esto no rompe nada visiblemente; solo
 * hace que un mensaje quede invisible y un cliente sin respuesta, que es
 * exactamente el modo de fallo que esta pantalla venía a cerrar.
 */

import { describe, expect, it } from "vitest";
import {
  adaptarAviso,
  destinoAviso,
  etiquetaAviso,
  faltanteDelPayload,
} from "./outbox-queries";

const AHORA = new Date("2026-04-16T12:00:00.000Z");

function fila(overrides: Partial<Parameters<typeof adaptarAviso>[0]> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    tipo: "whatsapp_pago_aprobado",
    payload: { reference: "COCO-7F3K2M", telefono: "987654321" } as Record<string, unknown>,
    status: "pendiente" as const,
    intentos: 0,
    ultimo_error: null,
    procesar_despues_de: "2026-04-16T11:00:00.000Z",
    created_at: "2026-04-16T10:00:00.000Z",
    ...overrides,
  };
}

describe("etiquetaAviso", () => {
  it("traduce los tipos conocidos", () => {
    expect(etiquetaAviso("whatsapp_pago_aprobado")).toBe("Pago aprobado");
    expect(etiquetaAviso("restock_aviso")).toBe("Volvió el stock");
  });

  it("un tipo desconocido se muestra tal cual, sin esconder la fila", () => {
    expect(etiquetaAviso("tipo_futuro")).toBe("tipo_futuro");
  });
});

describe("destinoAviso", () => {
  it("el aviso de comprobante nuevo va al comerciante, aunque lleve el teléfono del cliente", () => {
    expect(destinoAviso("whatsapp_comprobante_recibido")).toBe("comerciante");
  });

  it("el resto va al cliente", () => {
    expect(destinoAviso("whatsapp_pago_aprobado")).toBe("cliente");
    expect(destinoAviso("restock_aviso")).toBe("cliente");
  });
});

describe("faltanteDelPayload", () => {
  it("señala el teléfono cuando no hay uno normalizable", () => {
    expect(faltanteDelPayload("whatsapp_pago_aprobado", { reference: "COCO-7F3K2M" })).toBe(
      "el teléfono del cliente",
    );
  });

  it("señala la referencia cuando falta", () => {
    expect(faltanteDelPayload("whatsapp_pago_aprobado", { telefono: "987654321" })).toBe(
      "la referencia del pedido",
    );
  });

  it("el aviso de envío exige guía", () => {
    expect(
      faltanteDelPayload("whatsapp_pedido_enviado", {
        telefono: "987654321",
        reference: "COCO-7F3K2M",
      }),
    ).toBe("el número de guía");
  });

  it("el restock exige modelo y talla numérica", () => {
    expect(
      faltanteDelPayload("restock_aviso", {
        telefono: "987654321",
        reference: "COCO-7F3K2M",
        modelo: "Chuck 70",
      }),
    ).toBe("el modelo o la talla");
  });

  it("un tipo desconocido se explica por su tipo, no por sus datos", () => {
    expect(faltanteDelPayload("tipo_futuro", {})).toBe(
      "un tipo de evento que el sistema sepa redactar",
    );
  });

  it("no reporta nada cuando el payload está completo", () => {
    expect(
      faltanteDelPayload("whatsapp_pago_aprobado", {
        telefono: "987654321",
        reference: "COCO-7F3K2M",
      }),
    ).toBeNull();
  });
});

describe("adaptarAviso", () => {
  it("redacta el mensaje y deja el faltante en null", () => {
    const aviso = adaptarAviso(fila(), AHORA);
    expect(aviso.mensaje).not.toBeNull();
    expect(aviso.mensaje?.telefono).toBe("51987654321");
    expect(aviso.faltante).toBeNull();
    expect(aviso.reference).toBe("COCO-7F3K2M");
  });

  it("un payload incompleto deja el mensaje en null y explica qué falta", () => {
    const aviso = adaptarAviso(fila({ payload: { reference: "COCO-7F3K2M" } }), AHORA);
    expect(aviso.mensaje).toBeNull();
    expect(aviso.faltante).toBe("el teléfono del cliente");
  });

  it("un payload nulo no rompe la fila", () => {
    const aviso = adaptarAviso(fila({ payload: null }), AHORA);
    expect(aviso.mensaje).toBeNull();
    expect(aviso.faltante).not.toBeNull();
  });

  it("no anuncia espera si el momento programado ya pasó", () => {
    expect(adaptarAviso(fila(), AHORA).esperaHasta).toBeNull();
  });

  it("anuncia la espera solo mientras sigue en el futuro", () => {
    const aviso = adaptarAviso(
      fila({ procesar_despues_de: "2026-04-16T13:00:00.000Z" }),
      AHORA,
    );
    expect(aviso.esperaHasta).toBe("2026-04-16T13:00:00.000Z");
  });

  it("conserva el estado y el último error para poder decidir sobre la fila", () => {
    const aviso = adaptarAviso(
      fila({ status: "fallido", intentos: 6, ultimo_error: "timeout del proveedor" }),
      AHORA,
    );
    expect(aviso.status).toBe("fallido");
    expect(aviso.intentos).toBe(6);
    expect(aviso.ultimoError).toBe("timeout del proveedor");
  });
});
