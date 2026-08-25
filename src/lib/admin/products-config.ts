/**
 * Esquemas y constantes del alta de productos.
 *
 * Vive aparte de `products.ts` porque un módulo con `"use server"` solo puede
 * exportar funciones asíncronas. Es la misma separación que `orders/config.ts`.
 */

import { z } from "zod";
import { TABLA_TALLAS } from "@/lib/sizes";

/** 8 MB, el mismo límite que declara el bucket `productos`. */
export const MAX_BYTES_FOTO = 8 * 1024 * 1024;

/**
 * Máximo de fotos por producto.
 *
 * Seis cubre lateral exterior, interior, suela, puntera, talón y caja. Más que eso
 * nadie las mira y cada una es peso que el cliente descarga en datos móviles.
 */
export const MAX_FOTOS = 6;

/** Tallas US que el formulario ofrece, tomadas de la tabla de referencia. */
export const TALLAS_DISPONIBLES: readonly number[] = TABLA_TALLAS.map((t) => t.us);

export const CONDICIONES = ["nuevo_en_caja", "nuevo_sin_caja"] as const;

export type Condicion = (typeof CONDICIONES)[number];

export const ETIQUETA_CONDICION: Readonly<Record<Condicion, string>> = {
  nuevo_en_caja: "Nuevo en caja",
  nuevo_sin_caja: "Nuevo sin caja",
};

/**
 * Precio en soles que escribe el comerciante, convertido a céntimos.
 *
 * Se acepta coma decimal porque en Perú se escribe `249,90` tanto como `249.90`, y
 * rechazar la coma sería perder el dato por un detalle de teclado.
 */
const solesSchema = z
  .string()
  .trim()
  .transform((valor) => valor.replace(",", "."))
  .refine((valor) => /^\d{1,5}(\.\d{1,2})?$/.test(valor), {
    message: "Escribe un precio en soles, por ejemplo 249.90",
  })
  // Se redondea sobre la representación decimal: `249.9 * 100` da
  // 24989.999999999996 en coma flotante, que truncado sería un céntimo menos.
  .transform((valor) => Math.round(Number(Number(valor).toFixed(2)) * 100));

const varianteSchema = z.object({
  sizeUs: z.number().refine((v) => TALLAS_DISPONIBLES.includes(v), {
    message: "Esa talla US no está en la tabla de referencia.",
  }),
  stock: z.number().int().min(0).max(999),
  /** Vacío significa "usa el SKU propuesto". */
  sku: z.string().trim().max(40).optional(),
});

export const altaProductoSchema = z
  .object({
    brandSlug: z.string().trim().min(1, "Elige una marca."),
    modelo: z.string().trim().min(2, "Escribe el modelo.").max(80),
    colorway: z.string().trim().min(2, "Escribe el color.").max(80),
    silueta: z.string().trim().max(60).optional(),
    descripcion: z.string().trim().max(1000).optional(),
    condicion: z.enum(CONDICIONES).default("nuevo_en_caja"),
    priceCents: solesSchema,
    costCents: solesSchema,
    /** Precio tachado. Opcional: sin él no se muestra descuento. */
    compareAtPriceCents: solesSchema.optional(),
    /**
     * Nota de calce. NUNCA se autogenera: solo el comerciante, que tiene el par en
     * la mano, puede afirmar si calza grande o pequeño. Un dato de calce inventado
     * produce devoluciones reales.
     */
    notaCalce: z.string().trim().max(200).optional(),
    destacado: z.boolean().default(false),
    variantes: z
      .array(varianteSchema)
      .min(1, "Agrega al menos una talla con stock.")
      // Un producto sin ninguna talla con stock entra al catálogo como agotado, lo
      // que es válido (sirve para recoger lista de espera) pero casi nunca es lo
      // que se quiere al dar de alta, así que el formulario lo advierte.
      .max(TALLAS_DISPONIBLES.length),
  })
  .refine((datos) => datos.costCents <= datos.priceCents, {
    message: "El costo no puede ser mayor que el precio de venta.",
    path: ["costCents"],
  })
  .refine(
    (datos) =>
      datos.compareAtPriceCents === undefined ||
      datos.compareAtPriceCents > datos.priceCents,
    {
      // Un precio tachado menor que el actual anuncia un descuento que no existe:
      // es publicidad engañosa, no un error de tipeo tolerable.
      message: "El precio tachado debe ser mayor que el precio de venta.",
      path: ["compareAtPriceCents"],
    },
  )
  .refine(
    (datos) => new Set(datos.variantes.map((v) => v.sizeUs)).size === datos.variantes.length,
    {
      message: "Hay una talla repetida.",
      path: ["variantes"],
    },
  );

export type EntradaAltaProducto = z.infer<typeof altaProductoSchema>;

export type ResultadoAlta =
  | { ok: true; slug: string; fotosSubidas: number }
  | { ok: false; error: string; campo?: string };
