/**
 * Proveedor manual: el flujo real de la tienda desde el día uno.
 *
 * POR QUÉ ES EL PROVEEDOR POR DEFECTO (y no una degradación temporal):
 *
 * 1. No depende de nadie. El proveedor automático habla con un wrapper NO OFICIAL
 *    que raspa `pro.shalom.pe`; el día en que Shalom cambie su web, ese camino
 *    deja de funcionar sin aviso. Si el sistema dependiera de él para poder
 *    despachar, la tienda se quedaría sin envíos por un cambio de CSS ajeno.
 *
 * 2. Cubre el caso de uso real desde ya. El admin va a la agencia, emite la guía
 *    en el mostrador (que es lo que hace hoy) y pega `guia`, `codigo`, agencia y
 *    clave de retiro en el panel. Con eso el cliente ya recibe su número y su
 *    enlace de rastreo, que es el 100% de lo que le importa.
 *
 * 3. No cuesta dinero equivocarse. Emitir por API crea una guía cobrable sin
 *    idempotencia ni sandbox; aquí un error de tecleo se corrige editando un
 *    campo.
 *
 * El rastreo se limita a construir la URL pública de Shalom: es la misma que el
 * cliente usaría a mano, no requiere credenciales y funciona aunque el wrapper
 * esté caído.
 */

import { formatSoles } from "@/lib/money";
import { calcularCotizacion, CONFIG_ENVIO_DEFECTO, type ShippingConfig } from "./quote";
import type {
  ShippingProvider,
  ShippingQuote,
  ShippingQuoteRequest,
  TrackingRef,
  TrackingState,
} from "./types";

/**
 * Página pública de rastreo de Shalom.
 *
 * Se apunta a la web oficial y no al wrapper a propósito: es el enlace que
 * sobrevive a que el wrapper desaparezca, y el cliente ve la marca que conoce.
 */
export const URL_RASTREO_SHALOM = "https://shalom.com.pe/rastrea-tu-envio";

export type ManualProviderOptions = {
  readonly config?: ShippingConfig;
};

export class ManualShippingProvider implements ShippingProvider {
  readonly id = "manual" as const;
  readonly nombre = "Envío coordinado (Shalom manual)";
  /** El estado solo avanza cuando el admin lo actualiza en el panel. */
  readonly soportaTrackingAutomatico = false;
  /** La guía se emite en el mostrador de la agencia y se transcribe. */
  readonly puedeEmitirGuia = false;

  private readonly config: ShippingConfig;

  constructor(options: ManualProviderOptions = {}) {
    this.config = options.config ?? CONFIG_ENVIO_DEFECTO;
  }

  /**
   * Siempre `null`: este proveedor no consulta nada.
   *
   * Devolver `null` en vez de lanzar es lo que permite que el panel pregunte el
   * tracking sin ramificar por proveedor. El llamador interpreta `null` como "hay
   * que mirarlo en la web de Shalom" y muestra `urlRastreo`.
   */
  async consultarTracking(_ref: TrackingRef): Promise<TrackingState | null> {
    return null;
  }

  /**
   * URL pública de rastreo.
   *
   * Shalom no acepta parámetros de consulta en su formulario público, así que el
   * enlace lleva al buscador y el número va aparte en el mensaje. Construir una
   * URL con query inventada daría un enlace roto, que es peor que uno que exige
   * un copiar y pegar.
   */
  urlRastreo(_ref: TrackingRef): string {
    return URL_RASTREO_SHALOM;
  }

  /**
   * Cotiza con la tabla de configuración.
   *
   * Marca `estimado: true` para provincia: el precio real lo dice el mostrador
   * según la medida de la caja, y comprometer un importe exacto que después
   * cambie obliga a cobrar la diferencia o a asumirla.
   */
  async cotizar(request: ShippingQuoteRequest): Promise<ShippingQuote> {
    return calcularCotizacion(request, this.config);
  }
}

/**
 * Datos que el admin transcribe tras emitir en el mostrador, ya validados.
 *
 * Vive en el provider manual porque es su único "formulario": el resto del
 * sistema recibe un `GuiaManual` completo o un error, nunca campos a medias.
 */
export type TranscripcionResult =
  | { readonly ok: true; readonly guia: { guia: string; codigo: string; agencia: string; claveRetiro: string } }
  | { readonly ok: false; readonly errores: readonly string[] };

/**
 * Valida lo que el admin pegó.
 *
 * Se valida aquí y no solo en la UI porque un `codigo` mal copiado produce un
 * enlace de rastreo que no encuentra nada, y el cliente lo descubre antes que
 * nosotros. Las reglas son laxas a propósito (longitudes mínimas, no formatos
 * exactos): el formato de las guías de Shalom no está documentado y rechazar por
 * una regla inventada bloquearía un envío legítimo.
 */
export function validarTranscripcion(datos: {
  guia: string;
  codigo: string;
  agencia: string;
  claveRetiro: string;
}): TranscripcionResult {
  const errores: string[] = [];
  const guia = datos.guia.trim();
  const codigo = datos.codigo.trim();
  const agencia = datos.agencia.trim();
  const claveRetiro = datos.claveRetiro.trim();

  if (guia.length < 3) errores.push("El número de guía es demasiado corto.");
  if (codigo.length < 3) errores.push("El código de rastreo es demasiado corto.");
  if (agencia === "") errores.push("Indica la agencia de destino.");
  if (!/^\d{4}$/.test(claveRetiro)) errores.push("La clave de retiro debe tener 4 dígitos.");

  if (errores.length > 0) return { ok: false, errores };
  return { ok: true, guia: { guia, codigo, agencia, claveRetiro } };
}

/** Mensaje de WhatsApp con los datos de retiro. Formatea el costo con `formatSoles`. */
export function mensajeEnvioManual(datos: {
  guia: string;
  agencia: string;
  claveRetiro: string;
  costoCents: number;
}): string {
  return [
    `Tu pedido ya está en camino por Shalom.`,
    `Guía: ${datos.guia}.`,
    `Recógelo en la agencia de ${datos.agencia} con tu DNI y la clave ${datos.claveRetiro}.`,
    `Costo de envío: ${formatSoles(datos.costoCents)}.`,
    `Puedes seguirlo en ${URL_RASTREO_SHALOM}`,
  ].join(" ");
}
