/**
 * Mensajes del outbox.
 *
 * La redacción vive aparte del envío por dos razones: es lo único testeable sin
 * red, y es lo que el comerciante va a querer ajustar. Cambiar una frase no debería
 * obligar a tocar la lógica de reintentos.
 *
 * Los textos van en el tono con el que se escribe por WhatsApp en Perú: directos,
 * sin "estimado cliente" ni formalidad de correo corporativo. Un mensaje que suena
 * a robot baja la confianza justo cuando el cliente acaba de pagar.
 */

import { formatSoles, type Cents } from "@/lib/money";

/** Tipos de evento que se encolan hoy. Ver los `insert` en `orders/` y `admin/`. */
export const TIPOS_OUTBOX = [
  "whatsapp_comprobante_recibido",
  "whatsapp_pago_aprobado",
  "whatsapp_pago_rechazado",
  "whatsapp_pedido_enviado",
  "restock_aviso",
] as const;

export type TipoOutbox = (typeof TIPOS_OUTBOX)[number];

export type MensajeListo = {
  /** Celular en formato internacional sin `+`, como lo espera `wa.me`. */
  telefono: string;
  texto: string;
  /** Enlace directo para abrir WhatsApp con el mensaje escrito. */
  enlace: string;
};

export function esTipoConocido(valor: string): valor is TipoOutbox {
  return (TIPOS_OUTBOX as readonly string[]).includes(valor);
}

/**
 * Normaliza un celular peruano a formato internacional.
 *
 * Devuelve `null` si no parece válido: mandar un mensaje a un número mal formado
 * falla en silencio del lado del proveedor, y un `null` explícito permite marcar el
 * evento como fallido con un motivo claro en lugar de darlo por enviado.
 */
export function normalizarTelefono(valor: unknown): string | null {
  if (typeof valor !== "string") return null;
  const limpio = valor.replace(/[\s\-()+]/g, "");
  // Ya viene con prefijo país.
  if (/^51 9\d{8}$/.test(limpio.replace(/^51/, "51 "))) return limpio;
  if (/^519\d{8}$/.test(limpio)) return limpio;
  if (/^9\d{8}$/.test(limpio)) return `51${limpio}`;
  return null;
}

function enlaceWhatsapp(telefono: string, texto: string): string {
  return `https://wa.me/${telefono}?text=${encodeURIComponent(texto)}`;
}

type Payload = Record<string, unknown>;

function texto(payload: Payload, clave: string): string | null {
  const valor = payload[clave];
  return typeof valor === "string" && valor.trim() !== "" ? valor.trim() : null;
}

/**
 * Construye el mensaje de un evento.
 *
 * Devuelve `null` cuando el payload no tiene lo mínimo para redactarlo. Eso marca el
 * evento como fallido en vez de enviar un mensaje con huecos: "Tu pedido undefined
 * ya salió" es peor que no escribir.
 */
export function construirMensaje(tipo: string, payload: Payload): MensajeListo | null {
  if (!esTipoConocido(tipo)) return null;

  const telefono = normalizarTelefono(payload.telefono);
  const reference = texto(payload, "reference");
  const base = process.env.NEXT_PUBLIC_SITE_URL ?? "";

  if (telefono === null || reference === null) return null;

  const enlaceSeguimiento = base === "" ? "" : ` ${base}/seguimiento/${reference}`;

  let cuerpo: string;
  switch (tipo) {
    case "whatsapp_comprobante_recibido":
      // Este va al COMERCIANTE, no al cliente: es el aviso de que hay trabajo.
      cuerpo = `Nuevo comprobante en el pedido ${reference}. Revísalo en el panel para confirmar el pago.`;
      break;

    case "whatsapp_pago_aprobado":
      cuerpo = `Confirmamos tu pago del pedido ${reference}. Ya estamos preparando tus zapatillas y te avisamos cuando salgan.${enlaceSeguimiento}`;
      break;

    case "whatsapp_pago_rechazado": {
      const motivo = texto(payload, "motivo");
      cuerpo =
        `No pudimos validar el pago del pedido ${reference}.` +
        (motivo === null ? "" : ` ${motivo}`) +
        ` Puedes enviarnos otro comprobante acá:${enlaceSeguimiento}`;
      break;
    }

    case "whatsapp_pedido_enviado": {
      const guia = texto(payload, "guia");
      const clave = texto(payload, "clave_retiro");
      const agencia = texto(payload, "agencia");
      if (guia === null) return null;
      cuerpo =
        `Tu pedido ${reference} ya salió. Guía Shalom: ${guia}.` +
        (agencia === null ? "" : ` Recógelo en la agencia de ${agencia}.`) +
        (clave === null
          ? ""
          : ` Tu clave de retiro es ${clave}: preséntala con tu DNI y no la compartas con nadie.`) +
        enlaceSeguimiento;
      break;
    }

    case "restock_aviso": {
      const modelo = texto(payload, "modelo");
      const talla = payload.size_us;
      if (modelo === null || typeof talla !== "number") return null;
      const precio = typeof payload.price_cents === "number" ? (payload.price_cents as Cents) : null;
      cuerpo =
        `Volvieron las ${modelo} en talla US ${Number.isInteger(talla) ? talla : talla.toFixed(1)}.` +
        (precio === null ? "" : ` ${formatSoles(precio)}.`) +
        ` ¿Te la aparto?`;
      break;
    }
  }

  return { telefono, texto: cuerpo, enlace: enlaceWhatsapp(telefono, cuerpo) };
}

/**
 * Espera antes del siguiente intento, con retroceso exponencial.
 *
 * Empieza en 1 minuto y se topa en 1 hora. El tope existe para que un evento que
 * lleva días fallando siga reintentándose de vez en cuando en lugar de quedar
 * programado para el año que viene.
 */
export function esperaReintentoMs(intentos: number): number {
  const base = 60_000;
  const maximo = 60 * 60_000;
  return Math.min(base * 2 ** Math.max(0, intentos), maximo);
}

/**
 * Tras cuántos intentos se abandona.
 *
 * 6 intentos con este retroceso cubren algo más de dos horas. Pasado eso, el fallo
 * no es transitorio y hace falta que alguien lo mire: seguir reintentando solo
 * llena la tabla y esconde el problema.
 */
export const MAX_INTENTOS_OUTBOX = 6;

export function debeAbandonar(intentos: number): boolean {
  return intentos >= MAX_INTENTOS_OUTBOX;
}
