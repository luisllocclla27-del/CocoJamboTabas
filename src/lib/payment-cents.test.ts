import { describe, expect, it } from "vitest";
import {
  applyPaymentCents,
  findOrdersByAmount,
  matchesExpectedAmount,
  NoPaymentCentsAvailableError,
  pickPaymentCents,
} from "./payment-cents";

describe("applyPaymentCents", () => {
  it("sustituye los céntimos del importe en vez de sumarlos", () => {
    // S/ 249.00 con identificador 37 -> S/ 249.37, no S/ 249.37 + 0.37
    expect(applyPaymentCents(24900, 37).totalCents).toBe(24937);
  });

  it("nunca cobra menos que el importe real", () => {
    // S/ 249.80 con identificador 37: 249.37 sería regalar 43 céntimos.
    const { totalCents } = applyPaymentCents(24980, 37);
    expect(totalCents).toBe(25037);
    expect(totalCents).toBeGreaterThanOrEqual(24980);
  });

  it("mantiene el importe cuando los céntimos ya coinciden", () => {
    expect(applyPaymentCents(24937, 37).totalCents).toBe(24937);
  });

  it("sube al sol siguiente cuando el importe supera los céntimos asignados", () => {
    const { totalCents } = applyPaymentCents(24999, 1);
    expect(totalCents).toBe(25001);
  });

  it("el total nunca es menor al base, para cualquier combinación", () => {
    for (let base = 19900; base <= 20100; base++) {
      for (let c = 1; c <= 99; c++) {
        expect(applyPaymentCents(base, c).totalCents).toBeGreaterThanOrEqual(base);
      }
    }
  });

  it("el total nunca excede al base en más de un sol", () => {
    for (let base = 19900; base <= 20100; base++) {
      for (let c = 1; c <= 99; c++) {
        expect(applyPaymentCents(base, c).totalCents - base).toBeLessThan(100);
      }
    }
  });

  it("rechaza céntimos fuera de rango", () => {
    expect(() => applyPaymentCents(24900, 0)).toThrow(/fuera de rango/);
    expect(() => applyPaymentCents(24900, 100)).toThrow(/fuera de rango/);
    expect(() => applyPaymentCents(24900, 1.5)).toThrow(/fuera de rango/);
    expect(() => applyPaymentCents(24900, -3)).toThrow(/fuera de rango/);
  });
});

describe("pickPaymentCents", () => {
  it("nunca devuelve 00, que sería indistinguible de un total redondo", () => {
    for (let i = 0; i < 200; i++) {
      expect(pickPaymentCents([])).toBeGreaterThanOrEqual(1);
    }
  });

  it("no devuelve un céntimo ya ocupado", () => {
    const ocupados = Array.from({ length: 98 }, (_, i) => i + 1); // 1..98 tomados
    for (let i = 0; i < 50; i++) {
      expect(pickPaymentCents(ocupados)).toBe(99);
    }
  });

  it("falla con un error tipado cuando se agota el espacio", () => {
    const todos = Array.from({ length: 99 }, (_, i) => i + 1);
    expect(() => pickPaymentCents(todos)).toThrow(NoPaymentCentsAvailableError);
  });

  it("reparte entre los libres en vez de tomar siempre el menor", () => {
    // Un contador secuencial delataría cuántos pedidos hay en cola.
    const vistos = new Set<number>();
    for (let i = 0; i < 300; i++) vistos.add(pickPaymentCents([]));
    expect(vistos.size).toBeGreaterThan(20);
  });
});

describe("matcheo de vouchers", () => {
  it("exige coincidencia exacta: una tolerancia rompería el mecanismo", () => {
    expect(matchesExpectedAmount(24937, 24937)).toBe(true);
    expect(matchesExpectedAmount(24937, 24936)).toBe(false);
    expect(matchesExpectedAmount(24937, 24900)).toBe(false);
  });

  it("identifica un solo pedido cuando los céntimos son únicos", () => {
    const pedidos = [
      { ref: "COCO-AAAAAA", totalCents: 24937 },
      { ref: "COCO-BBBBBB", totalCents: 24942 },
      { ref: "COCO-CCCCCC", totalCents: 19915 },
    ];
    const hallados = findOrdersByAmount(pedidos, 24942);
    expect(hallados).toHaveLength(1);
    expect(hallados[0].ref).toBe("COCO-BBBBBB");
  });

  it("devuelve varios candidatos si la unicidad falló, para forzar revisión humana", () => {
    const pedidos = [
      { ref: "COCO-AAAAAA", totalCents: 24937 },
      { ref: "COCO-BBBBBB", totalCents: 24937 },
    ];
    expect(findOrdersByAmount(pedidos, 24937)).toHaveLength(2);
  });

  it("no encuentra nada cuando el monto no corresponde a ningún pedido", () => {
    expect(findOrdersByAmount([{ totalCents: 24937 }], 30000)).toHaveLength(0);
  });
});
