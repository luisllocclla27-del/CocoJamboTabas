/**
 * Proveedor automático: emite guías y consulta el tracking vía el wrapper.
 *
 * Es el camino "bueno" y también el frágil. Todo lo que hace depende de un
 * servicio NO OFICIAL que raspa `pro.shalom.pe`, así que este archivo asume que
 * puede fallar en cualquier momento y nunca deja al llamador sin respuesta útil:
 * el tracking devuelve `null` en vez de propagar el error, y la emisión devuelve
 * un `EmitirGuiaResult` con el fallo como dato.
 *
 * La cotización NO llama a la API a propósito. `POST /v1/tariff/calculate` toca
 * la cuenta y puede tardar hasta 150 s por el login; ponerla en la ruta del
 * checkout dejaría al cliente esperando dos minutos por un precio. Se usa la
 * tabla de configuración (igual que el proveedor manual) y la tarifa real se
 * consulta en el panel, fuera del request del comprador.
 */

import {
  ShalomClient,
  type IdempotencyGuard,
  type ShalomAgencia,
} from "./shalom-client";
import { calcularCotizacion, CONFIG_ENVIO_DEFECTO, type ShippingConfig } from "./quote";
import { URL_RASTREO_SHALOM } from "./manual-provider";
import type {
  EmitirGuiaRequest,
  EmitirGuiaResult,
  GuiaIssuer,
  ShippingProvider,
  ShippingQuote,
  ShippingQuoteRequest,
  TrackingRef,
  TrackingState,
} from "./types";

export type ShalomProviderOptions = {
  readonly client: ShalomClient;
  readonly config?: ShippingConfig;
  /** Terminal de origen de la tienda. Necesaria para emitir y para tarifar. */
  readonly terminalOrigenId?: string;
  readonly logger?: { warn(mensaje: string): void };
};

export class ShalomShippingProvider implements ShippingProvider, GuiaIssuer {
  readonly id = "shalom" as const;
  readonly nombre = "Shalom (automático)";
  readonly soportaTrackingAutomatico = true;
  readonly puedeEmitirGuia = true;

  private readonly client: ShalomClient;
  private readonly config: ShippingConfig;
  private readonly logger: { warn(mensaje: string): void } | undefined;

  constructor(options: ShalomProviderOptions) {
    this.client = options.client;
    this.config = options.config ?? CONFIG_ENVIO_DEFECTO;
    this.logger = options.logger;
  }

  /**
   * Estado del envío, o `null` si no se pudo obtener.
   *
   * Se traga el error y devuelve `null` porque el llamador típico es la página de
   * seguimiento del cliente: si el wrapper está caído, mostrar la última línea de
   * tiempo guardada y el enlace público de Shalom es mucho mejor que un 500. El
   * fallo se loguea para que sí lo veamos nosotros.
   */
  async consultarTracking(ref: TrackingRef): Promise<TrackingState | null> {
    try {
      const { tracking } = await this.client.consultarTracking(ref, true);
      return tracking;
    } catch (error) {
      this.logger?.warn(
        `Shalom: no se pudo consultar el tracking (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
      return null;
    }
  }

  /** Misma URL pública que el proveedor manual: es la que sobrevive al wrapper. */
  urlRastreo(_ref: TrackingRef): string {
    return URL_RASTREO_SHALOM;
  }

  /**
   * Cotiza con la tabla local, no con la API.
   *
   * Ver la cabecera del archivo: la ruta de tarifas puede tardar 150 s y esto se
   * ejecuta dentro del checkout.
   */
  async cotizar(request: ShippingQuoteRequest): Promise<ShippingQuote> {
    return calcularCotizacion(request, this.config);
  }

  /**
   * Emite la guía. Delega en el cliente, que lleva las salvaguardas.
   *
   * Se repite aquí el recordatorio porque es donde lo va a leer quien escriba la
   * ruta del panel: CADA EMISIÓN CREA UNA GUÍA REAL Y COBRABLE, no hay sandbox y
   * el servidor no ofrece idempotencia. El `idempotencyGuard` no es opcional.
   */
  async emitirGuia(
    request: EmitirGuiaRequest,
    confirmacionExplicita: true,
    idempotencyGuard?: IdempotencyGuard,
  ): Promise<EmitirGuiaResult> {
    if (idempotencyGuard === undefined) {
      return {
        ok: false,
        mensajeCliente: "No pudimos generar la guía de envío.",
        mensajeTecnico:
          "emitirGuia requiere un idempotencyGuard: sin él, un timeout llevaría a emitir dos guías cobrables para el mismo pedido",
        reintentable: false,
        requiereRevisionManual: false,
      };
    }
    return this.client.emitirGuia(request, confirmacionExplicita, idempotencyGuard);
  }

  /**
   * Sugiere la agencia más cercana a unas coordenadas.
   *
   * Devuelve `null` ante cualquier fallo: es una ayuda del checkout, y si no está
   * disponible el cliente elige su agencia del catálogo cacheado.
   */
  async sugerirAgencia(lat: number, lng: number): Promise<ShalomAgencia | null> {
    try {
      return await this.client.agenciaMasCercana(lat, lng);
    } catch (error) {
      this.logger?.warn(
        `Shalom: no se pudo sugerir agencia (${error instanceof Error ? error.message : String(error)})`,
      );
      return null;
    }
  }

  /**
   * Suscribe el envío a webhooks y, si no hay cupo, lo indica.
   *
   * El cupo de 50 suscripciones activas es un límite real del servicio: por
   * encima de eso el seguimiento tiene que hacerse por sondeo con
   * `consultarTrackingLote`. Devolver un booleano en vez de lanzar permite que el
   * llamador apunte el envío a la cola de sondeo sin tratar el caso como error.
   */
  async activarSeguimiento(numero: string, codigo: string): Promise<boolean> {
    const resultado = await this.client.suscribirEnvio(numero, codigo);
    if (!resultado.ok) {
      this.logger?.warn(`Shalom: no se pudo suscribir el envío: ${resultado.motivo}`);
      return false;
    }
    return true;
  }
}
