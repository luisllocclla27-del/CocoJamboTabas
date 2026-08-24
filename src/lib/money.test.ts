import { describe, expect, it } from "vitest";
import {
  assertCents,
  formatSoles,
  isValidCents,
  margin,
  percentOf,
  solesToCents,
  splitSoles,
} from "./money";

describe("formatSoles", () => {
  it("formatea los céntimos identificadores sin perderlos", () => {
    expect(formatSoles(24937)).toBe("S/ 249.37");
  });

  it("rellena el céntimo suelto con cero", () => {
    expect(formatSoles(24907)).toBe("S/ 249.07");
    expect(formatSoles(24900)).toBe("S/ 249.00");
  });

  it("agrupa los miles", () => {
    expect(formatSoles(123456789)).toBe("S/ 1,234,567.89");
  });

  it("maneja cero y negativos", () => {
    expect(formatSoles(0)).toBe("S/ 0.00");
    expect(formatSoles(-2500)).toBe("-S/ 25.00");
  });
});

describe("splitSoles", () => {
  it("separa los céntimos para poder resaltarlos en la pantalla de pago", () => {
    expect(splitSoles(24937)).toEqual({ soles: "249", centimos: "37" });
    expect(splitSoles(24907)).toEqual({ soles: "249", centimos: "07" });
  });
});

describe("validación de céntimos", () => {
  it("rechaza cualquier cosa que no sea entero no negativo", () => {
    expect(isValidCents(24937)).toBe(true);
    expect(isValidCents(0)).toBe(true);
    expect(isValidCents(249.37)).toBe(false);
    expect(isValidCents(-1)).toBe(false);
    expect(isValidCents("24937")).toBe(false);
    expect(isValidCents(NaN)).toBe(false);
    expect(isValidCents(null)).toBe(false);
  });

  it("assertCents nombra el campo en el error", () => {
    expect(() => assertCents(1.5, "total")).toThrow(/total inválido/);
    expect(assertCents(500)).toBe(500);
  });
});

describe("solesToCents", () => {
  it("convierte sin arrastrar error de coma flotante", () => {
    expect(solesToCents(249.37)).toBe(24937);
    expect(solesToCents(0.1)).toBe(10);
    expect(solesToCents(1.005)).toBe(101);
  });
});

describe("percentOf", () => {
  it("calcula el descuento por Yape directo redondeando al céntimo", () => {
    expect(percentOf(24900, 3)).toBe(747);
    expect(percentOf(19900, 3)).toBe(597);
  });

  it("nunca devuelve fracciones de céntimo", () => {
    for (let base = 10000; base < 10100; base++) {
      expect(Number.isInteger(percentOf(base, 3))).toBe(true);
    }
  });
});

describe("margin", () => {
  it("calcula la ganancia real del par", () => {
    const { gananciaCents, porcentaje } = margin(24900, 14900);
    expect(gananciaCents).toBe(10000);
    expect(porcentaje).toBeCloseTo(40.16, 2);
  });

  it("no divide por cero con precio cero", () => {
    expect(margin(0, 0).porcentaje).toBe(0);
  });

  it("expone la pérdida cuando se vende por debajo del costo", () => {
    expect(margin(14900, 15900).gananciaCents).toBe(-1000);
  });
});
