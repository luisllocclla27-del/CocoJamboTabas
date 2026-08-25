"use server";

/**
 * Subida y validación del comprobante de Yape.
 *
 * Aquí converge todo el antifraude. El orden de las comprobaciones no es
 * casual: primero lo barato y determinista (formato, tamaño, monto, número de
 * operación repetido), después lo caro (hash perceptual, OCR). Así un intento
 * obvio de reutilizar un voucher se rechaza sin gastar CPU.
 *
 * DECISIÓN CENTRAL: este código NUNCA aprueba ni rechaza un pago por sí solo.
 * Calcula señales, puntúa el riesgo y deja el pedido en `comprobante_enviado` para
 * que un humano decida. Aprobar automáticamente un pago tiene consecuencias
 * monetarias directas, y rechazarlo automáticamente deja a un cliente legítimo
 * sin su compra. El nivel `rechazar` es una recomendación para el admin.
 *
 * El archivo se sube con la service_role key porque el bucket es privado y no
 * tiene política de INSERT: el cliente no escribe en Storage. Eso permite validar
 * el archivo ANTES de guardarlo, que es lo que hace posible el antifraude.
 */

import { createHash } from "node:crypto";
import { headers } from "next/headers";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { consumir, identificarPeticion, mensajeLimite } from "@/lib/rate-limit";
import { normalizeReference } from "@/lib/reference";
import { assessRisk, type RiskInput } from "@/lib/fraud/risk-score";
import { parseVoucherText } from "@/lib/fraud/voucher-ocr";
import { detectImageEditing } from "@/lib/fraud/exif";
import { createAdminClient } from "@/lib/supabase/client";

export type ResultadoComprobante =
  | { ok: true; enRevision: true }
  | { ok: false; error: string };

/** 5 MB, el mismo límite que declara el bucket. */
const MAX_BYTES = 5 * 1024 * 1024;

const TIPOS_PERMITIDOS = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

/**
 * Firmas de archivo (magic bytes).
 *
 * No se confía en el `type` que declara el navegador: es un campo que el cliente
 * controla y cambiarlo es trivial. Sin esta comprobación, subir un ejecutable
 * renombrado a `.jpg` pasaría el filtro y el bucket se convertiría en alojamiento
 * de malware con el dominio del negocio dándole credibilidad.
 */
function detectarTipoReal(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  const ascii = (i: number, n: number): string =>
    String.fromCharCode(...bytes.slice(i, i + n));
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "image/webp";
  // HEIC/HEIF: caja `ftyp` con marca heic/heix/mif1.
  if (ascii(4, 4) === "ftyp") {
    const marca = ascii(8, 4);
    if (["heic", "heix", "hevc", "mif1", "msf1"].includes(marca)) return "image/heic";
  }
  return null;
}

const entradaSchema = z.object({
  reference: z.string(),
  operationNumber: z
    .string()
    .trim()
    .transform((v) => v.replace(/\D/g, ""))
    .refine((v) => v.length >= 6 && v.length <= 20, {
      message: "El número de operación debe tener entre 6 y 20 dígitos.",
    }),
});

export async function subirComprobante(datos: FormData): Promise<ResultadoComprobante> {
  // Antes de leer el archivo: subir imágenes de 5 MB en bucle es costoso en
  // transferencia y almacenamiento aunque después se rechacen.
  const limite = consumir("comprobante", identificarPeticion(await headers()));
  if (!limite.permitido) {
    return { ok: false, error: mensajeLimite(limite.esperaSegundos) };
  }

  const parsed = entradaSchema.safeParse({
    reference: String(datos.get("reference") ?? ""),
    operationNumber: String(datos.get("operationNumber") ?? ""),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Datos inválidos." };
  }

  const reference = normalizeReference(parsed.data.reference);
  if (reference === null) return { ok: false, error: "La referencia del pedido no es válida." };

  const archivo = datos.get("voucher");
  if (!(archivo instanceof File) || archivo.size === 0) {
    return { ok: false, error: "Adjunta la captura de tu Yape." };
  }
  if (archivo.size > MAX_BYTES) {
    return { ok: false, error: "La imagen pesa más de 5 MB. Envía una captura, no un video." };
  }

  const bytes = new Uint8Array(await archivo.arrayBuffer());
  const tipoReal = detectarTipoReal(bytes);
  if (tipoReal === null || !TIPOS_PERMITIDOS.has(tipoReal)) {
    return { ok: false, error: "El archivo no es una imagen válida. Sube una captura de pantalla." };
  }

  const supabase = createAdminClient();

  // Se relee el pedido del servidor: el estado y el monto esperado no pueden venir
  // del cliente.
  const { data: pedido, error: errorPedido } = await supabase
    .from("orders")
    .select("id, status, total_cents, created_at, customer_id, customers!inner(telefono)")
    .eq("reference", reference)
    .maybeSingle();

  if (errorPedido !== null || pedido === null) {
    return { ok: false, error: "No encontramos ese pedido." };
  }

  const fila = pedido as unknown as {
    id: string;
    status: string;
    total_cents: number;
    created_at: string;
    customer_id: string;
    customers: { telefono: string };
  };

  // Solo se aceptan comprobantes de pedidos que los esperan. Sin esto, alguien
  // podría subir vouchers a un pedido ya entregado o cancelado.
  if (fila.status !== "pendiente_pago" && fila.status !== "rechazado") {
    return {
      ok: false,
      error:
        fila.status === "comprobante_enviado"
          ? "Ya recibimos tu comprobante y lo estamos validando."
          : "Este pedido ya no admite comprobantes. Escríbenos por WhatsApp.",
    };
  }

  // Comprobación barata y determinista antes de cualquier trabajo pesado: un
  // número de operación no puede pagar dos pedidos.
  const { data: yaUsado } = await supabase
    .from("payments")
    .select("id")
    .eq("operation_number", parsed.data.operationNumber)
    .maybeSingle();

  if (yaUsado !== null) {
    return {
      ok: false,
      error:
        "Ese número de operación ya fue usado en otro pedido. Verifica el número en tu Yape.",
    };
  }

  const sha256 = createHash("sha256").update(bytes).digest("hex");

  /**
   * pHash y OCR quedan sin calcular en esta versión.
   *
   * Ambos necesitan dependencias nativas (`sharp` para decodificar la imagen a
   * escala de grises, un motor OCR para el texto) que no están instaladas. Los
   * módulos de `src/lib/fraud/` definen la interfaz y están testeados, pero aquí no
   * se finge tener capacidades que no existen: se pasan como `null` y las señales
   * correspondientes quedan como "no verificable", lo que sube el peso de la
   * revisión humana en vez de dar una falsa sensación de validación automática.
   */
  const phash: string | null = null;
  const ocr = null as ReturnType<typeof parseVoucherText> | null;
  const exif = detectImageEditing(null);

  const entradaRiesgo: RiskInput = {
    montoEsperadoCents: fila.total_cents,
    // Sin OCR no hay monto leído del voucher: es una advertencia, no un rechazo.
    montoVoucherCents: ocr?.amountCents ?? null,
    operationNumberYaUsado: false,
    phashDuplicado: false,
    distanciaPhashMinima: null,
    fechaVoucher: ocr?.fecha ?? null,
    pedidoCreadoEn: new Date(fila.created_at),
    ahora: new Date(),
    ocrConfidence: null,
    destinatarioVoucher: ocr?.destinatario ?? null,
    destinatarioEsperado: null,
    tieneExifDeEditor: exif.tieneExifDeEditor,
    esPrimeraCompraDelCliente: await esPrimeraCompra(supabase, fila.customer_id),
  };
  const riesgo = assessRisk(entradaRiesgo);

  // Ruta con uuid aleatorio: no debe poder deducirse del pedido. Ver 0004_storage.sql.
  const ahora = new Date();
  const extension = tipoReal.split("/")[1];
  const ruta = `${ahora.getUTCFullYear()}/${String(ahora.getUTCMonth() + 1).padStart(2, "0")}/${fila.id}/${crypto.randomUUID()}.${extension}`;

  const { error: errorSubida } = await supabase.storage
    .from("vouchers")
    .upload(ruta, bytes, { contentType: tipoReal, upsert: false });

  if (errorSubida !== null) {
    return { ok: false, error: "No pudimos guardar tu comprobante. Intenta de nuevo." };
  }

  const { error: errorPago } = await supabase.from("payments").insert({
    order_id: fila.id,
    method: "yape_manual",
    status: "en_revision",
    amount_cents: fila.total_cents,
    operation_number: parsed.data.operationNumber,
    voucher_path: ruta,
    voucher_sha256: sha256,
    voucher_phash: phash,
    ocr_raw: ocr === null ? null : (ocr as unknown as Record<string, unknown>),
    ocr_confidence: null,
    risk_score: riesgo.score,
    risk_signals: riesgo.signals,
  });

  if (errorPago !== null) {
    // 23505: carrera con otro intento que usó el mismo número de operación entre
    // la comprobación de arriba y este insert. El índice único es la garantía real.
    if (errorPago.code === "23505") {
      await supabase.storage.from("vouchers").remove([ruta]);
      return { ok: false, error: "Ese número de operación ya fue registrado." };
    }
    return { ok: false, error: "No pudimos registrar tu pago. Escríbenos por WhatsApp." };
  }

  // La transición la valida la base: si el estado no lo permite, falla ahí y no
  // aquí.
  const { error: errorEstado } = await supabase.rpc("transition_order_status", {
    p_order_id: fila.id,
    p_to: "comprobante_enviado",
    p_actor: "cliente",
    p_motivo: null,
  });
  if (errorEstado !== null) {
    return { ok: false, error: "Recibimos tu comprobante pero hubo un problema. Escríbenos." };
  }

  // Outbox: el aviso al comerciante se encola en la misma base en vez de mandarse
  // aquí. Si el envío del WhatsApp falla, el pedido no se pierde y un worker
  // reintenta. Mandarlo en línea ataría la confirmación del cliente a que un
  // servicio de terceros responda.
  await supabase.from("outbox").insert({
    tipo: "whatsapp_comprobante_recibido",
    payload: {
      reference,
      telefono: fila.customers.telefono,
      risk_score: riesgo.score,
      nivel: riesgo.nivel,
      auto_aprobable: riesgo.autoAprobable,
    },
  });

  revalidatePath(`/pago/${reference}`);
  revalidatePath(`/seguimiento/${reference}`);
  revalidatePath("/admin/avisos");
  revalidatePath("/admin");
  return { ok: true, enRevision: true };
}

async function esPrimeraCompra(
  supabase: ReturnType<typeof createAdminClient>,
  customerId: string,
): Promise<boolean> {
  const { count, error } = await supabase
    .from("orders")
    .select("id", { count: "exact", head: true })
    .eq("customer_id", customerId)
    .in("status", ["verificado", "preparando", "enviado", "entregado"]);
  if (error !== null) return true;
  return (count ?? 0) === 0;
}
