/**
 * Registro de proveedores de envío.
 *
 * Existe para que el checkout y el panel no importen ninguna implementación
 * concreta, y para que apagar Shalom sea una variable de entorno en vez de un
 * despliegue. En este proyecto eso importa más de lo normal por dos motivos:
 *
 * 1. El proveedor automático habla con un wrapper NO OFICIAL. Cuando Shalom
 *    cambie su web, el camino automático va a fallar de golpe y sin aviso. La
 *    respuesta operativa tiene que ser `SHALOM_ENABLED=false` y seguir
 *    despachando a mano el mismo día, no un hotfix.
 *
 * 2. Las rutas que tocan la cuenta pueden tardar 150 s por el login. En un
 *    despliegue serverless con límite de 10-15 s por función, el proveedor
 *    automático simplemente no puede vivir en el request; hasta que exista un
 *    worker, debe estar apagado aunque las credenciales sean correctas.
 *
 * Por eso el proveedor por defecto es SIEMPRE el manual, y el automático es una
 * mejora que se activa explícitamente.
 */

import { loadShalomConfig, ShalomClient, shalomEstaConfigurada } from "./shalom-client";
import { ManualShippingProvider } from "./manual-provider";
import { ShalomShippingProvider } from "./shalom-provider";
import { CONFIG_ENVIO_DEFECTO, type ShippingConfig } from "./quote";
import type { ShippingProvider, ShippingProviderId } from "./types";

export type ShippingRegistryConfig = {
  /** `true` solo si el flag está activo Y las credenciales están completas. */
  readonly shalomHabilitado: boolean;
  readonly envio: ShippingConfig;
};

/**
 * Configuración desde el entorno.
 *
 * Shalom se considera habilitado únicamente si el flag está activo y la
 * configuración valida. Ofrecer el proveedor automático sin credenciales
 * produciría el fallo después de que el admin ya pulsó "emitir guía", que es el
 * peor momento: en ese punto ya hay un cliente esperando su número.
 */
export function loadShippingRegistryConfig(
  env: NodeJS.ProcessEnv = process.env,
  envio: ShippingConfig = CONFIG_ENVIO_DEFECTO,
): ShippingRegistryConfig {
  return { shalomHabilitado: shalomEstaConfigurada(env), envio };
}

export type ShippingRegistryDeps = {
  readonly config?: ShippingRegistryConfig;
  readonly env?: NodeJS.ProcessEnv;
  /** Inyectable para testear sin red. */
  readonly fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  readonly logger?: { warn(mensaje: string): void; info(mensaje: string): void };
};

export class ProveedorEnvioNoDisponibleError extends Error {
  readonly code = "PROVEEDOR_ENVIO_NO_DISPONIBLE";
  constructor(readonly proveedor: ShippingProviderId) {
    super(`proveedor de envío no disponible: ${proveedor}`);
    this.name = "ProveedorEnvioNoDisponibleError";
  }
}

/**
 * Devuelve el proveedor pedido.
 *
 * Lanza si se pide Shalom estando apagado, en vez de caer al manual en silencio.
 * Un fallback silencioso aquí sería peligroso: quien llama a `getShippingProvider("shalom")`
 * lo hace para emitir una guía, y devolverle un proveedor que no puede emitir
 * haría que el pedido pareciera despachado sin estarlo.
 */
export function getShippingProvider(
  id: ShippingProviderId,
  deps: ShippingRegistryDeps = {},
): ShippingProvider {
  const env = deps.env ?? process.env;
  const config = deps.config ?? loadShippingRegistryConfig(env);

  switch (id) {
    case "manual":
      return new ManualShippingProvider({ config: config.envio });
    case "shalom": {
      if (!config.shalomHabilitado) throw new ProveedorEnvioNoDisponibleError(id);
      return new ShalomShippingProvider({
        client: new ShalomClient({
          config: loadShalomConfig(env),
          ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
          ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
        }),
        config: config.envio,
        ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
      });
    }
  }
}

/**
 * Proveedor por defecto.
 *
 * Siempre el manual. Ver la cabecera de `manual-provider.ts`: no depende de nadie
 * y cubre el flujo real desde el día uno.
 */
export function getDefaultShippingProvider(deps: ShippingRegistryDeps = {}): ShippingProvider {
  return getShippingProvider("manual", deps);
}

export type ProviderResumen = {
  readonly id: ShippingProviderId;
  readonly nombre: string;
  readonly soportaTrackingAutomatico: boolean;
  readonly puedeEmitirGuia: boolean;
  /** Si es la opción recomendada para el panel. */
  readonly recomendado: boolean;
  /** Motivo para mostrar junto a la opción en el panel. */
  readonly nota: string;
};

/**
 * Proveedores disponibles, para pintar el selector del panel.
 *
 * El manual va primero y marcado como recomendado: es la opción sin coste de
 * error y sin dependencias. El automático aparece solo si está encendido y
 * configurado.
 */
export function listAvailableProviders(deps: ShippingRegistryDeps = {}): readonly ProviderResumen[] {
  const env = deps.env ?? process.env;
  const config = deps.config ?? loadShippingRegistryConfig(env);

  const resumenes: ProviderResumen[] = [
    {
      id: "manual",
      nombre: "Envío coordinado (Shalom manual)",
      soportaTrackingAutomatico: false,
      puedeEmitirGuia: false,
      recomendado: true,
      nota: "Emites la guía en la agencia y pegas el número acá. No depende de ningún servicio externo.",
    },
  ];

  if (config.shalomHabilitado) {
    resumenes.push({
      id: "shalom",
      nombre: "Shalom (automático)",
      soportaTrackingAutomatico: true,
      puedeEmitirGuia: true,
      recomendado: false,
      // Se avisa del riesgo en la propia UI: quien elige emitir por API tiene que
      // saber que cada emisión es un cargo real y que el servicio no es oficial.
      nota: "Genera la guía y actualiza el estado solo. Ojo: cada emisión crea una guía cobrable y usa un servicio no oficial.",
    });
  }

  return resumenes;
}

/** ¿Está disponible el camino automático? Para decidir sin lanzar. */
export function trackingAutomaticoDisponible(deps: ShippingRegistryDeps = {}): boolean {
  const env = deps.env ?? process.env;
  const config = deps.config ?? loadShippingRegistryConfig(env);
  return config.shalomHabilitado;
}
