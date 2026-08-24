/**
 * Registro de métodos de pago.
 *
 * Existe para que el checkout no importe ninguna implementación concreta y para
 * que encender o apagar Tupay sea una variable de entorno, no un despliegue de
 * código. Es importante para este proyecto en particular: Tupay exige
 * whitelisting de IP de salida (ver `tupay-client.ts`), así que hay entornos —
 * cualquier despliegue serverless — donde debe estar apagada aunque las
 * credenciales existan. `PAYMENTS_TUPAY_ENABLED=false` cubre ese caso sin tocar
 * nada más.
 *
 * DECISIÓN DE NEGOCIO: descuento por Yape, no recargo por tarjeta.
 *
 * La comisión de la pasarela (~4%) hay que absorberla o pasarla al cliente. La
 * forma intuitiva sería recargar un 4% a quien paga con tarjeta, pero las reglas
 * de Visa y Mastercard restringen los recargos por uso de tarjeta (surcharging):
 * según el mercado y el contrato con el adquirente van desde estar limitadas a
 * estar directamente prohibidas, y una infracción puede costar la cuenta de
 * comercio. Además, un recargo visible en el último paso del checkout es una de
 * las principales causas de abandono.
 *
 * Por eso el precio de lista incluye la comisión y se presenta un DESCUENTO por
 * pagar con Yape directo. Es equivalente en aritmética, cumple las reglas de las
 * marcas (un descuento por medio de pago alternativo sí está permitido) y en
 * lugar de castigar a un cliente premia a otro, que convierte mejor. El efecto
 * secundario buscado: empuja al método sin comisión y sin dependencia de
 * terceros.
 */

import { percentOf, type Cents } from "@/lib/money";
import { ManualYapeProvider, type YapeManualConfig } from "./manual-yape-provider";
import { loadTupayConfig, TupayClient, tupayEstaConfigurada, type EnvVars, type FetchLike } from "./tupay-client";
import { TupayProvider, TUPAY_COMISION_PORCENTAJE } from "./tupay-provider";
import type { PaymentMethod, PaymentProvider } from "./types";

/**
 * Descuento por pagar con Yape directo, en porcentaje.
 *
 * Es menor que la comisión de la pasarela (3.99%) a propósito: la diferencia
 * paga el trabajo de validar screenshots a mano. Si fuera igual o mayor, el
 * método "barato" saldría más caro que el automático en cuanto se cuenta el
 * tiempo del admin.
 */
export const DESCUENTO_YAPE_PORCENTAJE = 3;

export type PaymentsConfig = {
  readonly yape: YapeManualConfig;
  readonly tupayHabilitado: boolean;
  readonly contraentregaHabilitado: boolean;
  /** Zona donde se ofrece contraentrega. Se muestra tal cual al cliente. */
  readonly zonaContraentrega: string;
};

/** ¿Está la variable en "true"? Mismo criterio que en `tupay-client.ts`. */
function flag(valor: string | undefined, porDefecto: boolean): boolean {
  if (valor === undefined || valor.trim() === "") return porDefecto;
  return ["1", "true", "yes", "si", "sí", "on"].includes(valor.trim().toLowerCase());
}

/**
 * Configuración de pagos desde el entorno.
 *
 * Tupay se considera habilitada sólo si el flag está activo Y las credenciales
 * están completas. Ofrecerla en el checkout sin credenciales produciría un fallo
 * después de que el cliente ya eligió el método, que es el peor momento.
 */
export function loadPaymentsConfig(env: EnvVars = process.env): PaymentsConfig {
  return {
    yape: {
      numeroYape: env.YAPE_NUMERO ?? "",
      titular: env.YAPE_TITULAR ?? "",
    },
    tupayHabilitado: flag(env.PAYMENTS_TUPAY_ENABLED, false) && tupayEstaConfigurada(env),
    contraentregaHabilitado: flag(env.PAYMENTS_CONTRAENTREGA_ENABLED, false),
    zonaContraentrega: env.PAYMENTS_CONTRAENTREGA_ZONA ?? "Lima Metropolitana",
  };
}

/** Datos para pintar la lista de métodos en el checkout. */
export type ProviderResumen = {
  readonly id: PaymentMethod;
  readonly nombre: string;
  readonly requiereVerificacionManual: boolean;
  readonly comisionPorcentaje: number;
  /** Descuento aplicado a este método, en porcentaje. */
  readonly descuentoPorcentaje: number;
  /** Total que paga el cliente con este método. */
  readonly totalCents: Cents;
  readonly ahorroCents: Cents;
  /** Motivo para mostrar junto al método. Vende la ventaja o advierte el coste. */
  readonly nota: string;
  /** Si el método es la recomendación por defecto. */
  readonly recomendado: boolean;
};

export type RegistryDeps = {
  readonly config?: PaymentsConfig;
  /**
   * Céntimos identificadores ya reservados en la base para este pedido. Sólo lo
   * necesita el Yape manual. Se exige explícitamente en vez de generarlo aquí
   * porque la unicidad la garantiza la transacción que los escribe.
   */
  readonly centimosIdentificadores?: number;
  readonly fetchImpl?: FetchLike;
  readonly env?: EnvVars;
  readonly now?: () => Date;
};

export class MetodoPagoNoDisponibleError extends Error {
  readonly code = "METODO_PAGO_NO_DISPONIBLE";
  constructor(readonly metodo: PaymentMethod) {
    super(`método de pago no disponible: ${metodo}`);
    this.name = "MetodoPagoNoDisponibleError";
  }
}

/**
 * Devuelve el provider de un método.
 *
 * Lanza si el método está apagado en configuración: llegar aquí con un método
 * deshabilitado significa que el cliente manipuló el formulario o que la UI está
 * desincronizada, y en ambos casos hay que parar, no elegir un método por él.
 */
export function getPaymentProvider(
  method: PaymentMethod,
  deps: RegistryDeps = {},
): PaymentProvider {
  const env = deps.env ?? process.env;
  const config = deps.config ?? loadPaymentsConfig(env);

  switch (method) {
    case "yape_manual": {
      if (deps.centimosIdentificadores === undefined) {
        throw new Error(
          "yape_manual requiere los céntimos identificadores reservados para el pedido",
        );
      }
      return new ManualYapeProvider({
        config: config.yape,
        centimosIdentificadores: deps.centimosIdentificadores,
        ...(deps.now !== undefined ? { now: deps.now } : {}),
      });
    }
    case "tupay": {
      if (!config.tupayHabilitado) throw new MetodoPagoNoDisponibleError(method);
      return new TupayProvider({
        client: new TupayClient({
          config: loadTupayConfig(env),
          ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
          ...(deps.now !== undefined ? { now: deps.now } : {}),
        }),
      });
    }
    case "contraentrega":
      // Contraentrega no crea ningún cobro: lo gestiona logística, no pagos. Se
      // deja fuera del registry a propósito para no obligar a `PaymentProvider` a
      // modelar un cobro que ocurre en la puerta del cliente. Otro módulo
      // (`src/lib/shipping/`) es el dueño de ese flujo.
      throw new MetodoPagoNoDisponibleError(method);
  }
}

/**
 * Total con el descuento por pago directo aplicado.
 *
 * `percentOf` redondea al céntimo, así que el resultado sigue siendo un entero
 * de céntimos y no arrastra decimales a la base.
 */
export function totalConDescuentoYape(baseCents: Cents): Cents {
  return baseCents - descuentoYapeCents(baseCents);
}

export function descuentoYapeCents(baseCents: Cents): Cents {
  return percentOf(baseCents, DESCUENTO_YAPE_PORCENTAJE);
}

/**
 * Métodos disponibles con su precio final, para pintar el checkout.
 *
 * Ordena poniendo primero el recomendado. El Yape manual es el recomendado por
 * defecto: es el más barato para el cliente, el único sin comisión para el
 * negocio y el único que no depende de un tercero.
 */
export function listAvailableProviders(deps: RegistryDeps & { baseCents: Cents }): ProviderResumen[] {
  const env = deps.env ?? process.env;
  const config = deps.config ?? loadPaymentsConfig(env);
  const { baseCents } = deps;
  const resumenes: ProviderResumen[] = [];

  const yapeConfigurado = config.yape.numeroYape.trim() !== "" && config.yape.titular.trim() !== "";
  if (yapeConfigurado) {
    const ahorro = descuentoYapeCents(baseCents);
    resumenes.push({
      id: "yape_manual",
      nombre: "Yape directo",
      requiereVerificacionManual: true,
      comisionPorcentaje: 0,
      descuentoPorcentaje: DESCUENTO_YAPE_PORCENTAJE,
      totalCents: baseCents - ahorro,
      ahorroCents: ahorro,
      nota: `${DESCUENTO_YAPE_PORCENTAJE}% de descuento por pagar directo. Validamos tu pago en minutos.`,
      recomendado: true,
    });
  }

  if (config.tupayHabilitado) {
    resumenes.push({
      id: "tupay",
      nombre: "Yape, Plin o tarjeta (automático)",
      requiereVerificacionManual: false,
      comisionPorcentaje: TUPAY_COMISION_PORCENTAJE,
      descuentoPorcentaje: 0,
      totalCents: baseCents,
      ahorroCents: 0,
      // Se vende la ventaja real (inmediatez) sin mencionar la comisión: el
      // cliente paga el precio de lista, no un recargo.
      nota: "Confirmación inmediata, sin subir captura.",
      // Sólo es la recomendación si el Yape manual no está disponible.
      recomendado: !yapeConfigurado,
    });
  }

  if (config.contraentregaHabilitado) {
    resumenes.push({
      id: "contraentrega",
      nombre: "Pago contra entrega",
      requiereVerificacionManual: true,
      comisionPorcentaje: 0,
      descuentoPorcentaje: 0,
      totalCents: baseCents,
      ahorroCents: 0,
      nota: `Solo en ${config.zonaContraentrega}. Pagas al recibir.`,
      recomendado: false,
    });
  }

  return resumenes.sort((a, b) => Number(b.recomendado) - Number(a.recomendado));
}

/** ¿Hay al menos un método con el que cobrar? Si no, el checkout no debe abrirse. */
export function hayMetodoDisponible(deps: RegistryDeps & { baseCents: Cents }): boolean {
  return listAvailableProviders(deps).length > 0;
}
