import { describe, expect, it } from "vitest";
import { percentOf } from "@/lib/money";
import { ManualYapeProvider } from "./manual-yape-provider";
import {
  DESCUENTO_YAPE_PORCENTAJE,
  descuentoYapeCents,
  getPaymentProvider,
  hayMetodoDisponible,
  listAvailableProviders,
  loadPaymentsConfig,
  MetodoPagoNoDisponibleError,
  totalConDescuentoYape,
} from "./registry";
import { TupayProvider, TUPAY_COMISION_PORCENTAJE } from "./tupay-provider";

const ENV_SOLO_YAPE: Record<string, string | undefined> = {
  YAPE_NUMERO: "987 654 321",
  YAPE_TITULAR: "Luis G.",
};

const ENV_CON_TUPAY: Record<string, string | undefined> = {
  ...ENV_SOLO_YAPE,
  PAYMENTS_TUPAY_ENABLED: "true",
  TUPAY_API_KEY: "api-key-de-prueba",
  TUPAY_API_SECRET: "signature-de-prueba",
  TUPAY_BASE_URL: "https://api-stg.tupayonline.com",
  TUPAY_TEST_MODE: "true",
};

const BASE = 24900;

describe("loadPaymentsConfig", () => {
  it("deja Tupay apagada por defecto", () => {
    // Por defecto seguro: Tupay exige whitelisting de IP de salida, así que en un
    // entorno nuevo (o serverless) no debe ofrecerse sin decisión explícita.
    expect(loadPaymentsConfig(ENV_SOLO_YAPE).tupayHabilitado).toBe(false);
  });

  it("habilita Tupay sólo si el flag está activo Y las credenciales están completas", () => {
    expect(loadPaymentsConfig(ENV_CON_TUPAY).tupayHabilitado).toBe(true);
    // Flag activo pero sin secret: ofrecerla produciría un fallo justo después de
    // que el cliente eligió el método, que es el peor momento.
    expect(
      loadPaymentsConfig({ ...ENV_CON_TUPAY, TUPAY_API_SECRET: "" }).tupayHabilitado,
    ).toBe(false);
    expect(
      loadPaymentsConfig({ ...ENV_CON_TUPAY, PAYMENTS_TUPAY_ENABLED: "false" }).tupayHabilitado,
    ).toBe(false);
  });

  it("acepta las grafías habituales del flag", () => {
    for (const valor of ["1", "true", "TRUE", "yes", "si", "sí", "on"]) {
      expect(
        loadPaymentsConfig({ ...ENV_CON_TUPAY, PAYMENTS_TUPAY_ENABLED: valor }).tupayHabilitado,
      ).toBe(true);
    }
    for (const valor of ["0", "false", "no", "off", ""]) {
      expect(
        loadPaymentsConfig({ ...ENV_CON_TUPAY, PAYMENTS_TUPAY_ENABLED: valor }).tupayHabilitado,
      ).toBe(false);
    }
  });

  it("usa una zona de contraentrega por defecto", () => {
    expect(loadPaymentsConfig({}).zonaContraentrega).toBe("Lima Metropolitana");
    expect(
      loadPaymentsConfig({ PAYMENTS_CONTRAENTREGA_ZONA: "Trujillo" }).zonaContraentrega,
    ).toBe("Trujillo");
  });
});

describe("descuento por pago directo con Yape", () => {
  it("aplica el porcentaje con percentOf, en céntimos enteros", () => {
    expect(descuentoYapeCents(BASE)).toBe(percentOf(BASE, DESCUENTO_YAPE_PORCENTAJE));
    expect(descuentoYapeCents(BASE)).toBe(747);
    expect(totalConDescuentoYape(BASE)).toBe(24153);
  });

  it("el descuento es menor que la comisión de la pasarela", () => {
    // La diferencia paga el trabajo de validar screenshots a mano: si el descuento
    // igualara la comisión, el método "barato" saldría más caro contando el tiempo
    // del admin.
    expect(DESCUENTO_YAPE_PORCENTAJE).toBeLessThan(TUPAY_COMISION_PORCENTAJE);
  });

  it("nunca produce decimales ni un total mayor que el precio de lista", () => {
    for (let base = 0; base <= 50_000; base += 7) {
      const total = totalConDescuentoYape(base);
      expect(Number.isInteger(total)).toBe(true);
      expect(total).toBeLessThanOrEqual(base);
      expect(total + descuentoYapeCents(base)).toBe(base);
    }
  });
});

describe("listAvailableProviders", () => {
  it("ofrece sólo Yape cuando Tupay está apagada", () => {
    const lista = listAvailableProviders({ env: ENV_SOLO_YAPE, baseCents: BASE });
    expect(lista.map((p) => p.id)).toEqual(["yape_manual"]);
  });

  it("presenta el precio de Yape con DESCUENTO, no el de tarjeta con recargo", () => {
    // Decisión de negocio: las reglas de Visa/Mastercard restringen los recargos
    // por uso de tarjeta. Un descuento por medio alternativo sí está permitido y
    // además convierte mejor.
    const lista = listAvailableProviders({ env: ENV_CON_TUPAY, baseCents: BASE });
    const yape = lista.find((p) => p.id === "yape_manual");
    const tupay = lista.find((p) => p.id === "tupay");

    expect(yape?.totalCents).toBe(24153);
    expect(yape?.ahorroCents).toBe(747);
    expect(yape?.descuentoPorcentaje).toBe(DESCUENTO_YAPE_PORCENTAJE);

    // Tupay cobra el precio de lista: ningún recargo visible.
    expect(tupay?.totalCents).toBe(BASE);
    expect(tupay?.ahorroCents).toBe(0);
    expect(tupay?.descuentoPorcentaje).toBe(0);
    expect(tupay!.totalCents).toBeGreaterThan(yape!.totalCents);
  });

  it("no menciona la comisión en el texto que ve el cliente", () => {
    const lista = listAvailableProviders({ env: ENV_CON_TUPAY, baseCents: BASE });
    const tupay = lista.find((p) => p.id === "tupay");
    expect(tupay?.nota).not.toMatch(/comisi[óo]n|recargo|3\.99|4%/i);
    expect(tupay?.nota).toMatch(/inmediata/i);
    // La ventaja de Yape sí se dice explícitamente: es lo que se quiere empujar.
    expect(lista.find((p) => p.id === "yape_manual")?.nota).toMatch(/descuento/i);
  });

  it("recomienda Yape cuando está disponible", () => {
    const lista = listAvailableProviders({ env: ENV_CON_TUPAY, baseCents: BASE });
    expect(lista[0].id).toBe("yape_manual");
    expect(lista[0].recomendado).toBe(true);
    expect(lista.find((p) => p.id === "tupay")?.recomendado).toBe(false);
  });

  it("recomienda Tupay sólo si el Yape manual no está configurado", () => {
    const lista = listAvailableProviders({
      env: { ...ENV_CON_TUPAY, YAPE_NUMERO: "" },
      baseCents: BASE,
    });
    expect(lista.map((p) => p.id)).toEqual(["tupay"]);
    expect(lista[0].recomendado).toBe(true);
  });

  it("incluye contraentrega con su zona cuando está habilitada", () => {
    const lista = listAvailableProviders({
      env: { ...ENV_SOLO_YAPE, PAYMENTS_CONTRAENTREGA_ENABLED: "true" },
      baseCents: BASE,
    });
    const contraentrega = lista.find((p) => p.id === "contraentrega");
    expect(contraentrega?.nota).toContain("Lima Metropolitana");
    expect(contraentrega?.totalCents).toBe(BASE);
    expect(contraentrega?.recomendado).toBe(false);
  });

  it("devuelve la lista vacía si no hay nada configurado", () => {
    // El checkout no debe abrirse en este estado.
    expect(listAvailableProviders({ env: {}, baseCents: BASE })).toEqual([]);
    expect(hayMetodoDisponible({ env: {}, baseCents: BASE })).toBe(false);
    expect(hayMetodoDisponible({ env: ENV_SOLO_YAPE, baseCents: BASE })).toBe(true);
  });

  it("marca correctamente qué métodos exigen revisión humana", () => {
    const lista = listAvailableProviders({ env: ENV_CON_TUPAY, baseCents: BASE });
    expect(lista.find((p) => p.id === "yape_manual")?.requiereVerificacionManual).toBe(true);
    expect(lista.find((p) => p.id === "tupay")?.requiereVerificacionManual).toBe(false);
  });
});

describe("getPaymentProvider", () => {
  it("construye el provider de Yape manual con los céntimos reservados", () => {
    const p = getPaymentProvider("yape_manual", {
      env: ENV_SOLO_YAPE,
      centimosIdentificadores: 37,
    });
    expect(p).toBeInstanceOf(ManualYapeProvider);
    expect(p.id).toBe("yape_manual");
  });

  it("exige los céntimos identificadores: no los elige él", () => {
    // La unicidad sólo puede garantizarla la transacción que los escribe en la
    // base; elegirlos aquí abriría una carrera entre dos checkouts simultáneos.
    expect(() => getPaymentProvider("yape_manual", { env: ENV_SOLO_YAPE })).toThrow(/céntimos/);
  });

  it("construye el provider de Tupay cuando está habilitada", () => {
    const p = getPaymentProvider("tupay", {
      env: ENV_CON_TUPAY,
      fetchImpl: async () => {
        throw new Error("no debe llamarse al construir");
      },
    });
    expect(p).toBeInstanceOf(TupayProvider);
    expect(p.requiereVerificacionManual).toBe(false);
    expect(p.comisionPorcentaje).toBe(TUPAY_COMISION_PORCENTAJE);
  });

  it("lanza si se pide Tupay estando apagada", () => {
    // Llegar aquí con un método deshabilitado significa que la UI está
    // desincronizada o que alguien manipuló el formulario: hay que parar, no
    // elegir un método en su nombre.
    expect(() => getPaymentProvider("tupay", { env: ENV_SOLO_YAPE })).toThrow(
      MetodoPagoNoDisponibleError,
    );
  });

  it("lanza si se pide Tupay con el flag activo pero sin credenciales", () => {
    expect(() =>
      getPaymentProvider("tupay", { env: { ...ENV_CON_TUPAY, TUPAY_API_KEY: "" } }),
    ).toThrow(MetodoPagoNoDisponibleError);
  });

  it("contraentrega no pasa por el registry de pagos", () => {
    // No crea ningún cobro: lo gestiona logística. Modelarlo como cobro forzaría a
    // PaymentProvider a representar algo que ocurre en la puerta del cliente.
    expect(() =>
      getPaymentProvider("contraentrega", {
        env: { ...ENV_SOLO_YAPE, PAYMENTS_CONTRAENTREGA_ENABLED: "true" },
      }),
    ).toThrow(MetodoPagoNoDisponibleError);
  });

  it("acepta una configuración explícita sin leer el entorno", () => {
    const p = getPaymentProvider("yape_manual", {
      config: {
        yape: { numeroYape: "999 999 999", titular: "Otro" },
        tupayHabilitado: false,
        contraentregaHabilitado: false,
        zonaContraentrega: "Arequipa",
      },
      centimosIdentificadores: 12,
    });
    expect(p.id).toBe("yape_manual");
  });
});
