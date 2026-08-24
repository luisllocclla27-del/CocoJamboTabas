import { describe, expect, it } from "vitest";
import {
  assertTransition,
  canTransition,
  ESTADOS_TERMINALES,
  InvalidTransitionError,
  isTerminal,
  LINEA_TIEMPO,
  ORDER_STATUSES,
  reservaStock,
  TRANSICIONES,
  type OrderStatus,
} from "./order-status";

describe("máquina de estados", () => {
  it("cubre todos los estados del enum", () => {
    for (const s of ORDER_STATUSES) {
      expect(TRANSICIONES[s]).toBeDefined();
    }
  });

  it("solo apunta a estados que existen", () => {
    for (const destinos of Object.values(TRANSICIONES)) {
      for (const d of destinos) {
        expect(ORDER_STATUSES).toContain(d);
      }
    }
  });

  it("ningún estado transiciona a sí mismo", () => {
    for (const s of ORDER_STATUSES) {
      expect(TRANSICIONES[s]).not.toContain(s);
    }
  });

  it("los terminales son exactamente entregado, cancelado y expirado", () => {
    expect([...ESTADOS_TERMINALES].sort()).toEqual(["cancelado", "entregado", "expirado"]);
  });

  it("un pedido entregado no puede volver atrás", () => {
    expect(isTerminal("entregado")).toBe(true);
    for (const s of ORDER_STATUSES) {
      expect(canTransition("entregado", s)).toBe(false);
    }
  });

  it("permite el camino feliz completo", () => {
    const camino: OrderStatus[] = [
      "pendiente_pago",
      "comprobante_enviado",
      "verificado",
      "preparando",
      "enviado",
      "entregado",
    ];
    for (let i = 0; i < camino.length - 1; i++) {
      expect(canTransition(camino[i], camino[i + 1])).toBe(true);
    }
  });

  it("permite contraentrega saltando la verificación de pago", () => {
    // El pedido por Shalom con cobranza no pasa por comprobante.
    expect(canTransition("pendiente_pago", "preparando")).toBe(true);
  });

  it("un pago rechazado puede reintentarse", () => {
    expect(canTransition("comprobante_enviado", "rechazado")).toBe(true);
    expect(canTransition("rechazado", "pendiente_pago")).toBe(true);
  });

  it("bloquea los atajos peligrosos", () => {
    // Enviar sin haber verificado el pago es la pérdida de plata más directa.
    expect(canTransition("comprobante_enviado", "enviado")).toBe(false);
    expect(canTransition("pendiente_pago", "enviado")).toBe(false);
    expect(canTransition("pendiente_pago", "entregado")).toBe(false);
    // No se puede desverificar un pago ya aprobado.
    expect(canTransition("verificado", "rechazado")).toBe(false);
    // Un pedido enviado no se cancela: ya salió del almacén.
    expect(canTransition("enviado", "cancelado")).toBe(false);
    // Un pedido expirado no revive; se crea uno nuevo.
    expect(canTransition("expirado", "pendiente_pago")).toBe(false);
  });

  it("assertTransition lanza un error tipado", () => {
    expect(() => assertTransition("entregado", "pendiente_pago")).toThrow(InvalidTransitionError);
    expect(() => assertTransition("pendiente_pago", "comprobante_enviado")).not.toThrow();
  });

  it("todo estado no terminal es alcanzable desde pendiente_pago", () => {
    const visitados = new Set<OrderStatus>(["pendiente_pago"]);
    const cola: OrderStatus[] = ["pendiente_pago"];
    while (cola.length > 0) {
      for (const destino of TRANSICIONES[cola.pop()!]) {
        if (!visitados.has(destino)) {
          visitados.add(destino);
          cola.push(destino);
        }
      }
    }
    expect([...visitados].sort()).toEqual([...ORDER_STATUSES].sort());
  });
});

describe("reservaStock", () => {
  it("mantiene el par apartado mientras el admin revisa el voucher", () => {
    // Si liberáramos aquí, se revendería la talla durante la verificación.
    expect(reservaStock("comprobante_enviado")).toBe(true);
  });

  it("mantiene la reserva en pendiente_pago y verificado", () => {
    expect(reservaStock("pendiente_pago")).toBe(true);
    expect(reservaStock("verificado")).toBe(true);
  });

  it("libera en los estados donde el pedido murió o el stock ya se descontó", () => {
    for (const s of ["rechazado", "cancelado", "expirado", "preparando", "enviado", "entregado"] as const) {
      expect(reservaStock(s)).toBe(false);
    }
  });
});

describe("línea de tiempo del cliente", () => {
  it("es una secuencia de transiciones realmente posibles", () => {
    for (let i = 0; i < LINEA_TIEMPO.length - 1; i++) {
      expect(canTransition(LINEA_TIEMPO[i], LINEA_TIEMPO[i + 1])).toBe(true);
    }
  });

  it("no muestra estados de fracaso al cliente en la línea de avance", () => {
    for (const s of ["rechazado", "cancelado", "expirado"] as const) {
      expect(LINEA_TIEMPO).not.toContain(s);
    }
  });
});
