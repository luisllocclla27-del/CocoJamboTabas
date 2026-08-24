import { describe, expect, it } from "vitest";
import { formatSoles } from "@/lib/money";
import { ManualYapeProvider, RESERVA_MINUTOS, totalAYapear } from "./manual-yape-provider";
import type { PaymentIntent } from "./types";

const AHORA = new Date("2026-08-19T10:30:00Z");

const CONFIG = {
  numeroYape: "987 654 321",
  titular: "Luis G.",
};

const INTENT: PaymentIntent = {
  orderId: "0d5b8f1e-1111-2222-3333-444455556666",
  reference: "COCO-7F3K2M",
  amountCents: 24900,
  descripcion: "1 x Nike Air Force 1 talla 42",
  customer: {
    nombres: "Ana",
    apellidos: "Muñoz Peña",
    tipoDocumento: "DNI",
    documento: "12345678",
    email: "ana@example.com",
  },
  urls: {
    success: "https://cocojambo.pe/pedido/ok",
    error: "https://cocojambo.pe/pedido/error",
    back: "https://cocojambo.pe/carrito",
    notification: "https://cocojambo.pe/api/tupay/webhook",
  },
};

function provider(overrides: { centimos?: number; config?: typeof CONFIG } = {}) {
  return new ManualYapeProvider({
    config: overrides.config ?? CONFIG,
    centimosIdentificadores: overrides.centimos ?? 37,
    now: () => AHORA,
  });
}

describe("ManualYapeProvider: contrato", () => {
  it("declara que requiere verificación manual y no cobra comisión", () => {
    const p = provider();
    expect(p.id).toBe("yape_manual");
    // Comisión 0 es la razón de ser de este método: sin intermediario no hay
    // comisión, y con el margen de una tienda pequeña ese ~4% importa.
    expect(p.comisionPorcentaje).toBe(0);
    expect(p.requiereVerificacionManual).toBe(true);
  });

  it("no hace ninguna llamada de red: funciona sin contrato con nadie", async () => {
    // Se sabotea el fetch global para demostrar que no se usa. Es la propiedad que
    // hace de este método la ruta por defecto: si Tupay está caída o su IP no está
    // whitelisteada, esto sigue cobrando.
    const original = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("el Yape manual no debe llamar a ninguna API");
    }) as typeof fetch;
    try {
      const r = await provider().crearIntento(INTENT);
      expect(r.ok).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("ManualYapeProvider.crearIntento", () => {
  it("genera la instrucción con el número del comercio y el monto identificado", async () => {
    const r = await provider().crearIntento(INTENT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.instruccion.tipo).toBe("manual_yape");
    if (r.instruccion.tipo !== "manual_yape") return;

    expect(r.instruccion.numeroYape).toBe("987 654 321");
    expect(r.instruccion.titular).toBe("Luis G.");
    // 24900 con céntimos 37 → 24937: el monto exacto identifica el pedido.
    expect(r.instruccion.montoCents).toBe(24937);
    expect(r.instruccion.centimosIdentificadores).toBe(37);
    expect(r.instruccion.montoFormateado).toBe("S/ 249.37");
    expect(r.instruccion.requiereComprobante).toBe(true);
  });

  it("no crea nada en ningún sistema externo: no hay providerRef", async () => {
    const r = await provider().crearIntento(INTENT);
    expect(r.ok && r.providerRef).toBeNull();
    expect(r.ok && r.comisionCents).toBe(0);
  });

  it("deja el pedido pendiente: el siguiente paso es que el cliente suba el comprobante", async () => {
    const r = await provider().crearIntento(INTENT);
    expect(r.ok && r.estadoPedidoSugerido).toBe("pendiente_pago");
  });

  it("calcula la expiración de la reserva desde el reloj inyectado", async () => {
    const r = await provider().crearIntento(INTENT);
    if (!r.ok || r.instruccion.tipo !== "manual_yape") throw new Error("intento fallido");
    expect(r.instruccion.expiraEn.toISOString()).toBe("2026-08-19T11:00:00.000Z");
    expect(RESERVA_MINUTOS).toBe(30);
  });

  it("respeta una ventana de reserva personalizada", async () => {
    const p = new ManualYapeProvider({
      config: { ...CONFIG, reservaMinutos: 15 },
      centimosIdentificadores: 37,
      now: () => AHORA,
    });
    const r = await p.crearIntento(INTENT);
    if (!r.ok || r.instruccion.tipo !== "manual_yape") throw new Error("intento fallido");
    expect(r.instruccion.expiraEn.toISOString()).toBe("2026-08-19T10:45:00.000Z");
    expect(r.instruccion.pasos.some((paso) => paso.includes("15 minutos"))).toBe(true);
  });

  it("los pasos dicen el monto exacto y explican por qué tiene céntimos raros", async () => {
    const r = await provider().crearIntento(INTENT);
    if (!r.ok || r.instruccion.tipo !== "manual_yape") throw new Error("intento fallido");
    const pasos = r.instruccion.pasos.join(" ");
    expect(pasos).toContain("S/ 249.37");
    expect(pasos).toContain("987 654 321");
    // El cliente no tiene que copiar ningún código: hay que decírselo, o intentará
    // escribir la referencia en el mensaje del Yape.
    expect(pasos).toMatch(/sin que escribas ning[úu]n c[óo]digo/i);
    expect(r.instruccion.pasos.length).toBeGreaterThanOrEqual(4);
  });

  it("nunca cobra menos que el precio real al sustituir los céntimos", async () => {
    // 24950 con céntimos 37 daría 24937, que es MENOS que el precio: hay que subir
    // un sol. Regla de `applyPaymentCents`, verificada aquí de punta a punta.
    const r = await provider({ centimos: 37 }).crearIntento({
      ...INTENT,
      amountCents: 24950,
    });
    if (!r.ok || r.instruccion.tipo !== "manual_yape") throw new Error("intento fallido");
    expect(r.instruccion.montoCents).toBe(25037);
    expect(r.instruccion.montoCents).toBeGreaterThanOrEqual(24950);
  });

  it("el total sigue siendo un entero de céntimos para cualquier combinación", async () => {
    for (let base = 8000; base <= 8200; base++) {
      for (const centimos of [1, 37, 99]) {
        const r = await provider({ centimos }).crearIntento({ ...INTENT, amountCents: base });
        if (!r.ok || r.instruccion.tipo !== "manual_yape") throw new Error("intento fallido");
        expect(Number.isInteger(r.instruccion.montoCents)).toBe(true);
        expect(r.instruccion.montoCents).toBeGreaterThanOrEqual(base);
        expect(r.instruccion.montoCents % 100).toBe(centimos);
        expect(r.instruccion.montoFormateado).toBe(formatSoles(r.instruccion.montoCents));
      }
    }
  });

  it("falla como configuración inválida si falta el número o el titular", async () => {
    // Sin número no hay a dónde yapear: mejor un error claro que una pantalla de
    // pago con un hueco donde debería ir el celular.
    for (const config of [
      { numeroYape: "", titular: "Luis G." },
      { numeroYape: "987 654 321", titular: "  " },
    ]) {
      const r = await provider({ config }).crearIntento(INTENT);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.codigo).toBe("CONFIGURACION_INVALIDA");
      expect(r.error.mensajeTecnico).toMatch(/YAPE_NUMERO|YAPE_TITULAR/);
      // El mensaje al cliente ofrece una salida, no un código de error.
      expect(r.error.mensajeCliente).toMatch(/WhatsApp/);
    }
  });

  it("falla con monto inválido si los céntimos identificadores están fuera de rango", async () => {
    // El 00 se evita a propósito: un total redondo es indistinguible de un pago sin
    // identificar.
    for (const centimos of [0, 100, -1, 1.5]) {
      const r = await provider({ centimos }).crearIntento(INTENT);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.codigo).toBe("MONTO_INVALIDO");
    }
  });

  it("no filtra datos del cliente en el mensaje de error", async () => {
    const r = await provider({ centimos: 0 }).crearIntento(INTENT);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const texto = `${r.error.mensajeCliente} ${r.error.mensajeTecnico}`;
    for (const dato of ["12345678", "ana@example.com"]) {
      expect(texto).not.toContain(dato);
    }
  });
});

describe("ManualYapeProvider.consultarEstado", () => {
  it("devuelve pendiente en vez de lanzar: no hay API que consultar", async () => {
    // Así el llamador puede preguntar el estado de cualquier pedido sin ramificar
    // por método de pago.
    const r = await provider().consultarEstado("COCO-7F3K2M");
    expect(r.estado).toBe("pendiente");
    expect(r.providerRef).toBe("COCO-7F3K2M");
    expect(r.montoCents).toBeNull();
    expect(r.detalle).toMatch(/administrador/i);
  });
});

describe("totalAYapear", () => {
  it("permite mostrar el total antes de crear el intento", () => {
    expect(totalAYapear(24900, 37)).toBe(24937);
    expect(totalAYapear(24950, 37)).toBe(25037);
  });
});
