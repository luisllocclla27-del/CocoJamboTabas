/**
 * Tallas de zapatillas: conversión US / EU / CM.
 *
 * Aviso importante sobre la exactitud de esta tabla: **no existe una conversión
 * universal**. Cada marca usa su propio escalado, y Converse y Vans en concreto
 * difieren entre sí y entre modelos. Esta tabla es una aproximación de uso común
 * para calzado unisex de estilo urbano, pensada como **valor por defecto al
 * cargar productos**, no como verdad absoluta.
 *
 * Por eso la equivalencia real se guarda por variante en la base de datos
 * (`variants.size_us`, `size_eu`, `size_cm`): el comerciante puede corregir
 * cualquier fila según lo que diga la caja del par que tiene en la mano, y la
 * ficha de producto muestra ese dato, no este.
 *
 * El CM (longitud del pie en centímetros) es el dato menos ambiguo de los tres
 * y el que conviene destacar al cliente para que se mida el pie.
 */

export type SizeSystem = "US" | "EU" | "CM";

export type SizeRow = {
  us: number;
  eu: number;
  cm: number;
};

/** Tabla de referencia por defecto, US 5 a 13. */
export const TABLA_TALLAS: readonly SizeRow[] = [
  { us: 5, eu: 37.5, cm: 23 },
  { us: 5.5, eu: 38, cm: 23.5 },
  { us: 6, eu: 38.5, cm: 24 },
  { us: 6.5, eu: 39, cm: 24.5 },
  { us: 7, eu: 40, cm: 25 },
  { us: 7.5, eu: 40.5, cm: 25.5 },
  { us: 8, eu: 41, cm: 26 },
  { us: 8.5, eu: 42, cm: 26.5 },
  { us: 9, eu: 42.5, cm: 27 },
  { us: 9.5, eu: 43, cm: 27.5 },
  { us: 10, eu: 44, cm: 28 },
  { us: 10.5, eu: 44.5, cm: 28.5 },
  { us: 11, eu: 45, cm: 29 },
  { us: 11.5, eu: 45.5, cm: 29.5 },
  { us: 12, eu: 46, cm: 30 },
  { us: 12.5, eu: 47, cm: 30.5 },
  { us: 13, eu: 47.5, cm: 31 },
];

export function fromUS(us: number): SizeRow | null {
  return TABLA_TALLAS.find((t) => t.us === us) ?? null;
}

export function fromEU(eu: number): SizeRow | null {
  return TABLA_TALLAS.find((t) => t.eu === eu) ?? null;
}

/**
 * Busca por centímetros con tolerancia: el cliente se mide el pie y obtiene
 * 26.3 cm, un valor que no está en la tabla. Devolvemos la talla inmediatamente
 * superior, nunca la inferior — un par que aprieta se devuelve, uno holgado se
 * usa con medias más gruesas.
 */
export function fromCM(cm: number): SizeRow | null {
  return TABLA_TALLAS.find((t) => t.cm >= cm) ?? null;
}

/** "US 9 · EU 42.5 · 27 cm" */
export function formatSizeTriple(row: Pick<SizeRow, "us" | "eu" | "cm">): string {
  return `US ${formatNumber(row.us)} · EU ${formatNumber(row.eu)} · ${formatNumber(row.cm)} cm`;
}

export function formatSize(value: number, system: SizeSystem): string {
  const n = formatNumber(value);
  return system === "CM" ? `${n} cm` : `${system} ${n}`;
}

/** 9 -> "9", 9.5 -> "9.5" (sin ceros de más). */
function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
