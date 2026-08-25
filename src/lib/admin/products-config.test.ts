/**
 * Tests del esquema de alta de productos.
 *
 * Se prueba la validación y no la escritura porque es donde están las decisiones
 * que cuestan dinero: un precio mal parseado vende a otro precio, un precio tachado
 * menor que el real es publicidad engañosa, y un costo mayor que el precio significa
 * vender con pérdida sin darse cuenta.
 */

import { describe, expect, it } from "vitest";
import { altaProductoSchema, TALLAS_DISPONIBLES } from "./products-config";

function entradaValida(overrides: Record<string, unknown> = {}) {
  return {
    brandSlug: "converse",
    modelo: "Chuck 70 High",
    colorway: "Negro",
    condicion: "nuevo_en_caja",
    priceCents: "249.90",
    costCents: "149.90",
    destacado: false,
    variantes: [{ sizeUs: 9, stock: 2 }],
    ...overrides,
  };
}

describe("altaProductoSchema", () => {
  it("acepta una entrada mínima válida", () => {
    const parsed = altaProductoSchema.safeParse(entradaValida());
    expect(parsed.success).toBe(true);
  });

  it("convierte los soles a céntimos sin perder el último céntimo", () => {
    // 249.9 * 100 da 24989.999999999996 en coma flotante: truncar daría 24989.
    const parsed = altaProductoSchema.parse(entradaValida({ priceCents: "249.90" }));
    expect(parsed.priceCents).toBe(24990);
  });

  it("acepta coma decimal, que es como se escribe en Perú", () => {
    const parsed = altaProductoSchema.parse(entradaValida({ priceCents: "249,90" }));
    expect(parsed.priceCents).toBe(24990);
  });

  it("rechaza un precio con más de dos decimales", () => {
    expect(altaProductoSchema.safeParse(entradaValida({ priceCents: "249.905" })).success).toBe(
      false,
    );
  });

  it("rechaza un precio que no es número", () => {
    expect(altaProductoSchema.safeParse(entradaValida({ priceCents: "barato" })).success).toBe(
      false,
    );
  });

  it("rechaza vender por debajo del costo", () => {
    const parsed = altaProductoSchema.safeParse(
      entradaValida({ priceCents: "100.00", costCents: "150.00" }),
    );
    expect(parsed.success).toBe(false);
  });

  it("acepta vender al costo exacto: es una liquidación, no un error", () => {
    const parsed = altaProductoSchema.safeParse(
      entradaValida({ priceCents: "150.00", costCents: "150.00" }),
    );
    expect(parsed.success).toBe(true);
  });

  it("rechaza un precio tachado menor o igual al de venta", () => {
    expect(
      altaProductoSchema.safeParse(entradaValida({ compareAtPriceCents: "200.00" })).success,
    ).toBe(false);
    expect(
      altaProductoSchema.safeParse(entradaValida({ compareAtPriceCents: "249.90" })).success,
    ).toBe(false);
  });

  it("acepta un precio tachado mayor", () => {
    const parsed = altaProductoSchema.parse(entradaValida({ compareAtPriceCents: "299.90" }));
    expect(parsed.compareAtPriceCents).toBe(29990);
  });

  it("exige al menos una talla", () => {
    expect(altaProductoSchema.safeParse(entradaValida({ variantes: [] })).success).toBe(false);
  });

  it("rechaza tallas repetidas", () => {
    const parsed = altaProductoSchema.safeParse(
      entradaValida({
        variantes: [
          { sizeUs: 9, stock: 1 },
          { sizeUs: 9, stock: 3 },
        ],
      }),
    );
    expect(parsed.success).toBe(false);
  });

  it("rechaza una talla que no está en la tabla de referencia", () => {
    expect(
      altaProductoSchema.safeParse(entradaValida({ variantes: [{ sizeUs: 42, stock: 1 }] })).success,
    ).toBe(false);
  });

  it("acepta stock 0: sirve para recoger lista de espera", () => {
    const parsed = altaProductoSchema.safeParse(
      entradaValida({ variantes: [{ sizeUs: 9, stock: 0 }] }),
    );
    expect(parsed.success).toBe(true);
  });

  it("acepta todas las tallas de la tabla a la vez", () => {
    const parsed = altaProductoSchema.safeParse(
      entradaValida({
        variantes: TALLAS_DISPONIBLES.map((sizeUs) => ({ sizeUs, stock: 1 })),
      }),
    );
    expect(parsed.success).toBe(true);
  });

  it("rechaza un modelo demasiado corto", () => {
    expect(altaProductoSchema.safeParse(entradaValida({ modelo: "A" })).success).toBe(false);
  });

  it("rechaza una condición fuera del enum", () => {
    expect(altaProductoSchema.safeParse(entradaValida({ condicion: "usado" })).success).toBe(
      false,
    );
  });

  it("recorta los espacios del modelo y del color", () => {
    const parsed = altaProductoSchema.parse(
      entradaValida({ modelo: "  Old Skool  ", colorway: "  Negro  " }),
    );
    expect(parsed.modelo).toBe("Old Skool");
    expect(parsed.colorway).toBe("Negro");
  });
});
