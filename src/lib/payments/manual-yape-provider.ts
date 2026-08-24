/**
 * Yape manual: la ruta por defecto del checkout.
 *
 * Por qué existe esta implementación y no es un apaño temporal:
 *
 * - No requiere contrato, ni KYC de comercio, ni whitelisting de IP, ni pasar
 *   una certificación. Funciona el primer día con un número de celular.
 * - Comisión 0%. Con el margen de una tienda pequeña de zapatillas, el ~4% de
 *   una pasarela es una parte relevante de la ganancia por par.
 * - No tiene ningún punto de fallo externo: si Tupay está caída, mal
 *   configurada o sin whitelistear la IP, esto sigue cobrando.
 *
 * Lo que cuesta a cambio: alguien tiene que mirar un screenshot. Ese coste se
 * mitiga con los céntimos identificadores de `@/lib/payment-cents`, que hacen
 * que el monto exacto apunte a un solo pedido y el admin no tenga que casar
 * vouchers a mano.
 *
 * No hace ninguna llamada de red. `crearIntento` es efectivamente puro salvo por
 * el reloj, y por eso el reloj es inyectable: un test que dependa de `Date.now()`
 * real es un test que falla a medianoche.
 */

import { formatSoles, type Cents } from "@/lib/money";
import { applyPaymentCents } from "@/lib/payment-cents";
import type {
  PaymentIntent,
  PaymentProvider,
  PaymentResult,
  PaymentStatusResult,
} from "./types";

/**
 * Minutos que se mantiene la reserva de stock esperando el Yape.
 *
 * 30 minutos es el compromiso: suficiente para que alguien termine de decidirse
 * o busque su celular, y lo bastante corto para que un carrito abandonado no
 * bloquee la última talla 42 durante horas.
 */
export const RESERVA_MINUTOS = 30;

export type YapeManualConfig = {
  /** Número de celular del comercio, tal como se muestra al cliente. */
  readonly numeroYape: string;
  /** Titular de la cuenta. El cliente lo verifica antes de yapear. */
  readonly titular: string;
  readonly reservaMinutos?: number;
};

export type ManualYapeProviderOptions = {
  readonly config: YapeManualConfig;
  /**
   * Céntimos identificadores del pedido, ya reservados en la base con el índice
   * único. El provider NO los elige: la unicidad sólo puede garantizarla la
   * transacción que los escribe, y elegirlos aquí abriría una carrera entre dos
   * checkouts simultáneos. `pickPaymentCents` se usa en esa transacción.
   */
  readonly centimosIdentificadores: number;
  readonly now?: () => Date;
};

export class ManualYapeProvider implements PaymentProvider {
  readonly id = "yape_manual" as const;
  readonly nombre = "Yape directo";
  /** El pago no está confirmado hasta que un humano valida el comprobante. */
  readonly requiereVerificacionManual = true;
  /** Sin intermediario no hay comisión. Es la razón de ser de este método. */
  readonly comisionPorcentaje = 0;

  private readonly config: YapeManualConfig;
  private readonly centimos: number;
  private readonly now: () => Date;

  constructor(options: ManualYapeProviderOptions) {
    this.config = options.config;
    this.centimos = options.centimosIdentificadores;
    this.now = options.now ?? (() => new Date());
  }

  async crearIntento(intent: PaymentIntent): Promise<PaymentResult> {
    if (this.config.numeroYape.trim() === "" || this.config.titular.trim() === "") {
      // Sin número no hay a dónde yapear. Falla como configuración inválida en
      // lugar de mostrar una pantalla de pago con un hueco.
      return {
        ok: false,
        metodo: this.id,
        error: {
          codigo: "CONFIGURACION_INVALIDA",
          mensajeCliente:
            "El pago por Yape no está disponible en este momento. Escríbenos por WhatsApp.",
          mensajeTecnico: "YAPE_NUMERO o YAPE_TITULAR sin configurar",
          reintentable: false,
        },
      };
    }

    let monto: { totalCents: Cents; paymentCents: number };
    try {
      // `applyPaymentCents` SUSTITUYE los céntimos del importe y garantiza que el
      // total nunca queda por debajo del precio real.
      monto = applyPaymentCents(intent.amountCents, this.centimos);
    } catch (error) {
      return {
        ok: false,
        metodo: this.id,
        error: {
          codigo: "MONTO_INVALIDO",
          mensajeCliente: "No pudimos preparar tu pago. Vuelve a intentarlo en un momento.",
          mensajeTecnico: error instanceof Error ? error.message : String(error),
          reintentable: true,
        },
      };
    }

    const minutos = this.config.reservaMinutos ?? RESERVA_MINUTOS;
    const expiraEn = new Date(this.now().getTime() + minutos * 60_000);
    const totalFormateado = formatSoles(monto.totalCents);

    return {
      ok: true,
      metodo: this.id,
      // No hay nada creado en ningún sistema externo: el nexo entre el pago y el
      // pedido es el monto exacto, no un identificador de proveedor.
      providerRef: null,
      instruccion: {
        tipo: "manual_yape",
        numeroYape: this.config.numeroYape,
        titular: this.config.titular,
        montoCents: monto.totalCents,
        centimosIdentificadores: monto.paymentCents,
        montoFormateado: totalFormateado,
        expiraEn,
        pasos: [
          `Abre Yape y yapea exactamente ${totalFormateado} al ${this.config.numeroYape} (${this.config.titular}).`,
          "El monto tiene céntimos exactos a propósito: así identificamos tu pedido sin que escribas ningún código.",
          "Toma captura de la constancia de pago.",
          "Súbela aquí para que validemos tu pedido.",
          `Tienes ${minutos} minutos: pasado ese tiempo liberamos tu talla.`,
        ],
        requiereComprobante: true,
      },
      // Sigue pendiente: el siguiente evento es que el cliente suba el
      // comprobante, y ahí pasa a `comprobante_enviado`.
      estadoPedidoSugerido: "pendiente_pago",
      comisionCents: 0,
    };
  }

  /**
   * No hay API que consultar. Devuelve `pendiente` en vez de lanzar para que el
   * llamador pueda preguntar el estado de cualquier pedido sin ramificar por
   * método; la verdad del Yape manual vive en la tabla de pedidos, y el estado
   * real lo pone el admin al validar.
   */
  async consultarEstado(providerRef: string): Promise<PaymentStatusResult> {
    return {
      estado: "pendiente",
      providerRef,
      montoCents: null,
      actualizadoEn: null,
      detalle: "El Yape manual no tiene consulta automática: lo valida el administrador.",
    };
  }
}

/** Total exacto que el cliente debe yapear, para mostrarlo antes de crear el intento. */
export function totalAYapear(baseCents: Cents, centimos: number): Cents {
  return applyPaymentCents(baseCents, centimos).totalCents;
}
