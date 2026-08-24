import { describe, expect, it } from "vitest";
import {
  aplicaEnvioGratis,
  buscarZonaLima,
  calcularCotizacion,
  CONFIG_ENVIO_DEFECTO,
  faltaParaEnvioGratis,
  normalizarDistrito,
  type ShippingConfig,
} from "./quote";
import type { ShippingQuoteRequest } from "./types";

/** Por debajo del umbral de envío gratis (S/ 250) para aislar el costo base. */
const SUBTOTAL_BAJO = 19_900;
const UMBRAL = CONFIG_ENVIO_DEFECTO.umbralEnvioGratisCents!;

function pedidoLima(distrito: string, subtotalCents = SUBTOTAL_BAJO): ShippingQuoteRequest {
  return { destino: { modo: "lima_domicilio", distrito }, subtotalCents };
}

function pedidoProvincia(subtotalCents = SUBTOTAL_BAJO): ShippingQuoteRequest {
  return {
    destino: {
      modo: "provincia_agencia",
      departamento: "Arequipa",
      provincia: "Arequipa",
      agenciaId: "7",
    },
    subtotalCents,
  };
}

describe("normalizarDistrito", () => {
  it("quita tildes, mayúsculas y espacios sobrantes", () => {
    // Sin esto, "Breña" y "BREÑA" caerían al fallback caro y el cliente lo leería
    // como un sobreprecio arbitrario.
    expect(normalizarDistrito("Breña")).toBe("brena");
    expect(normalizarDistrito("  BREÑA  ")).toBe("brena");
    expect(normalizarDistrito("Jesús  María")).toBe("jesus maria");
    expect(normalizarDistrito("SAN MARTÍN DE PORRES")).toBe("san martin de porres");
  });

  it("devuelve cadena vacía para una entrada vacía", () => {
    expect(normalizarDistrito("   ")).toBe("");
  });
});

describe("buscarZonaLima", () => {
  it("encuentra la zona escriba el cliente como escriba", () => {
    expect(buscarZonaLima("Miraflores")?.nombre).toBe("Lima Centro");
    expect(buscarZonaLima("miraflores")?.nombre).toBe("Lima Centro");
    expect(buscarZonaLima("  MIRAFLORES ")?.nombre).toBe("Lima Centro");
    expect(buscarZonaLima("Breña")?.nombre).toBe("Lima Centro");
  });

  it("distingue las tres zonas", () => {
    expect(buscarZonaLima("San Isidro")?.nombre).toBe("Lima Centro");
    expect(buscarZonaLima("La Molina")?.nombre).toBe("Lima Moderna extendida");
    expect(buscarZonaLima("Comas")?.nombre).toBe("Lima periferia");
  });

  it("devuelve null para un distrito desconocido", () => {
    expect(buscarZonaLima("Cusco")).toBeNull();
    expect(buscarZonaLima("")).toBeNull();
  });

  it("ningún distrito está en dos zonas a la vez", () => {
    const vistos = new Map<string, string>();
    for (const zona of CONFIG_ENVIO_DEFECTO.zonasLima) {
      for (const distrito of zona.distritos) {
        const clave = normalizarDistrito(distrito);
        expect(vistos.has(clave), `${distrito} duplicado`).toBe(false);
        vistos.set(clave, zona.nombre);
      }
    }
  });
});

describe("calcularCotizacion: Lima", () => {
  it("cobra la tarifa de la zona", () => {
    expect(calcularCotizacion(pedidoLima("Miraflores")).costoCents).toBe(1_000);
    expect(calcularCotizacion(pedidoLima("La Molina")).costoCents).toBe(1_500);
    expect(calcularCotizacion(pedidoLima("Comas")).costoCents).toBe(2_000);
  });

  it("un distrito desconocido no bloquea la venta: cobra la tarifa alta y avisa", () => {
    // Rechazar el pedido perdería la venta por un nombre mal escrito.
    const q = calcularCotizacion(pedidoLima("Distrito Inventado"));
    expect(q.costoCents).toBe(CONFIG_ENVIO_DEFECTO.limaFallback.costoCents);
    expect(q.estimado).toBe(true);
    expect(q.detalle).toMatch(/WhatsApp/);
  });

  it("nombra la zona en el detalle cuando la reconoce", () => {
    expect(calcularCotizacion(pedidoLima("Barranco")).detalle).toContain("Lima Centro");
  });

  it("un precio de zona reconocida no es estimado", () => {
    expect(calcularCotizacion(pedidoLima("Barranco")).estimado).toBe(false);
  });
});

describe("calcularCotizacion: provincia", () => {
  it("cobra el estimado de provincia y lo marca como estimado", () => {
    // El flete real lo fija el mostrador según la medida de la caja.
    const q = calcularCotizacion(pedidoProvincia());
    expect(q.costoCents).toBe(CONFIG_ENVIO_DEFECTO.provinciaEstimadoCents);
    expect(q.estimado).toBe(true);
  });

  it("menciona la clave de retiro, que es lo que el cliente necesita saber", () => {
    expect(calcularCotizacion(pedidoProvincia()).detalle).toMatch(/clave de retiro/i);
  });

  it("nombra la provincia de destino", () => {
    expect(calcularCotizacion(pedidoProvincia()).detalle).toContain("Arequipa");
  });
});

describe("calcularCotizacion: recojo en tienda", () => {
  it("es gratis y exacto, no estimado", () => {
    const q = calcularCotizacion({ destino: { modo: "recojo_tienda" }, subtotalCents: 1_000 });
    expect(q.costoCents).toBe(0);
    expect(q.costoBaseCents).toBe(0);
    expect(q.gratis).toBe(true);
    // Cero es exacto: no hay envío que cobrar.
    expect(q.estimado).toBe(false);
  });

  it("es gratis incluso muy por debajo del umbral", () => {
    expect(calcularCotizacion({ destino: { modo: "recojo_tienda" }, subtotalCents: 1 }).gratis).toBe(
      true,
    );
  });
});

describe("umbral de envío gratis", () => {
  it("no aplica justo por debajo del umbral", () => {
    const q = calcularCotizacion(pedidoLima("Miraflores", UMBRAL - 1));
    expect(q.gratis).toBe(false);
    expect(q.costoCents).toBe(1_000);
  });

  it("aplica exactamente en el umbral", () => {
    // La comparación es `>=`: alcanzar el umbral cuenta.
    const q = calcularCotizacion(pedidoLima("Miraflores", UMBRAL));
    expect(q.gratis).toBe(true);
    expect(q.costoCents).toBe(0);
  });

  it("conserva el costo base para poder mostrar el ahorro", () => {
    const q = calcularCotizacion(pedidoLima("Comas", UMBRAL + 5_000));
    expect(q.costoCents).toBe(0);
    expect(q.costoBaseCents).toBe(2_000);
  });

  it("por defecto NO aplica a provincia: el flete se comería el margen", () => {
    const q = calcularCotizacion(pedidoProvincia(UMBRAL + 10_000));
    expect(q.gratis).toBe(false);
    expect(q.costoCents).toBe(CONFIG_ENVIO_DEFECTO.provinciaEstimadoCents);
  });

  it("aplica a provincia si el comerciante lo activa", () => {
    const config: ShippingConfig = { ...CONFIG_ENVIO_DEFECTO, envioGratisAplicaProvincia: true };
    const q = calcularCotizacion(pedidoProvincia(UMBRAL + 1), config);
    expect(q.gratis).toBe(true);
    expect(q.costoCents).toBe(0);
  });

  it("se puede desactivar la promoción por completo", () => {
    const config: ShippingConfig = { ...CONFIG_ENVIO_DEFECTO, umbralEnvioGratisCents: null };
    expect(calcularCotizacion(pedidoLima("Miraflores", 999_999), config).gratis).toBe(false);
    expect(aplicaEnvioGratis(pedidoLima("Miraflores", 999_999), config)).toBe(false);
  });

  it("un distrito desconocido con envío gratis deja de ser estimado", () => {
    // Cero no necesita ajuste posterior.
    const q = calcularCotizacion(pedidoLima("Distrito Inventado", UMBRAL + 1));
    expect(q.gratis).toBe(true);
    expect(q.estimado).toBe(false);
  });
});

describe("faltaParaEnvioGratis", () => {
  it("dice cuánto falta, para subir el ticket medio", () => {
    expect(faltaParaEnvioGratis(UMBRAL - 3_000)).toBe(3_000);
  });

  it("devuelve null cuando ya se alcanzó", () => {
    expect(faltaParaEnvioGratis(UMBRAL)).toBeNull();
    expect(faltaParaEnvioGratis(UMBRAL + 1)).toBeNull();
  });

  it("devuelve null si no hay promoción", () => {
    const config: ShippingConfig = { ...CONFIG_ENVIO_DEFECTO, umbralEnvioGratisCents: null };
    expect(faltaParaEnvioGratis(1_000, config)).toBeNull();
  });

  it("es coherente con aplicaEnvioGratis en todo el rango", () => {
    // Las dos funciones leen la misma configuración: no pueden contradecirse.
    for (let subtotal = UMBRAL - 3; subtotal <= UMBRAL + 3; subtotal++) {
      const gratis = aplicaEnvioGratis(pedidoLima("Miraflores", subtotal));
      expect(faltaParaEnvioGratis(subtotal) === null).toBe(gratis);
    }
  });
});

describe("invariantes de la cotización", () => {
  const casos: readonly ShippingQuoteRequest[] = [
    pedidoLima("Miraflores"),
    pedidoLima("Comas", UMBRAL + 1),
    pedidoLima("Desconocido"),
    pedidoProvincia(),
    pedidoProvincia(UMBRAL + 1),
    { destino: { modo: "recojo_tienda" }, subtotalCents: SUBTOTAL_BAJO },
  ];

  it("todos los importes son céntimos enteros no negativos", () => {
    for (const caso of casos) {
      const q = calcularCotizacion(caso);
      expect(Number.isInteger(q.costoCents)).toBe(true);
      expect(Number.isInteger(q.costoBaseCents)).toBe(true);
      expect(q.costoCents).toBeGreaterThanOrEqual(0);
      expect(q.costoBaseCents).toBeGreaterThanOrEqual(q.costoCents);
    }
  });

  it("gratis implica costo cero, y viceversa salvo el recojo", () => {
    for (const caso of casos) {
      const q = calcularCotizacion(caso);
      if (q.gratis) expect(q.costoCents).toBe(0);
      if (q.costoCents === 0) expect(q.gratis).toBe(true);
    }
  });

  it("siempre hay un plazo y un detalle para mostrar", () => {
    for (const caso of casos) {
      const q = calcularCotizacion(caso);
      expect(q.plazoEstimado.trim()).not.toBe("");
      expect(q.detalle.trim()).not.toBe("");
    }
  });

  it("el modo de la cotización coincide con el pedido", () => {
    for (const caso of casos) {
      expect(calcularCotizacion(caso).modo).toBe(caso.destino.modo);
    }
  });
});
