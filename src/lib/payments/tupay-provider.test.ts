/**
 * `TupayProvider` no estaba en la lista de tests pedida, pero es donde vive la
 * traducción entre nuestro dominio y el body de Tupay: un error aquí produce un
 * 201 en producción o un QR que no se pinta. Se prueba con `fetch` inyectado,
 * sin red.
 */

import { describe, expect, it } from "vitest";
import { codigoParaCanal, normalizarEstadoTupay, TupayProvider } from "./tupay-provider";
import { TupayClient, type FetchLike, type TupayConfig } from "./tupay-client";
import type { PaymentIntent } from "./types";

const CONFIG: TupayConfig = {
  apiKey: "api-key-de-prueba",
  apiSecret: "signature-de-prueba",
  baseUrl: "https://api-stg.tupayonline.com",
  testMode: true,
};

const INTENT: PaymentIntent = {
  orderId: "0d5b8f1e-1111-2222-3333-444455556666",
  reference: "COCO-7F3K2M",
  amountCents: 24937,
  descripcion: "1 x Nike Air Force 1 talla 42",
  customer: {
    nombres: "Ana",
    apellidos: "Muñoz Peña",
    tipoDocumento: "DNI",
    documento: "12345678",
    email: "ana@example.com",
    telefono: "+51987654321",
  },
  urls: {
    success: "https://cocojambo.pe/pedido/ok",
    error: "https://cocojambo.pe/pedido/error",
    back: "https://cocojambo.pe/carrito",
    notification: "https://cocojambo.pe/api/tupay/webhook",
  },
};

function respuestaOk(overrides: Record<string, unknown> = {}) {
  return {
    checkout_type: "ONE_SHOT",
    redirect_url: "https://checkout.tupayonline.com/abc",
    iframe: false,
    deposit_id: "dep_123",
    merchant_invoice_id: "COCO-7F3K2M",
    payment_info: {
      amount: 249.37,
      currency: "PEN",
      expiration_date: "2026-08-19T11:00:00Z",
      multigateway_metadata: [],
    },
    ...overrides,
  };
}

function conRespuesta(cuerpo: unknown, status = 201) {
  const cuerpos: string[] = [];
  const impl: FetchLike = async (_url, init) => {
    cuerpos.push((init?.body as string) ?? "");
    return new Response(JSON.stringify(cuerpo), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
  const provider = new TupayProvider({
    client: new TupayClient({
      config: CONFIG,
      fetchImpl: impl,
      sleep: async () => {},
      now: () => new Date("2026-08-19T10:30:00Z"),
    }),
  });
  return { provider, cuerpos };
}

describe("TupayProvider: contrato", () => {
  it("declara que no requiere verificación manual y cobra comisión", () => {
    const { provider } = conRespuesta(respuestaOk());
    expect(provider.id).toBe("tupay");
    expect(provider.requiereVerificacionManual).toBe(false);
    expect(provider.comisionPorcentaje).toBeGreaterThan(0);
  });
});

describe("codigoParaCanal", () => {
  it("traduce la preferencia de la UI al código de Tupay", () => {
    expect(codigoParaCanal(undefined)).toBe("XA");
    expect(codigoParaCanal("cualquiera")).toBe("XA");
    expect(codigoParaCanal("qr")).toBe("XAQR");
    expect(codigoParaCanal("yape")).toBe("XAYP");
    expect(codigoParaCanal("plin")).toBe("XAPL");
    expect(codigoParaCanal("tarjeta")).toBe("XACC");
    expect(codigoParaCanal("efectivo")).toBe("XABT");
    expect(codigoParaCanal("transferencia")).toBe("XAIN");
  });
});

describe("TupayProvider.crearIntento: body", () => {
  it("traduce el intento al body de Tupay, con el monto en soles", async () => {
    const { provider, cuerpos } = conRespuesta(respuestaOk());
    await provider.crearIntento({ ...INTENT, canal: "yape" });

    const body = JSON.parse(cuerpos[0]) as Record<string, unknown>;
    expect(body.country).toBe("PE");
    expect(body.currency).toBe("PEN");
    // 24937 céntimos → 249.37 soles, no 24937.
    expect(body.amount).toBe(249.37);
    expect(body.payment_method).toBe("XAYP");
    expect(body.invoice_id).toBe("COCO-7F3K2M");
    expect(body.notification_url).toBe(INTENT.urls.notification);
    expect(body.success_url).toBe(INTENT.urls.success);
    expect(body.back_url).toBe(INTENT.urls.back);
    expect(body.error_url).toBe(INTENT.urls.error);
    expect(body.test).toBe(true);
    expect(body.payer).toMatchObject({
      first_name: "Ana",
      last_name: "Muñoz Peña",
      document: "12345678",
      document_type: "DNI",
      email: "ana@example.com",
      phone: "+51987654321",
    });
  });

  it("omite los opcionales vacíos en vez de mandarlos como cadena vacía", async () => {
    // `"phone": ""` es un 201 BEAN_VALIDATION_ERROR; omitir la clave es válido.
    const { provider, cuerpos } = conRespuesta(respuestaOk());
    await provider.crearIntento({
      ...INTENT,
      customer: { ...INTENT.customer, telefono: "", direccion: "  " },
      clientIp: "",
    });
    const body = JSON.parse(cuerpos[0]) as { payer: Record<string, unknown> };
    expect(body.payer).not.toHaveProperty("phone");
    expect(body.payer).not.toHaveProperty("address");
    expect(body).not.toHaveProperty("client_ip");
  });

  it("incluye client_ip y mobile cuando se conocen", async () => {
    const { provider, cuerpos } = conRespuesta(respuestaOk());
    await provider.crearIntento({ ...INTENT, clientIp: "190.0.0.1", mobile: true });
    const body = JSON.parse(cuerpos[0]) as Record<string, unknown>;
    expect(body.client_ip).toBe("190.0.0.1");
    expect(body.mobile).toBe(true);
  });
});

describe("TupayProvider.crearIntento: validación local", () => {
  it("rechaza un DNI con longitud incorrecta sin llamar a la API", async () => {
    // Evita un round-trip a un error 201 previsible.
    const { provider, cuerpos } = conRespuesta(respuestaOk());
    const r = await provider.crearIntento({
      ...INTENT,
      customer: { ...INTENT.customer, documento: "1234" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.codigo).toBe("DATOS_PAGADOR_INVALIDOS");
      expect(r.error.mensajeCliente).toMatch(/8 dígitos/);
    }
    expect(cuerpos).toHaveLength(0);
  });

  it("valida cada tipo de documento con su longitud", async () => {
    const { provider } = conRespuesta(respuestaOk());
    const casos = [
      { tipo: "DNI", bueno: "12345678", malo: "1234567" },
      { tipo: "RUC", bueno: "12345678901", malo: "1234567890" },
      { tipo: "CE", bueno: "AB12345678", malo: "AB123" },
      { tipo: "PASS", bueno: "X12345678", malo: "X1234" },
    ] as const;
    for (const caso of casos) {
      const bueno = await provider.crearIntento({
        ...INTENT,
        customer: { ...INTENT.customer, tipoDocumento: caso.tipo, documento: caso.bueno },
      });
      expect(bueno.ok, `${caso.tipo} válido`).toBe(true);
      const malo = await provider.crearIntento({
        ...INTENT,
        customer: { ...INTENT.customer, tipoDocumento: caso.tipo, documento: caso.malo },
      });
      expect(malo.ok, `${caso.tipo} inválido`).toBe(false);
    }
  });

  it("no filtra el documento del cliente en el mensaje técnico", async () => {
    const { provider } = conRespuesta(respuestaOk());
    const r = await provider.crearIntento({
      ...INTENT,
      customer: { ...INTENT.customer, documento: "9999" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.mensajeTecnico).not.toContain("9999");
  });

  it("rechaza nombre, apellido o email vacíos o mal formados", async () => {
    const { provider, cuerpos } = conRespuesta(respuestaOk());
    for (const customer of [
      { ...INTENT.customer, nombres: "" },
      { ...INTENT.customer, apellidos: "  " },
      { ...INTENT.customer, email: "no-es-email" },
    ]) {
      const r = await provider.crearIntento({ ...INTENT, customer });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.codigo).toBe("DATOS_PAGADOR_INVALIDOS");
    }
    expect(cuerpos).toHaveLength(0);
  });

  it("rechaza un monto por debajo del mínimo de Tupay y sugiere Yape", async () => {
    const { provider, cuerpos } = conRespuesta(respuestaOk());
    const r = await provider.crearIntento({ ...INTENT, amountCents: 500 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.codigo).toBe("MONTO_INVALIDO");
      expect(r.error.mensajeCliente).toMatch(/Yape directo/);
    }
    expect(cuerpos).toHaveLength(0);
  });

  it("rechaza un monto que no es entero de céntimos", async () => {
    const { provider } = conRespuesta(respuestaOk());
    for (const amountCents of [0, -100, 249.5]) {
      const r = await provider.crearIntento({ ...INTENT, amountCents });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.codigo).toBe("MONTO_INVALIDO");
    }
  });
});

describe("TupayProvider.crearIntento: instrucción", () => {
  it("devuelve una redirección con el deposit_id como providerRef", async () => {
    const { provider } = conRespuesta(respuestaOk());
    const r = await provider.crearIntento(INTENT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.providerRef).toBe("dep_123");
    expect(r.instruccion.tipo).toBe("redirect");
    if (r.instruccion.tipo !== "redirect") return;
    expect(r.instruccion.url).toBe("https://checkout.tupayonline.com/abc");
    expect(r.instruccion.pedirDatosEnPasarela).toBe(false);
    expect(r.instruccion.expiraEn?.toISOString()).toBe("2026-08-19T11:00:00.000Z");
  });

  it("extrae el QR de multigateway_metadata cuando el canal es de QR", async () => {
    // Pintar el QR en nuestro dominio evita el "¿esta página es de verdad?".
    const { provider } = conRespuesta(
      respuestaOk({
        payment_info: {
          expiration_date: "2026-08-19T11:00:00Z",
          multigateway_metadata: [
            { paymentMethodType: "BANK_TRANSFER", agreement: "123", reference: "456" },
            { paymentMethodType: "QR_CODE", qrCode: "data:image/png;base64,AAAA" },
          ],
        },
      }),
    );
    const r = await provider.crearIntento({ ...INTENT, canal: "yape" });
    expect(r.ok).toBe(true);
    if (!r.ok || r.instruccion.tipo !== "qr") throw new Error("se esperaba una instrucción de QR");
    expect(r.instruccion.dataUri).toBe("data:image/png;base64,AAAA");
    expect(r.instruccion.canal).toBe("yape");
    expect(r.instruccion.montoCents).toBe(24937);
    expect(r.instruccion.montoFormateado).toBe("S/ 249.37");
    // Alternativa para quien no puede escanear en el mismo dispositivo.
    expect(r.instruccion.urlAlternativa).toBe("https://checkout.tupayonline.com/abc");
  });

  it("cae a redirección si el canal es de QR pero no vino ningún qrCode", async () => {
    const { provider } = conRespuesta(respuestaOk());
    const r = await provider.crearIntento({ ...INTENT, canal: "plin" });
    expect(r.ok && r.instruccion.tipo).toBe("redirect");
  });

  it("devuelve los datos de transferencia cuando el canal es transferencia", async () => {
    const { provider } = conRespuesta(
      respuestaOk({
        redirect_url: null,
        payment_info: {
          multigateway_metadata: [
            { paymentMethodType: "BANK_TRANSFER", agreement: "CONV-01", reference: "REF-99" },
          ],
        },
      }),
    );
    const r = await provider.crearIntento({ ...INTENT, canal: "transferencia" });
    if (!r.ok || r.instruccion.tipo !== "transferencia") {
      throw new Error("se esperaba una instrucción de transferencia");
    }
    expect(r.instruccion.convenio).toBe("CONV-01");
    expect(r.instruccion.referencia).toBe("REF-99");
  });

  it("usa el redirectUrl de la metadata de tarjeta si falta redirect_url", async () => {
    const { provider } = conRespuesta(
      respuestaOk({
        redirect_url: null,
        payment_info: {
          multigateway_metadata: [
            { paymentMethodType: "CREDIT_CARD", redirectUrl: "https://3ds.banco.pe/x" },
          ],
        },
      }),
    );
    const r = await provider.crearIntento({ ...INTENT, canal: "tarjeta" });
    if (!r.ok || r.instruccion.tipo !== "redirect") throw new Error("se esperaba redirección");
    expect(r.instruccion.url).toBe("https://3ds.banco.pe/x");
  });

  it("marca HOSTED para que la UI avise de que la pasarela pedirá más datos", async () => {
    const { provider } = conRespuesta(
      respuestaOk({ checkout_type: "HOSTED", iframe: true }),
    );
    const r = await provider.crearIntento({ ...INTENT, canal: "yape" });
    if (!r.ok || r.instruccion.tipo !== "redirect") throw new Error("se esperaba redirección");
    expect(r.instruccion.pedirDatosEnPasarela).toBe(true);
    expect(r.instruccion.iframe).toBe(true);
  });

  it("HOSTED sin redirect_url es un fallo: no hay a dónde mandar al cliente", async () => {
    const { provider } = conRespuesta(
      respuestaOk({ checkout_type: "HOSTED", redirect_url: null }),
    );
    const r = await provider.crearIntento(INTENT);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.codigo).toBe("PROVEEDOR");
      // No se reintenta: el depósito puede existir ya en Tupay.
      expect(r.error.reintentable).toBe(false);
    }
  });

  it("deja el pedido pendiente hasta que llegue la notificación firmada", async () => {
    const { provider } = conRespuesta(respuestaOk());
    const r = await provider.crearIntento(INTENT);
    // Adelantar el estado aquí sería fiarse de que el cliente completa el checkout
    // después de que se lo mostramos, que es justo donde se cae la gente.
    expect(r.ok && r.estadoPedidoSugerido).toBe("pendiente_pago");
  });

  it("estima la comisión en céntimos enteros", async () => {
    const { provider } = conRespuesta(respuestaOk());
    const r = await provider.crearIntento(INTENT);
    expect(r.ok && Number.isInteger(r.comisionCents)).toBe(true);
    expect(r.ok && r.comisionCents).toBe(Math.round((24937 * 3.99) / 100));
  });
});

describe("TupayProvider.crearIntento: errores", () => {
  it("traduce un error de Tupay a PaymentFailure con mensaje en español", async () => {
    const { provider } = conRespuesta(
      { code: 412, description: "method unavailable", type: "PAYMENT_METHOD_UNAVAILABLE" },
      412,
    );
    const r = await provider.crearIntento(INTENT);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.codigo).toBe("METODO_NO_DISPONIBLE");
      expect(r.error.reintentable).toBe(true);
      expect(r.error.mensajeCliente).toMatch(/no está disponible/i);
      expect(r.error.mensajeCliente).not.toContain("412");
    }
  });

  it("clasifica los errores de firma y credenciales como no reintentables", async () => {
    for (const [status, code, esperado] of [
      [401, 100, "CREDENCIALES"],
      [401, 102, "CREDENCIALES"],
      [400, 103, "CONFIGURACION_INVALIDA"],
      [403, 202, "CONFIGURACION_INVALIDA"],
      [409, 402, "REFERENCIA_DUPLICADA"],
      [429, 203, "LIMITE_EXCEDIDO"],
      [400, 201, "DATOS_PAGADOR_INVALIDOS"],
    ] as const) {
      const { provider } = conRespuesta({ code, description: "x", type: "T" }, status);
      const r = await provider.crearIntento(INTENT);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.codigo, `code ${code}`).toBe(esperado);
        expect(r.error.reintentable, `code ${code}`).toBe(false);
      }
    }
  });

  it("nunca expone la secret en el error que llega al checkout", async () => {
    const { provider } = conRespuesta(
      { code: 102, description: `bad signature ${CONFIG.apiSecret}`, type: "INVALID_SIGNATURE" },
      401,
    );
    const r = await provider.crearIntento(INTENT);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(`${r.error.mensajeCliente} ${r.error.mensajeTecnico}`).not.toContain(
        CONFIG.apiSecret,
      );
    }
  });
});

describe("normalizarEstadoTupay", () => {
  it("mapea las grafías conocidas", () => {
    expect(normalizarEstadoTupay("APPROVED")).toBe("aprobado");
    expect(normalizarEstadoTupay("paid")).toBe("aprobado");
    expect(normalizarEstadoTupay("PENDING")).toBe("pendiente");
    expect(normalizarEstadoTupay("REJECTED")).toBe("rechazado");
    expect(normalizarEstadoTupay("EXPIRED")).toBe("expirado");
    expect(normalizarEstadoTupay("CHARGEBACK")).toBe("reembolsado");
  });

  it("devuelve 'desconocido' ante lo que no reconoce, en vez de adivinar", () => {
    // Adivinar 'aprobado' regalaría mercadería; adivinar 'rechazado' cancelaría un
    // pago bueno.
    expect(normalizarEstadoTupay("ALGO_NUEVO")).toBe("desconocido");
    expect(normalizarEstadoTupay(undefined)).toBe("desconocido");
    expect(normalizarEstadoTupay(null)).toBe("desconocido");
  });
});

describe("TupayProvider.consultarEstado", () => {
  it("normaliza el estado y convierte el monto a céntimos", async () => {
    const { provider } = conRespuesta(
      { deposit_id: "dep_123", status: "APPROVED", amount: 249.37, updated_at: "2026-08-19T10:31:00Z" },
      200,
    );
    const r = await provider.consultarEstado("dep_123");
    expect(r.estado).toBe("aprobado");
    expect(r.montoCents).toBe(24937);
    expect(r.actualizadoEn?.toISOString()).toBe("2026-08-19T10:31:00.000Z");
  });

  it("devuelve 'desconocido' si la consulta falla, nunca 'rechazado'", async () => {
    // Devolver 'rechazado' liberaría el stock de un pedido posiblemente pagado.
    const { provider } = conRespuesta(
      { code: 208, description: "not found", type: "RESOURCE_NOT_FOUND" },
      404,
    );
    const r = await provider.consultarEstado("dep_x");
    expect(r.estado).toBe("desconocido");
    expect(r.providerRef).toBe("dep_x");
    expect(r.montoCents).toBeNull();
    expect(r.detalle).toContain("208");
  });
});
