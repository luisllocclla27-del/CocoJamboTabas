/**
 * `PaymentProvider` sobre el cliente HTTP de Tupay.
 *
 * Aquí vive toda la traducción entre el vocabulario del negocio y el de Tupay:
 * el resto de la aplicación no debería contener nunca la cadena `"XAYP"` ni
 * saber qué es un `checkout_type`. Si mañana se cambia de pasarela, este archivo
 * y `tupay-client.ts` son los únicos que se reescriben.
 *
 * Recordatorio de la restricción de despliegue: Tupay whitelistea la IP de
 * salida, así que este provider sólo funciona desde un host con IP fija. Ver la
 * cabecera de `tupay-client.ts`.
 */

import { formatSoles } from "@/lib/money";
import {
  comisionCents,
  documentoEsValido,
  REGLAS_DOCUMENTO,
  type CanalPreferido,
  type PaymentErrorCode,
  type PaymentFailure,
  type PaymentInstruction,
  type PaymentIntent,
  type PaymentProvider,
  type PaymentProviderStatus,
  type PaymentResult,
  type PaymentStatusResult,
} from "./types";
import {
  centsToSoles,
  normalizarInvoiceId,
  solesToCents,
  TupayClient,
  TupayError,
  TUPAY_MONTO_MINIMO_CENTS,
  TUPAY_PAYMENT_METHODS,
  type TupayDepositRequest,
  type TupayDepositResponse,
  type TupayMultigatewayEntry,
  type TupayPaymentMethodCode,
} from "./tupay-client";

/**
 * Comisión de Tupay, en porcentaje. Es un valor de configuración comercial, no
 * un dato de la API: se usa para conciliar y para dimensionar el descuento por
 * Yape directo (ver `registry.ts`). Si cambia el contrato, cambia aquí.
 */
export const TUPAY_COMISION_PORCENTAJE = 3.99;

/** Minutos de vida del cobro si el pedido no impone otro plazo. */
const EXPIRACION_DEFECTO_MINUTOS = 30;

/**
 * Preferencia de canal → código de Tupay.
 *
 * `cualquiera` mapea a `XA` (todos los medios) en lugar de a un medio concreto:
 * dejar que Tupay muestre su selector maximiza la conversión cuando el cliente
 * no ha expresado preferencia.
 */
const CANAL_A_CODIGO: Readonly<Record<CanalPreferido, TupayPaymentMethodCode>> = {
  cualquiera: TUPAY_PAYMENT_METHODS.TODOS,
  qr: TUPAY_PAYMENT_METHODS.QR_TODOS,
  yape: TUPAY_PAYMENT_METHODS.YAPE,
  plin: TUPAY_PAYMENT_METHODS.PLIN,
  tarjeta: TUPAY_PAYMENT_METHODS.TARJETA,
  efectivo: TUPAY_PAYMENT_METHODS.EFECTIVO,
  transferencia: TUPAY_PAYMENT_METHODS.TRANSFERENCIA,
};

export function codigoParaCanal(canal: CanalPreferido | undefined): TupayPaymentMethodCode {
  return CANAL_A_CODIGO[canal ?? "cualquiera"];
}

/** ¿El canal elegido produce un QR que debemos pintar nosotros? */
function canalEsQr(canal: CanalPreferido): canal is "qr" | "yape" | "plin" {
  return canal === "qr" || canal === "yape" || canal === "plin";
}

/**
 * Estados de Tupay → estados normalizados.
 *
 * Se incluyen varias grafías porque la doc y los ejemplos no coinciden siempre
 * (`APPROVED` vs `PAID`), y tratar un aprobado desconocido como `desconocido`
 * es preferible a aprobar por error, pero tratarlo como rechazado sería peor.
 */
const ESTADO_TUPAY: Readonly<Record<string, PaymentProviderStatus>> = {
  APPROVED: "aprobado",
  PAID: "aprobado",
  COMPLETED: "aprobado",
  SUCCESS: "aprobado",
  PENDING: "pendiente",
  IN_PROGRESS: "pendiente",
  CREATED: "pendiente",
  WAITING: "pendiente",
  REJECTED: "rechazado",
  DECLINED: "rechazado",
  FAILED: "rechazado",
  ERROR: "rechazado",
  CANCELLED: "rechazado",
  CANCELED: "rechazado",
  EXPIRED: "expirado",
  TIMEOUT: "expirado",
  REFUNDED: "reembolsado",
  CHARGEBACK: "reembolsado",
};

export function normalizarEstadoTupay(estado: string | undefined | null): PaymentProviderStatus {
  if (estado === undefined || estado === null) return "desconocido";
  return ESTADO_TUPAY[estado.trim().toUpperCase()] ?? "desconocido";
}

/** Fecha de Tupay → `Date`, o `null` si viene ausente o ilegible. */
function parseFecha(valor: string | null | undefined): Date | null {
  if (valor === undefined || valor === null || valor.trim() === "") return null;
  const t = Date.parse(valor);
  return Number.isNaN(t) ? null : new Date(t);
}

/** Extrae la primera entrada de `multigateway_metadata` de un tipo dado. */
function buscarMetadata<T extends TupayMultigatewayEntry["paymentMethodType"]>(
  entradas: readonly TupayMultigatewayEntry[],
  tipo: T,
): TupayMultigatewayEntry | undefined {
  return entradas.find((e) => e.paymentMethodType === tipo);
}

export type TupayProviderOptions = {
  readonly client: TupayClient;
  /**
   * `fee_on_payer`: si la comisión se le carga al pagador. Por defecto `false`,
   * la absorbe el comercio. Ver la nota de negocio en `registry.ts` sobre por qué
   * no se le cobra explícitamente al cliente por pagar con tarjeta.
   */
  readonly feeOnPayer?: boolean;
};

export class TupayProvider implements PaymentProvider {
  readonly id = "tupay" as const;
  readonly nombre = "Yape, Plin o tarjeta (pago automático)";
  /** La pasarela confirma sola: nadie revisa un screenshot. */
  readonly requiereVerificacionManual = false;
  readonly comisionPorcentaje = TUPAY_COMISION_PORCENTAJE;

  private readonly client: TupayClient;
  private readonly feeOnPayer: boolean;

  constructor(options: TupayProviderOptions) {
    this.client = options.client;
    this.feeOnPayer = options.feeOnPayer ?? false;
  }

  async crearIntento(intent: PaymentIntent): Promise<PaymentResult> {
    // Validaciones locales primero: cada una de estas ahorra un round-trip a un
    // error 201/400 que ya sabíamos que iba a ocurrir, y el cliente recibe el
    // mensaje al instante en vez de tras el timeout de la pasarela.
    const problemaLocal = this.validarIntento(intent);
    if (problemaLocal !== null) {
      return {
        ok: false,
        metodo: this.id,
        error: problemaLocal,
      };
    }

    const body = this.construirBody(intent);
    let respuesta: TupayDepositResponse;
    try {
      respuesta = await this.client.createDeposit(body);
    } catch (error) {
      return { ok: false, metodo: this.id, error: this.traducirError(error) };
    }

    const instruccion = this.construirInstruccion(intent, respuesta);
    if (instruccion === null) {
      // 201 sin nada con lo que continuar. El depósito puede existir en Tupay, así
      // que se marca como no reintentable: reintentar crearía confusión y la
      // idempotency key devolvería el mismo cascarón vacío.
      return {
        ok: false,
        metodo: this.id,
        error: {
          codigo: "PROVEEDOR",
          mensajeCliente:
            "La pasarela no devolvió una forma de pagar. Prueba con otro medio o paga por Yape directo.",
          mensajeTecnico: `depósito ${respuesta.deposit_id} creado sin redirect_url ni QR utilizable (checkout_type=${respuesta.checkout_type})`,
          reintentable: false,
        },
      };
    }

    return {
      ok: true,
      metodo: this.id,
      providerRef: respuesta.deposit_id,
      instruccion,
      // El pedido sigue pendiente hasta que llegue la notificación firmada.
      // Adelantarlo aquí sería fiarse de que el cliente completa el checkout
      // después de que se lo mostramos, que es justo donde se cae la gente.
      estadoPedidoSugerido: "pendiente_pago",
      comisionCents: comisionCents(intent.amountCents, this.comisionPorcentaje),
    };
  }

  async consultarEstado(providerRef: string): Promise<PaymentStatusResult> {
    try {
      const r = await this.client.getDeposit(providerRef);
      const montoSoles = r.amount ?? r.payment_info?.amount;
      return {
        estado: normalizarEstadoTupay(r.status),
        providerRef: r.deposit_id,
        montoCents: montoSoles === undefined ? null : solesToCents(montoSoles),
        actualizadoEn: parseFecha(r.updated_at) ?? parseFecha(r.payment_info?.created_at),
        detalle: r.description ?? null,
      };
    } catch (error) {
      // Consultar no debe tumbar al llamador: un fallo de consulta es
      // "no sé todavía", no "rechazado". Devolver `rechazado` aquí liberaría el
      // stock de un pedido posiblemente pagado.
      const traducido = this.traducirError(error);
      return {
        estado: "desconocido",
        providerRef,
        montoCents: null,
        actualizadoEn: null,
        detalle: traducido.mensajeTecnico,
      };
    }
  }

  /** Validaciones que evitan un error previsible de la pasarela. */
  private validarIntento(intent: PaymentIntent): PaymentFailure | null {
    const { customer } = intent;
    if (!documentoEsValido(customer.tipoDocumento, customer.documento)) {
      return {
        codigo: "DATOS_PAGADOR_INVALIDOS",
        mensajeCliente: `Revisa tu documento. ${REGLAS_DOCUMENTO[customer.tipoDocumento].descripcion}.`,
        // Nunca el valor del documento en el log: es dato personal.
        mensajeTecnico: `documento con formato inválido para tipo ${customer.tipoDocumento} (longitud ${customer.documento.trim().length})`,
        reintentable: false,
      };
    }
    if (customer.nombres.trim() === "" || customer.apellidos.trim() === "") {
      return {
        codigo: "DATOS_PAGADOR_INVALIDOS",
        mensajeCliente: "Necesitamos tu nombre y tus apellidos para emitir el comprobante.",
        mensajeTecnico: "first_name o last_name vacíos",
        reintentable: false,
      };
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(customer.email.trim())) {
      return {
        codigo: "DATOS_PAGADOR_INVALIDOS",
        mensajeCliente: "El correo no parece válido. Lo necesitamos para enviarte el comprobante.",
        mensajeTecnico: "email con formato inválido",
        reintentable: false,
      };
    }
    if (!Number.isInteger(intent.amountCents) || intent.amountCents <= 0) {
      return {
        codigo: "MONTO_INVALIDO",
        mensajeCliente: "El monto del pedido no es válido. Vuelve a armar tu carrito.",
        mensajeTecnico: `amountCents no es un entero positivo: ${String(intent.amountCents)}`,
        reintentable: false,
      };
    }
    if (intent.amountCents < TUPAY_MONTO_MINIMO_CENTS) {
      return {
        codigo: "MONTO_INVALIDO",
        mensajeCliente: `El pago con pasarela requiere un mínimo de ${formatSoles(
          TUPAY_MONTO_MINIMO_CENTS,
        )}. Para montos menores usa Yape directo.`,
        mensajeTecnico: `monto ${intent.amountCents} por debajo del mínimo de Tupay (${TUPAY_MONTO_MINIMO_CENTS})`,
        reintentable: false,
      };
    }
    return null;
  }

  private construirBody(intent: PaymentIntent): TupayDepositRequest {
    const { customer } = intent;
    const body: TupayDepositRequest = {
      country: "PE",
      currency: "PEN",
      // Tupay espera soles decimales; internamente todo es céntimos.
      amount: centsToSoles(intent.amountCents),
      payment_method: codigoParaCanal(intent.canal),
      invoice_id: normalizarInvoiceId(intent.reference),
      success_url: intent.urls.success,
      notification_url: intent.urls.notification,
      payer: {
        first_name: customer.nombres.trim(),
        last_name: customer.apellidos.trim(),
        document: customer.documento.trim(),
        document_type: customer.tipoDocumento,
        email: customer.email.trim(),
      },
      back_url: intent.urls.back,
      error_url: intent.urls.error,
      expiration: intent.expiraEnMinutos ?? EXPIRACION_DEFECTO_MINUTOS,
      test: this.client.testMode,
      fee_on_payer: this.feeOnPayer,
      description: intent.descripcion.slice(0, 255),
    };
    // Los opcionales se añaden sólo si hay valor: mandar `"phone": ""` es un 201
    // BEAN_VALIDATION_ERROR, mientras que omitir la clave es válido.
    if (customer.telefono !== undefined && customer.telefono.trim() !== "") {
      body.payer.phone = customer.telefono.trim();
    }
    if (customer.direccion !== undefined && customer.direccion.trim() !== "") {
      body.payer.address = customer.direccion.trim();
    }
    if (intent.clientIp !== undefined && intent.clientIp.trim() !== "") {
      body.client_ip = intent.clientIp.trim();
    }
    if (intent.mobile !== undefined) body.mobile = intent.mobile;
    return body;
  }

  /**
   * Respuesta de Tupay → instrucción para la UI.
   *
   * Orden de preferencia deliberado:
   *
   * 1. `HOSTED` siempre redirige: significa que Tupay va a pedir datos del
   *    pagador, así que no hay QR que pintar.
   * 2. Si el canal es de QR y hay `qrCode`, se pinta el QR en nuestra página.
   *    Mantener al cliente en nuestro dominio mejora la conversión y evita el
   *    "¿esta página es de verdad?" que produce un dominio desconocido.
   * 3. Transferencia con convenio/referencia: son datos que el cliente copia.
   * 4. Cualquier otro caso con URL: redirección.
   */
  private construirInstruccion(
    intent: PaymentIntent,
    respuesta: TupayDepositResponse,
  ): PaymentInstruction | null {
    const info = respuesta.payment_info;
    const expiraEn = parseFecha(info?.expiration_date);
    const metadata = info?.multigateway_metadata ?? [];
    const canal: CanalPreferido = intent.canal ?? "cualquiera";
    const redirectUrl = respuesta.redirect_url ?? null;

    if (respuesta.checkout_type === "HOSTED") {
      if (redirectUrl === null || redirectUrl.trim() === "") return null;
      return {
        tipo: "redirect",
        url: redirectUrl,
        iframe: respuesta.iframe === true,
        expiraEn,
        pedirDatosEnPasarela: true,
      };
    }

    if (canalEsQr(canal)) {
      const qr = buscarMetadata(metadata, "QR_CODE");
      const dataUri = qr !== undefined ? (qr as { qrCode?: string }).qrCode : undefined;
      if (typeof dataUri === "string" && dataUri.length > 0) {
        return {
          tipo: "qr",
          dataUri,
          montoCents: intent.amountCents,
          montoFormateado: formatSoles(intent.amountCents),
          canal,
          expiraEn,
          urlAlternativa: redirectUrl,
        };
      }
    }

    if (canal === "transferencia") {
      const transferencia = buscarMetadata(metadata, "BANK_TRANSFER") as
        | { agreement?: string; reference?: string }
        | undefined;
      if (
        transferencia !== undefined &&
        typeof transferencia.agreement === "string" &&
        typeof transferencia.reference === "string"
      ) {
        return {
          tipo: "transferencia",
          convenio: transferencia.agreement,
          referencia: transferencia.reference,
          montoCents: intent.amountCents,
          montoFormateado: formatSoles(intent.amountCents),
          expiraEn,
        };
      }
    }

    const tarjeta = buscarMetadata(metadata, "CREDIT_CARD") as
      | { redirectUrl?: string }
      | undefined;
    const url =
      redirectUrl !== null && redirectUrl.trim() !== ""
        ? redirectUrl
        : typeof tarjeta?.redirectUrl === "string" && tarjeta.redirectUrl !== ""
          ? tarjeta.redirectUrl
          : null;
    if (url === null) return null;
    return {
      tipo: "redirect",
      url,
      iframe: respuesta.iframe === true,
      expiraEn,
      pedirDatosEnPasarela: false,
    };
  }

  /** `TupayError` → `PaymentFailure` del contrato común. */
  private traducirError(error: unknown): PaymentFailure {
    if (error instanceof TupayError) {
      return {
        codigo: codigoNegocio(error.code),
        mensajeCliente: error.mensajeCliente,
        mensajeTecnico:
          error.details.length > 0
            ? `${error.message} | details: ${error.details.join("; ")}`
            : error.message,
        reintentable: error.esReintentable,
      };
    }
    return {
      codigo: "PROVEEDOR",
      mensajeCliente:
        "No pudimos iniciar el pago con la pasarela. Puedes pagar por Yape directo.",
      mensajeTecnico: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      reintentable: false,
    };
  }
}

/** Código de Tupay → código normalizado del contrato común. */
function codigoNegocio(code: number): PaymentErrorCode {
  switch (code) {
    case 0:
      return "RED" as const;
    case 100:
    case 102:
      return "CREDENCIALES" as const;
    case 103:
    case 202:
      return "CONFIGURACION_INVALIDA" as const;
    case 104:
    case 402:
      return "REFERENCIA_DUPLICADA" as const;
    case 201:
      return "DATOS_PAGADOR_INVALIDOS" as const;
    case 400:
    case 410:
      return "MONTO_INVALIDO" as const;
    case 203:
    case 408:
      return "LIMITE_EXCEDIDO" as const;
    case 412:
      return "METODO_NO_DISPONIBLE" as const;
    default:
      return "PROVEEDOR" as const;
  }
}
