import { describe, expect, it } from "vitest";
import { skuPropuesto, slugDisponible, slugify, slugProducto } from "./slug";

describe("slugify", () => {
  it("normaliza un nombre de producto con tildes", () => {
    expect(slugify("Zapatilla clásica edición limitada")).toBe(
      "zapatilla-clasica-edicion-limitada",
    );
  });

  it("resuelve la enie sin comerse la letra", () => {
    // Sin el reemplazo explícito, "Niño" daría "nio".
    expect(slugify("Niño Talla Pequeña")).toBe("nino-talla-pequena");
  });

  it("colapsa separadores repetidos y recorta los de los extremos", () => {
    expect(slugify("  Chuck   70 // Blanco  ")).toBe("chuck-70-blanco");
    expect(slugify("---Vans---")).toBe("vans");
  });

  it("elimina caracteres que en una URL significarían otra cosa", () => {
    // El punto y la barra dentro de un slug rompen el enrutado de la ficha.
    expect(slugify("Air 1.0 / Retro")).toBe("air-1-0-retro");
    expect(slugify("50% off?query=1")).toBe("50-off-query-1");
  });

  it("no deja el slug vacío con guiones sueltos", () => {
    expect(slugify("!!!")).toBe("");
    expect(slugify("")).toBe("");
  });

  it("acota la longitud sin dejar un guion final", () => {
    const largo = slugify("palabra ".repeat(40));
    expect(largo.length).toBeLessThanOrEqual(80);
    expect(largo.endsWith("-")).toBe(false);
  });
});

describe("slugProducto", () => {
  it("incluye marca, modelo y colorway", () => {
    // El mismo modelo en dos colores son dos fichas distintas: el colorway no
    // puede quedar fuera del slug.
    expect(
      slugProducto({ marca: "Converse", modelo: "Chuck 70", colorway: "Blanco" }),
    ).toBe("converse-chuck-70-blanco");
  });

  it("reproduce los slugs del catálogo de ejemplo", () => {
    // Si esta función hubiera generado otra cosa, las URLs del seed y las de un
    // producto dado de alta desde el panel no seguirían el mismo patrón.
    expect(
      slugProducto({
        marca: "Vans",
        modelo: "Old Skool",
        colorway: "Negro / Blanco",
      }),
    ).toBe("vans-old-skool-negro-blanco");

    expect(
      slugProducto({ marca: "New Balance", modelo: "550", colorway: "Blanco Verde" }),
    ).toBe("new-balance-550-blanco-verde");
  });
});

describe("slugDisponible", () => {
  it("devuelve el slug tal cual si está libre", () => {
    expect(slugDisponible("vans-authentic-negro", [])).toBe("vans-authentic-negro");
  });

  it("añade un sufijo correlativo y legible al colisionar", () => {
    // Un sufijo aleatorio parecería un error del sistema en la URL pública.
    expect(slugDisponible("vans-authentic-negro", ["vans-authentic-negro"])).toBe(
      "vans-authentic-negro-2",
    );
  });

  it("salta los sufijos ya tomados", () => {
    expect(
      slugDisponible("chuck-70", ["chuck-70", "chuck-70-2", "chuck-70-3"]),
    ).toBe("chuck-70-4");
  });

  it("nunca devuelve un slug ya ocupado", () => {
    // Es la garantía que importa: un duplicado rompe el índice único de products.
    const ocupados = ["x", ...Array.from({ length: 50 }, (_, i) => `x-${i + 2}`)];
    const propuesto = slugDisponible("x", ocupados);
    expect(ocupados).not.toContain(propuesto);
  });
});

describe("skuPropuesto", () => {
  it("escribe la talla en tres dígitos sin punto", () => {
    // El ancho constante es lo que hace que las etiquetas se ordenen solas.
    expect(
      skuPropuesto({
        marca: "Converse",
        modelo: "Chuck Taylor",
        colorway: "Negro",
        sizeUs: 9.5,
      }),
    ).toBe("CON-CHUCKT-NEG-095");
  });

  it("rellena con ceros las tallas de un dígito", () => {
    const sku = skuPropuesto({
      marca: "Vans",
      modelo: "Authentic",
      colorway: "Negro",
      sizeUs: 6,
    });
    expect(sku.endsWith("-060")).toBe(true);
  });

  it("no deja caracteres que rompan una etiqueta impresa", () => {
    const sku = skuPropuesto({
      marca: "New Balance",
      modelo: "550 / V2",
      colorway: "Blanco Verde",
      sizeUs: 11,
    });
    expect(sku).toMatch(/^[A-Z0-9-]+$/);
  });

  it("dos tallas del mismo producto dan SKUs distintos", () => {
    const base = { marca: "Adidas", modelo: "Samba OG", colorway: "Negro" };
    expect(skuPropuesto({ ...base, sizeUs: 9 })).not.toBe(
      skuPropuesto({ ...base, sizeUs: 9.5 }),
    );
  });
});
