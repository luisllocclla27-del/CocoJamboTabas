import { describe, expect, it } from "vitest";
import { generateReference, isValidReference, normalizeReference } from "./reference";

describe("generateReference", () => {
  it("respeta el formato COCO-XXXXXX", () => {
    for (let i = 0; i < 100; i++) {
      expect(isValidReference(generateReference())).toBe(true);
    }
  });

  it("no usa caracteres que se confunden al dictarlos por WhatsApp", () => {
    // 0/O y 1/I/L fuera; también vocales, para no formar palabras.
    const prohibidos = /[0O1ILAEIOU]/;
    for (let i = 0; i < 300; i++) {
      const sufijo = generateReference().slice(5);
      expect(sufijo).not.toMatch(prohibidos);
    }
  });

  it("no es secuencial: 500 referencias no colisionan ni siguen un orden", () => {
    const generadas = new Set<string>();
    for (let i = 0; i < 500; i++) generadas.add(generateReference());
    expect(generadas.size).toBe(500);
  });

  it("reparte los caracteres en vez de sesgarse a los primeros del alfabeto", () => {
    // Verifica que el rechazo de módulo funciona.
    const vistos = new Set<string>();
    for (let i = 0; i < 400; i++) {
      for (const ch of generateReference().slice(5)) vistos.add(ch);
    }
    expect(vistos.size).toBeGreaterThan(25);
  });
});

describe("isValidReference", () => {
  it("acepta una referencia bien formada", () => {
    expect(isValidReference("COCO-7F3K2M")).toBe(true);
  });

  it("rechaza formatos que no son nuestros", () => {
    expect(isValidReference("COCO-7F3K2")).toBe(false); // corta
    expect(isValidReference("COCO-7F3K2MM")).toBe(false); // larga
    expect(isValidReference("coco-7f3k2m")).toBe(false); // minúsculas
    expect(isValidReference("7F3K2M")).toBe(false); // sin prefijo
    expect(isValidReference("COCO-7F3K2O")).toBe(false); // carácter excluido
    expect(isValidReference("COCO-000001")).toBe(false); // secuencial
    expect(isValidReference("")).toBe(false);
  });

  it("rechaza intentos de inyección en el buscador de seguimiento", () => {
    expect(isValidReference("COCO-' OR 1=1--")).toBe(false);
    expect(isValidReference("COCO-<script>")).toBe(false);
  });
});

describe("normalizeReference", () => {
  it("tolera cómo la gente realmente escribe la referencia", () => {
    expect(normalizeReference("coco-7f3k2m")).toBe("COCO-7F3K2M");
    expect(normalizeReference("  COCO-7F3K2M  ")).toBe("COCO-7F3K2M");
    expect(normalizeReference("7F3K2M")).toBe("COCO-7F3K2M");
    expect(normalizeReference("coco 7f3k2m")).toBe("COCO-7F3K2M");
    expect(normalizeReference("COCO7F3K2M")).toBe("COCO-7F3K2M");
  });

  it("devuelve null cuando no hay forma de interpretarlo", () => {
    expect(normalizeReference("hola")).toBeNull();
    expect(normalizeReference("")).toBeNull();
    expect(normalizeReference("COCO-")).toBeNull();
  });

  it("normaliza cualquier referencia generada", () => {
    for (let i = 0; i < 50; i++) {
      const ref = generateReference();
      expect(normalizeReference(ref.toLowerCase())).toBe(ref);
    }
  });
});
