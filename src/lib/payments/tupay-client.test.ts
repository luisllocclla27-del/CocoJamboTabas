import { describe, expect, it, vi } from "vitest";
import {
  centsToSoles,
  idempotencyKeyFor,
  loadTupayConfig,
  normalizarInvoiceId,
  redactPayload,
  redactSecret,
  solesToCents,
  TupayClient,
  TupayConfigError,
  TupayError,
  tupayEstaConfigurada,
  type FetchLike,
  type TupayClientOptions,
  type TupayConfig,
  type TupayDepositRequest,
} from "./tupay-client";

const SECRET = "signature-super-secreta-de-prueba";

const CONFIG: TupayConfig = {
  apiKey: "api-key-de-prueba",
  apiSecret: SECRET,
  baseUrl: "https://api-stg.tupayonline.com",
  testMode: true,
};

const ENV_COMPLETO: Record<string, string | undefined> = {
  TUPAY_API_KEY: "api-key-de-prueba",
  TUPAY_API_SECRET: SECRET,
  TUPAY_BASE_URL: "https://api-stg.tupayonline.com",
  TUPAY_TEST_MODE: "true",
};

function bodyValido(invoiceId = "COCO-7F3K2M"): TupayDepositRequest {
  return {
    country: "PE",
    currency: "PEN",
    amount: 249.37,
    payment_method: "XAYP",
    invoice_id: invoiceId,
    success_url: "https://cocojambo.pe/pedido/ok",
    notification_url: "https://cocojambo.pe/api/tupay/webhook",
    payer: {
      first_name: "Ana",
      last_name: "Muñoz Peña",
      document: "12345678",
      document_type: "DNI",
      email: "ana@example.com",
      phone: "+51987654321",
    },
    test: true,
  };
}

const RESPUESTA_OK = {
  checkout_type: "ONE_SHOT",
  redirect_url: "https://checkout.tupayonline.com/abc",
  iframe: false,
  deposit_id: "dep_123",
  merchant_invoice_id: "COCO-7F3K2M",
  payment_info: {
    amount: 249.37,
    currency: "PEN",
    expiration_date: "2026-08-19T11:00:00Z",
    created_at: "2026-08-19T10:30:00Z",
    payment_method: "XAYP",
    multigateway_metadata: [
      { paymentMethodType: "QR_CODE", qrCode: "data:image/png;base64,AAAA" },
    ],
  },
};

function respuesta(status: number, cuerpo: unknown): Response {
  return new Response(typeof cuerpo === "string" ? cuerpo : JSON.stringify(cuerpo), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Doble de `fetch` que devuelve las respuestas en orden y registra las llamadas. */
function fetchFalso(respuestas: readonly (Response | Error)[]) {
  const llamadas: { url: string; init: RequestInit | undefined }[] = [];
  let i = 0;
  const impl: FetchLike = async (url, init) => {
    llamadas.push({ url, init });
    const siguiente = respuestas[Math.min(i, respuestas.length - 1)];
    i++;
    if (siguiente instanceof Error) throw siguiente;
    // Un `Response` sólo puede leerse una vez: se clona para poder reutilizar el
    // mismo doble en varios intentos.
    return siguiente.clone();
  };
  return { impl, llamadas };
}

function cliente(overrides: Partial<TupayClientOptions> = {}) {
  return new TupayClient({
    config: CONFIG,
    // Ningún test sale a la red: si un doble falta, esto lo hace evidente.
    fetchImpl: async () => {
      throw new Error("fetch no inyectado en el test");
    },
    sleep: async () => {},
    now: () => new Date("2026-08-19T10:30:00Z"),
    ...overrides,
  });
}

/**
 * Ejecuta algo que debe rechazar y devuelve el `TupayError`.
 *
 * Sin este helper, `promesa.catch(e => e as TupayError)` produce la unión con el
 * tipo resuelto, y los esquemas con `passthrough` tienen índice `unknown`, así
 * que acceder a `.details` no compila.
 */
async function errorDe(promesa: Promise<unknown>): Promise<TupayError> {
  try {
    await promesa;
  } catch (e) {
    return e as TupayError;
  }
  throw new Error("se esperaba un rechazo y la promesa se resolvió");
}

describe("loadTupayConfig", () => {
  it("carga la configuración completa", () => {
    const config = loadTupayConfig(ENV_COMPLETO);
    expect(config).toEqual(CONFIG);
  });

  it("nombra la variable de entorno que falta, no el campo interno", () => {
    // El modo de fallo alternativo es un 102 INVALID_SIGNATURE en producción, que
    // cuesta horas de diagnóstico. El error tiene que decir qué variable falta.
    expect(() => loadTupayConfig({ ...ENV_COMPLETO, TUPAY_API_SECRET: "" })).toThrow(
      TupayConfigError,
    );
    expect(() => loadTupayConfig({ ...ENV_COMPLETO, TUPAY_API_SECRET: "" })).toThrow(
      /TUPAY_API_SECRET/,
    );
    expect(() => loadTupayConfig({ ...ENV_COMPLETO, TUPAY_API_KEY: undefined })).toThrow(
      /TUPAY_API_KEY/,
    );
    expect(() => loadTupayConfig({ ...ENV_COMPLETO, TUPAY_BASE_URL: "no-es-url" })).toThrow(
      /TUPAY_BASE_URL/,
    );
  });

  it("normaliza la barra final de la base URL para no generar '//v3/deposits'", () => {
    expect(loadTupayConfig({ ...ENV_COMPLETO, TUPAY_BASE_URL: "https://x.test/" }).baseUrl).toBe(
      "https://x.test",
    );
  });

  it("asume modo prueba cuando TUPAY_TEST_MODE no está definido", () => {
    // Por defecto seguro: nunca cobrar de verdad por un despiste de configuración.
    const { TUPAY_TEST_MODE: _omitido, ...sinFlag } = ENV_COMPLETO;
    expect(loadTupayConfig(sinFlag).testMode).toBe(true);
    expect(loadTupayConfig({ ...ENV_COMPLETO, TUPAY_TEST_MODE: "false" }).testMode).toBe(false);
  });

  it("tupayEstaConfigurada responde sin lanzar", () => {
    expect(tupayEstaConfigurada(ENV_COMPLETO)).toBe(true);
    expect(tupayEstaConfigurada({})).toBe(false);
  });
});

describe("centsToSoles", () => {
  it("convierte los casos habituales del catálogo", () => {
    expect(centsToSoles(24937)).toBe(249.37);
    expect(centsToSoles(24900)).toBe(249);
    expect(centsToSoles(24907)).toBe(249.07);
    expect(centsToSoles(800)).toBe(8);
    expect(centsToSoles(1)).toBe(0.01);
    expect(centsToSoles(0)).toBe(0);
  });

  it("no pierde precisión en ningún valor: round-trip exacto en un barrido amplio", () => {
    // Barrido denso sobre el rango de precios realista y todos los céntimos
    // posibles: cualquier error de coma flotante aparecería como un descalce de
    // un céntimo en la conciliación contra Tupay.
    for (let cents = 0; cents <= 20_000; cents++) {
      expect(solesToCents(centsToSoles(cents))).toBe(cents);
    }
    for (let cents = 100_000; cents <= 100_500; cents++) {
      expect(solesToCents(centsToSoles(cents))).toBe(cents);
    }
  });

  it("el número serializado a JSON conserva exactamente dos decimales", () => {
    // Lo que Tupay recibe es la representación JSON, no el double: si
    // `JSON.stringify` imprimiera 249.36999999999998 la firma cuadraría pero el
    // importe cobrado estaría mal.
    for (const cents of [1, 7, 99, 105, 1005, 24937, 100499, 999999]) {
      const json = JSON.stringify({ amount: centsToSoles(cents) });
      const vuelta = (JSON.parse(json) as { amount: number }).amount;
      expect(solesToCents(vuelta)).toBe(cents);
      expect(json).not.toMatch(/\d{5,}(?=[,}])/);
    }
  });

  it("rechaza montos que no son céntimos enteros no negativos", () => {
    expect(() => centsToSoles(249.5)).toThrow();
    expect(() => centsToSoles(-1)).toThrow();
  });
});

describe("normalizarInvoiceId", () => {
  it("deja intacta nuestra referencia, que ya cumple el patrón de Tupay", () => {
    expect(normalizarInvoiceId("COCO-7F3K2M")).toBe("COCO-7F3K2M");
  });

  it("sustituye los caracteres que Tupay rechazaría con un 201", () => {
    expect(normalizarInvoiceId("COCO 7F3/K2M#")).toBe("COCO-7F3-K2M-");
  });

  it("recorta a 128 caracteres", () => {
    expect(normalizarInvoiceId("A".repeat(200))).toHaveLength(128);
  });

  it("lanza si no queda nada tras sanear", () => {
    expect(() => normalizarInvoiceId("   ")).toThrow();
  });
});

describe("idempotencyKeyFor", () => {
  it("es determinista: la misma referencia da siempre la misma key", () => {
    // Es el requisito central: un reintento tras un timeout debe llevar la misma
    // key para que Tupay no cree un segundo depósito.
    expect(idempotencyKeyFor("COCO-7F3K2M")).toBe(idempotencyKeyFor("COCO-7F3K2M"));
  });

  it("distingue referencias distintas", () => {
    expect(idempotencyKeyFor("COCO-7F3K2M")).not.toBe(idempotencyKeyFor("COCO-7F3K2N"));
  });

  it("no filtra la referencia del pedido en la cabecera", () => {
    expect(idempotencyKeyFor("COCO-7F3K2M")).not.toContain("COCO");
    expect(idempotencyKeyFor("COCO-7F3K2M")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("redacción para logs", () => {
  it("elimina cualquier aparición de la secret", () => {
    expect(redactSecret(`falló con clave ${SECRET} en la cabecera`, SECRET)).toBe(
      "falló con clave [REDACTED] en la cabecera",
    );
    expect(redactSecret("texto limpio", SECRET)).toBe("texto limpio");
  });

  it("oculta el DNI, el email, el teléfono y el nombre del pagador", () => {
    const redactado = redactPayload(JSON.stringify(bodyValido()));
    for (const dato of ["12345678", "ana@example.com", "+51987654321", "Ana", "Muñoz"]) {
      expect(redactado).not.toContain(dato);
    }
    // Conserva la forma, que es lo único útil para depurar.
    expect(redactado).toContain("invoice_id");
    expect(redactado).toContain("COCO-7F3K2M");
    expect(redactado).toContain("249.37");
  });

  it("no explota con un payload que no es JSON", () => {
    expect(redactPayload("<html>error</html>")).toContain("omitido");
  });
});

describe("TupayClient.createDeposit", () => {
  it("firma sobre el mismo string que envía en el body", async () => {
    const { impl, llamadas } = fetchFalso([respuesta(201, RESPUESTA_OK)]);
    await cliente({ fetchImpl: impl }).createDeposit(bodyValido());

    const enviado = llamadas[0].init?.body as string;
    const headers = llamadas[0].init?.headers as Record<string, string>;
    const { computeTupaySignature } = await import("./signature");
    const esperada = computeTupaySignature({
      xDate: headers["X-Date"],
      xLogin: CONFIG.apiKey,
      payload: enviado,
      secret: SECRET,
    });
    expect(headers.Authorization).toBe(`TUPAY ${esperada}`);
  });

  it("envía todas las cabeceras obligatorias con el X-Date en el formato exigido", async () => {
    const { impl, llamadas } = fetchFalso([respuesta(201, RESPUESTA_OK)]);
    await cliente({ fetchImpl: impl }).createDeposit(bodyValido());

    const headers = llamadas[0].init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Login"]).toBe(CONFIG.apiKey);
    expect(headers["X-Date"]).toBe("2026-08-19T10:30:00Z");
    expect(headers.Authorization).toMatch(/^TUPAY [0-9a-f]{64}$/);
    expect(headers["X-Idempotency-Key"]).toBe(idempotencyKeyFor("COCO-7F3K2M"));
    expect(llamadas[0].url).toBe("https://api-stg.tupayonline.com/v3/deposits");
  });

  it("devuelve la respuesta validada, tolerando campos que no conocemos", async () => {
    const conExtras = {
      ...RESPUESTA_OK,
      campo_nuevo_del_proveedor: { lo_que_sea: 1 },
      payment_info: { ...RESPUESTA_OK.payment_info, otro_campo: "x" },
    };
    const { impl } = fetchFalso([respuesta(201, conExtras)]);
    const r = await cliente({ fetchImpl: impl }).createDeposit(bodyValido());
    expect(r.deposit_id).toBe("dep_123");
    expect(r.checkout_type).toBe("ONE_SHOT");
    expect(r.payment_info?.multigateway_metadata).toHaveLength(1);
  });

  it("normaliza el campo iframe venga como booleano o como string", async () => {
    const { impl } = fetchFalso([respuesta(201, { ...RESPUESTA_OK, iframe: "true" })]);
    const r = await cliente({ fetchImpl: impl }).createDeposit(bodyValido());
    expect(r.iframe).toBe(true);
  });

  it("falla si la respuesta 201 no trae deposit_id: sin él no hay conciliación posible", async () => {
    const { impl } = fetchFalso([
      respuesta(201, { checkout_type: "ONE_SHOT", redirect_url: "https://x.test" }),
    ]);
    await expect(cliente({ fetchImpl: impl }).createDeposit(bodyValido())).rejects.toMatchObject({
      type: "RESPONSE_SHAPE_UNEXPECTED",
    });
  });

  it("reintenta los errores reintentables reusando la MISMA idempotency key", async () => {
    // El escenario que esto protege: Tupay pudo haber creado el depósito antes de
    // fallar. Con la misma key devuelve ese depósito; con una key nueva crearía un
    // segundo cobro al cliente.
    const { impl, llamadas } = fetchFalso([
      respuesta(500, { code: 500, description: "boom", type: "GENERIC_ERROR" }),
      respuesta(201, RESPUESTA_OK),
    ]);
    const sleep = vi.fn(async () => {});
    const r = await cliente({ fetchImpl: impl, sleep }).createDeposit(bodyValido());

    expect(r.deposit_id).toBe("dep_123");
    expect(llamadas).toHaveLength(2);
    const keys = llamadas.map((l) => (l.init?.headers as Record<string, string>)["X-Idempotency-Key"]);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe(idempotencyKeyFor("COCO-7F3K2M"));
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("reintenta el 412 (medio de pago momentáneamente indisponible) y el 404", async () => {
    for (const [status, code, type] of [
      [412, 412, "PAYMENT_METHOD_UNAVAILABLE"],
      [404, 404, "ERROR_CREATING_PAYMENT"],
    ] as const) {
      const { impl, llamadas } = fetchFalso([
        respuesta(status, { code, description: "x", type }),
        respuesta(201, RESPUESTA_OK),
      ]);
      await cliente({ fetchImpl: impl }).createDeposit(bodyValido());
      expect(llamadas).toHaveLength(2);
    }
  });

  it("reintenta un fallo de red o timeout", async () => {
    const { impl, llamadas } = fetchFalso([
      Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" }),
      respuesta(201, RESPUESTA_OK),
    ]);
    const r = await cliente({ fetchImpl: impl }).createDeposit(bodyValido());
    expect(r.deposit_id).toBe("dep_123");
    expect(llamadas).toHaveLength(2);
  });

  it("NO reintenta los errores de validación: son deterministas", async () => {
    const { impl, llamadas } = fetchFalso([
      respuesta(400, {
        code: 201,
        description: "invalid payer",
        type: "BEAN_VALIDATION_ERROR",
        details: ["payer.document: invalid length"],
      }),
    ]);
    await expect(cliente({ fetchImpl: impl }).createDeposit(bodyValido())).rejects.toBeInstanceOf(
      TupayError,
    );
    expect(llamadas).toHaveLength(1);
  });

  it("NO reintenta firma, credenciales, ventana temporal ni IP no whitelisteada", async () => {
    for (const code of [100, 102, 103, 202]) {
      const { impl, llamadas } = fetchFalso([
        respuesta(401, { code, description: "no", type: "X" }),
      ]);
      await expect(cliente({ fetchImpl: impl }).createDeposit(bodyValido())).rejects.toMatchObject({
        code,
        esReintentable: false,
      });
      expect(llamadas).toHaveLength(1);
    }
  });

  it("NO reintenta el VELOCITY_CHECK, porque reintentar es lo que lo dispara", async () => {
    const { impl, llamadas } = fetchFalso([
      respuesta(429, { code: 203, description: "slow down", type: "VELOCITY_CHECK" }),
    ]);
    await expect(cliente({ fetchImpl: impl }).createDeposit(bodyValido())).rejects.toMatchObject({
      code: 203,
      esReintentable: false,
    });
    expect(llamadas).toHaveLength(1);
  });

  it("agota los reintentos y propaga el último error", async () => {
    const { impl, llamadas } = fetchFalso([
      respuesta(500, { code: 500, description: "boom", type: "GENERIC_ERROR" }),
    ]);
    await expect(
      cliente({ fetchImpl: impl, maxReintentos: 2 }).createDeposit(bodyValido()),
    ).rejects.toMatchObject({ code: 500 });
    // Primer intento + 2 reintentos.
    expect(llamadas).toHaveLength(3);
  });

  it("conserva los details del BEAN_VALIDATION_ERROR para el log", async () => {
    const { impl } = fetchFalso([
      respuesta(400, {
        code: 201,
        description: "validation failed",
        type: "BEAN_VALIDATION_ERROR",
        details: ["payer.email: must be a well-formed email address"],
      }),
    ]);
    const error = await errorDe(cliente({ fetchImpl: impl }).createDeposit(bodyValido()));
    expect(error.details).toEqual(["payer.email: must be a well-formed email address"]);
    expect(error.httpStatus).toBe(400);
    expect(error.type).toBe("BEAN_VALIDATION_ERROR");
  });

  it("traduce cada código de Tupay a un mensaje en español distinto del técnico", async () => {
    const { impl } = fetchFalso([
      respuesta(409, { code: 402, description: "invoice already used", type: "INVOICE_ALREADY_USED" }),
    ]);
    const error = await errorDe(cliente({ fetchImpl: impl }).createDeposit(bodyValido()));
    expect(error.mensajeCliente).toMatch(/pedido ya tiene un pago/i);
    // El mensaje técnico sí lleva el código; el del cliente no.
    expect(error.message).toContain("402");
    expect(error.mensajeCliente).not.toContain("402");
    expect(error.mensajeCliente).not.toContain("INVOICE_ALREADY_USED");
  });

  it("da un mensaje genérico y no técnico ante un código desconocido", async () => {
    const { impl } = fetchFalso([respuesta(418, { code: 9999, description: "?", type: "RARO" })]);
    const error = await errorDe(cliente({ fetchImpl: impl }).createDeposit(bodyValido()));
    expect(error.mensajeCliente).toMatch(/Yape directo/);
  });

  it("nunca incluye la secret en el mensaje de error, ni si el runtime la filtra", async () => {
    // Escenario real: algunos runtimes incluyen cabeceras en el mensaje del
    // TypeError de fetch, y ese mensaje acaba en el servicio de observabilidad.
    const filtrado = new Error(
      `request to https://api-stg.tupayonline.com/v3/deposits failed, Authorization: TUPAY ${SECRET}`,
    );
    const { impl } = fetchFalso([filtrado]);
    const error = await errorDe(
      cliente({ fetchImpl: impl, maxReintentos: 0 }).createDeposit(bodyValido()),
    );

    const todoElError = `${error.message} ${error.mensajeCliente} ${error.details.join(" ")} ${JSON.stringify(error)} ${String(error.stack ?? "")}`;
    expect(todoElError).not.toContain(SECRET);
    expect(error.message).toContain("[REDACTED]");
  });

  it("tampoco filtra la secret cuando Tupay la devuelve en el cuerpo del error", async () => {
    const { impl } = fetchFalso([
      respuesta(400, { code: 201, description: `bad signature for ${SECRET}`, type: "X" }),
    ]);
    const error = await errorDe(cliente({ fetchImpl: impl }).createDeposit(bodyValido()));
    expect(error.message).not.toContain(SECRET);
  });

  it("no loguea el payload completo: el logger recibe los datos del pagador redactados", async () => {
    const lineas: string[] = [];
    const { impl } = fetchFalso([respuesta(201, RESPUESTA_OK)]);
    await cliente({
      fetchImpl: impl,
      logger: {
        info: (m: string) => lineas.push(m),
        warn: (m: string) => lineas.push(m),
      },
    }).createDeposit(bodyValido());

    const todo = lineas.join("\n");
    expect(todo).toContain("/v3/deposits");
    for (const dato of ["12345678", "ana@example.com", "+51987654321", SECRET]) {
      expect(todo).not.toContain(dato);
    }
  });

  it("trata un 2xx que no es JSON como respuesta no utilizable", async () => {
    const { impl } = fetchFalso([
      new Response("<html>gateway</html>", { status: 200, headers: { "Content-Type": "text/html" } }),
    ]);
    await expect(cliente({ fetchImpl: impl }).createDeposit(bodyValido())).rejects.toMatchObject({
      type: "RESPONSE_NOT_JSON",
    });
  });

  it("aborta con timeout en lugar de esperar indefinidamente", async () => {
    const { impl, llamadas } = fetchFalso([respuesta(201, RESPUESTA_OK)]);
    await cliente({ fetchImpl: impl, timeoutMs: 1234 }).createDeposit(bodyValido());
    expect(llamadas[0].init?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("TupayClient.getDeposit", () => {
  it("consulta por GET sin body y firma con payload vacío", async () => {
    const { impl, llamadas } = fetchFalso([
      respuesta(200, { deposit_id: "dep_123", status: "APPROVED", amount: 249.37 }),
    ]);
    const r = await cliente({ fetchImpl: impl }).getDeposit("dep_123");

    expect(r.status).toBe("APPROVED");
    expect(llamadas[0].url).toBe("https://api-stg.tupayonline.com/v3/deposits/dep_123");
    expect(llamadas[0].init?.method).toBe("GET");
    expect(llamadas[0].init?.body).toBeUndefined();

    const headers = llamadas[0].init?.headers as Record<string, string>;
    const { computeTupaySignature } = await import("./signature");
    expect(headers.Authorization).toBe(
      `TUPAY ${computeTupaySignature({
        xDate: headers["X-Date"],
        xLogin: CONFIG.apiKey,
        payload: "",
        secret: SECRET,
      })}`,
    );
  });

  it("escapa el identificador en la URL", async () => {
    const { impl, llamadas } = fetchFalso([respuesta(200, { deposit_id: "a b" })]);
    await cliente({ fetchImpl: impl }).getDeposit("a b");
    expect(llamadas[0].url).toContain("a%20b");
  });

  it("propaga el 208 RESOURCE_NOT_FOUND como TupayError", async () => {
    const { impl } = fetchFalso([
      respuesta(404, { code: 208, description: "not found", type: "RESOURCE_NOT_FOUND" }),
    ]);
    await expect(cliente({ fetchImpl: impl }).getDeposit("dep_x")).rejects.toMatchObject({
      code: 208,
    });
  });
});
