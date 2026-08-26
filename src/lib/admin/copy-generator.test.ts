import { describe, expect, it } from "vitest";
import { generarEnlaceHistoriaIG, generarTextoWhatsApp } from "./copy-generator";

describe("generarTextoWhatsApp", () => {
  it("genera el texto formateado para WhatsApp con tallas disponibles y link", () => {
    const texto = generarTextoWhatsApp({
      marca: "Converse",
      modelo: "Chuck 70 High",
      colorway: "Black / Egret",
      priceCents: 28900,
      compareAtPriceCents: 32000,
      tallas: [
        { sizeUs: 8, stock: 2 },
        { sizeUs: 8.5, stock: 1 },
        { sizeUs: 9, stock: 0 },
        { sizeUs: 10, stock: 3 },
      ],
      slug: "converse-chuck-70-high-black-egret",
      baseUrl: "https://cocojambo.pe",
    });

    expect(texto).toContain("🔥 *CONVERSE CHUCK 70 HIGH*");
    expect(texto).toContain("Color: *Black / Egret*");
    expect(texto).toContain("👟 *Tallas disponibles:* US 8 · 8.5 · 10");
    expect(texto).toContain("S/ 289.00");
    expect(texto).toContain("~S/ 320.00~");
    expect(texto).toContain("https://cocojambo.pe/producto/converse-chuck-70-high-black-egret");
  });

  it("maneja productos sin tallas disponibles indicando agotado", () => {
    const texto = generarTextoWhatsApp({
      marca: "Vans",
      modelo: "Old Skool",
      colorway: "Black / White",
      priceCents: 24900,
      tallas: [{ sizeUs: 9, stock: 0 }],
      slug: "vans-old-skool-black-white",
      baseUrl: "https://cocojambo.pe",
    });

    expect(texto).toContain("Agotado temporalmente");
  });
});

describe("generarEnlaceHistoriaIG", () => {
  it("genera el enlace con parámetros de UTM para tracking de Instagram", () => {
    const enlace = generarEnlaceHistoriaIG("vans-old-skool", "https://cocojambo.pe");
    expect(enlace).toBe(
      "https://cocojambo.pe/producto/vans-old-skool?utm_source=instagram&utm_medium=stories",
    );
  });
});
