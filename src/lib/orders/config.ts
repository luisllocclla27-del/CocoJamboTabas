/**
 * Constantes y esquemas de validación de pedidos.
 *
 * Viven separados de `create.ts` porque ese archivo lleva `"use server"`, y un
 * módulo de Server Actions solo puede exportar funciones asíncronas. Exportar de
 * ahí una constante o un esquema rompe el build con "Export doesn't exist in
 * target module", que es un error desconcertante porque el símbolo sí está escrito.
 *
 * Además, así el formulario del cliente puede importar los mismos esquemas para
 * validar antes de enviar, sin arrastrar la lógica de servidor al bundle.
 */

import { z } from "zod";

/**
 * Descuento por pagar con Yape directo.
 *
 * Nota de negocio: se plantea como DESCUENTO por Yape en lugar de recargo por
 * tarjeta. El margen resultante es el mismo, pero cobrar explícitamente la
 * comisión al cliente por pagar con tarjeta choca con las reglas de las marcas, y
 * un beneficio convierte mejor que un castigo.
 */
export const DESCUENTO_YAPE_PCT = 3;

/** Minutos que se mantiene la reserva mientras el cliente paga. */
export const RESERVA_MINUTOS = 30;

/** Reintentos ante colisión de céntimos identificadores o de referencia. */
export const MAX_INTENTOS_CENTIMOS = 12;

export const clienteSchema = z.object({
  nombre: z.string().trim().min(2, "Escribe tu nombre."),
  apellidos: z.string().trim().min(2, "Escribe tus apellidos."),
  // Se normaliza antes de validar porque la gente escribe el celular con
  // espacios, guiones o el prefijo +51. Rechazar "999 888 777" sería perder una
  // venta por un espacio.
  telefono: z
    .string()
    .transform((v) => v.replace(/[\s\-()]/g, "").replace(/^(\+?51)/, ""))
    .refine((v) => /^9\d{8}$/.test(v), "Escribe un celular peruano de 9 dígitos."),
  email: z.string().trim().email("Escribe un correo válido.").optional().or(z.literal("")),
  dni: z
    .string()
    .trim()
    .refine((v) => v === "" || /^\d{8}$/.test(v), "El DNI debe tener 8 dígitos.")
    .optional(),
});

/**
 * Datos de entrega, discriminados por modalidad.
 *
 * Cada modalidad exige campos distintos y ninguno es opcional dentro de su
 * variante: un envío a Lima sin distrito no se puede tarifar, y uno a provincia
 * sin agencia no se puede emitir. Con campos opcionales sueltos, el fallo
 * aparecería al intentar despachar.
 */
export const entregaSchema = z.discriminatedUnion("modo", [
  z.object({
    modo: z.literal("lima_domicilio"),
    distrito: z.string().trim().min(2, "Indica tu distrito."),
    direccion: z.string().trim().min(6, "Escribe tu dirección completa."),
  }),
  z.object({
    modo: z.literal("provincia_agencia"),
    departamento: z.string().trim().min(2, "Indica tu departamento."),
    provincia: z.string().trim().min(2, "Indica tu provincia."),
    agencia: z.string().trim().min(2, "Indica la agencia donde recogerás."),
  }),
  z.object({ modo: z.literal("recojo_tienda") }),
]);

export const crearPedidoSchema = z.object({
  cliente: clienteSchema,
  entrega: entregaSchema,
  // Solo se ofrece Yape manual por ahora. `contraentrega` y `tupay` existen en el
  // enum de la base pero no se exponen hasta tener el flujo completo.
  metodoPago: z.literal("yape_manual"),
  notas: z.string().trim().max(300).optional(),
});

export type EntradaCrearPedido = z.input<typeof crearPedidoSchema>;
export type DatosEntrega = z.infer<typeof entregaSchema>;

export type ResultadoCrearPedido =
  | { ok: true; reference: string }
  | { ok: false; error: string; campo?: string };
