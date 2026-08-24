import { describe, expect, it, vi } from "vitest";
import {
  construirShalomError,
  loadShalomConfig,
  MARCADOR_REDACTADO,
  MAX_ITEMS_BATCH,
  parseRetryAfter,
  redactar,
  redactarHeaders,
  ShalomClient,
  ShalomConfigError,
  ShalomError,
  shalomEstaConfigurada,
  solesACents,
  trocear,
  type ShalomClientOptions,
  type ShalomConfig,
} from "./shalom-client";

const PASSWORD = "sup3r-secreta-de-shalom-pro";
const API_KEY = "clave-api-del-wrapper-123";

const CONFIG: ShalomConfig = {
  apiKey: API_KEY,
  proEmail: "tienda@cocojambo.pe",
  proPassword: PASSWORD,
  webhookSecret: "secreto-de-firma-del-webhook",
  baseUrl: "https://api.shalom-api-peru.com",
  habilitado: true,
};

const ENV_COMPLETO: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  SHALOM_API_KEY: API_KEY,
  SHALOM_PRO_EMAIL: "tienda@cocojambo.pe",
  SHALOM_PRO_PASSWORD: PASSWORD,
  SHALOM_WEBHOOK_SECRET: "secreto-de-firma-del-webhook",
  SHALOM_ENABLED: "true",
};

/** Entorno vacío pero válido como `ProcessEnv`. */
const ENV_VACIO: NodeJS.ProcessEnv = { NODE_ENV: "test" };

/** Respuesta JSON de prueba. */
function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/**
 * Cliente con `fetch` guionizado. Ningún test sale a la red: el default de
 * `fetchImpl` se sustituye siempre, y `sleep` se anula para que los reintentos
 * no cuesten tiempo real.
 */
function clienteCon(
  respuestas: readonly (Response | (() => Response | Promise<Response>))[],
  overrides: Partial<ShalomClientOptions> = {},
) {
  const llamadas: Array<{ url: string; init: RequestInit | undefined }> = [];
  let i = 0;
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    llamadas.push({ url, init });
    const siguiente = respuestas[Math.min(i, respuestas.length - 1)];
    i++;
    return typeof siguiente === "function" ? await siguiente() : siguiente.clone();
  });
  const client = new ShalomClient({
    config: CONFIG,
    fetchImpl,
    sleep: async () => {},
    ...overrides,
  });
  return { client, fetchImpl, llamadas };
}

/** Sesión válida, que es lo primero que pide cualquier ruta de cuenta. */
function respuestaSesion(): Response {
  return json({
    session_token: "ssk_" + "a".repeat(64),
    expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
  });
}

describe("loadShalomConfig", () => {
  it("carga una configuración completa", () => {
    const config = loadShalomConfig(ENV_COMPLETO);
    expect(config.habilitado).toBe(true);
    expect(config.baseUrl).toBe("https://api.shalom-api-peru.com");
  });

  it("normaliza la barra final de la URL base", () => {
    // Sin esto, `${baseUrl}/v1/tracking` produciría `//v1/tracking` y un 404
    // desconcertante.
    const config = loadShalomConfig({
      ...ENV_COMPLETO,
      SHALOM_BASE_URL: "https://api.shalom-api-peru.com///",
    });
    expect(config.baseUrl).toBe("https://api.shalom-api-peru.com");
  });

  it("nombra la variable que falta en vez de fallar con un 401 en producción", () => {
    try {
      loadShalomConfig({ ...ENV_COMPLETO, SHALOM_API_KEY: "" });
      throw new Error("debió lanzar");
    } catch (error) {
      expect(error).toBeInstanceOf(ShalomConfigError);
      expect((error as ShalomConfigError).message).toContain("SHALOM_API_KEY");
    }
  });

  it("valida el formato del email", () => {
    expect(() => loadShalomConfig({ ...ENV_COMPLETO, SHALOM_PRO_EMAIL: "no-es-email" })).toThrow(
      /SHALOM_PRO_EMAIL/,
    );
  });

  it("NUNCA incluye la contraseña en el mensaje de error", () => {
    // El modo de fallo real: un mensaje de validación que interpola el valor
    // recibido y acaba en el log de arranque.
    try {
      loadShalomConfig({ ...ENV_COMPLETO, SHALOM_PRO_EMAIL: PASSWORD });
      throw new Error("debió lanzar");
    } catch (error) {
      const texto = (error as Error).message;
      expect(texto).not.toContain(PASSWORD);
    }
  });

  it("está deshabilitado por defecto", () => {
    // Ofrecer el camino automático sin querer haría que el fallo apareciera
    // después de que el admin pulsó "emitir guía".
    const config = loadShalomConfig({ ...ENV_COMPLETO, SHALOM_ENABLED: undefined });
    expect(config.habilitado).toBe(false);
  });

  it("acepta las formas habituales de escribir true", () => {
    for (const valor of ["1", "true", "TRUE", "yes", "si", "sí", "on"]) {
      expect(loadShalomConfig({ ...ENV_COMPLETO, SHALOM_ENABLED: valor }).habilitado, valor).toBe(
        true,
      );
    }
    for (const valor of ["0", "false", "no", "", "cualquier-cosa"]) {
      expect(loadShalomConfig({ ...ENV_COMPLETO, SHALOM_ENABLED: valor }).habilitado, valor).toBe(
        false,
      );
    }
  });
});

describe("shalomEstaConfigurada", () => {
  it("es true solo si está encendida Y la configuración es válida", () => {
    expect(shalomEstaConfigurada(ENV_COMPLETO)).toBe(true);
    expect(shalomEstaConfigurada({ ...ENV_COMPLETO, SHALOM_ENABLED: "false" })).toBe(false);
    expect(shalomEstaConfigurada({ ...ENV_COMPLETO, SHALOM_API_KEY: "" })).toBe(false);
  });

  it("no lanza nunca: sirve para decidir, no para validar", () => {
    expect(() => shalomEstaConfigurada(ENV_VACIO)).not.toThrow();
    expect(shalomEstaConfigurada(ENV_VACIO)).toBe(false);
  });
});

describe("redactar", () => {
  it("elimina los secretos del texto", () => {
    const texto = `falló el login con password=${PASSWORD} y key=${API_KEY}`;
    const limpio = redactar(texto, PASSWORD, API_KEY);
    expect(limpio).not.toContain(PASSWORD);
    expect(limpio).not.toContain(API_KEY);
    expect(limpio).toContain(MARCADOR_REDACTADO);
  });

  it("limpia también la forma percent-encoded", () => {
    // Algunos clientes codifican las credenciales en la URL.
    const secreto = "pass word/con+simbolos";
    const texto = `url=https://x?p=${encodeURIComponent(secreto)}`;
    expect(redactar(texto, secreto)).not.toContain(encodeURIComponent(secreto));
  });

  it("ignora secretos muy cortos para no destrozar el mensaje", () => {
    // Reemplazar una cadena de 1-2 caracteres no aporta seguridad.
    expect(redactar("abc def", "ab")).toBe("abc def");
  });

  it("tolera undefined", () => {
    expect(redactar("hola", undefined, PASSWORD)).toBe("hola");
  });

  it("elimina todas las apariciones, no solo la primera", () => {
    const texto = `${PASSWORD} y otra vez ${PASSWORD}`;
    expect(redactar(texto, PASSWORD)).not.toContain(PASSWORD);
  });
});

describe("redactarHeaders", () => {
  it("conserva los nombres y borra los valores sensibles", () => {
    // El nombre es útil para depurar qué modo de auth se usó; el valor no debe
    // existir en ningún log.
    const limpio = redactarHeaders({
      "Content-Type": "application/json",
      "X-API-Key": API_KEY,
      "X-Shalom-Session": "ssk_abc",
      "X-Shalom-Password": PASSWORD,
      Authorization: "Bearer x",
    });
    expect(limpio["Content-Type"]).toBe("application/json");
    expect(limpio["X-API-Key"]).toBe(MARCADOR_REDACTADO);
    expect(limpio["X-Shalom-Session"]).toBe(MARCADOR_REDACTADO);
    expect(limpio["X-Shalom-Password"]).toBe(MARCADOR_REDACTADO);
    expect(limpio.Authorization).toBe(MARCADOR_REDACTADO);
  });

  it("no depende de cómo esté capitalizado el header", () => {
    expect(redactarHeaders({ "x-api-key": API_KEY })["x-api-key"]).toBe(MARCADOR_REDACTADO);
  });
});

describe("solesACents", () => {
  it("convierte los soles decimales del wrapper a céntimos enteros", () => {
    expect(solesACents(20.15)).toBe(2_015);
    expect(solesACents(8)).toBe(800);
    expect(solesACents("25.00")).toBe(2_500);
    expect(solesACents("12.5")).toBe(1_250);
  });

  it("no arrastra el error de coma flotante de valor * 100", () => {
    // `1.005 * 100` da 100.49999999999999 y redondearía a 100 en vez de 101.
    expect(solesACents(1.005)).toBe(101);
    expect(solesACents("1.005")).toBe(101);
    expect(solesACents(20.15)).toBe(2_015);
    expect(solesACents(1.15)).toBe(115);
    expect(solesACents(4.35)).toBe(435);
  });

  it("acepta string además de number, porque el wrapper entrecomilla algunos montos", () => {
    // `Number("20.15")` reintroduciría el binario.
    expect(solesACents("20.15")).toBe(2_015);
  });

  it("redondea al céntimo más cercano mirando el tercer decimal", () => {
    expect(solesACents("10.004")).toBe(1_000);
    expect(solesACents("10.005")).toBe(1_001);
    expect(solesACents("10.009")).toBe(1_001);
  });

  it("no pierde precisión en un barrido amplio de valores", () => {
    // Todos los importes de dos decimales entre S/ 0.00 y S/ 300.00.
    for (let cents = 0; cents <= 30_000; cents++) {
      const soles = `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
      expect(solesACents(soles), soles).toBe(cents);
    }
  });

  it("mantiene la precisión pasando por number en los valores problemáticos", () => {
    // Los múltiplos de 5 céntimos son los que peor se representan en binario.
    for (let cents = 5; cents <= 10_000; cents += 5) {
      const soles = cents / 100;
      expect(solesACents(soles), String(soles)).toBe(cents);
    }
  });

  it("rechaza un monto no numérico en vez de devolver NaN", () => {
    expect(() => solesACents("gratis")).toThrow(ShalomError);
    expect(() => solesACents("")).toThrow(/no num/);
    expect(() => solesACents("20,15")).toThrow(/no num/);
  });

  it("soporta negativos, por si el wrapper devuelve un ajuste", () => {
    expect(solesACents("-5.50")).toBe(-550);
  });
});

describe("trocear", () => {
  it("parte 137 guías en lotes de 50, 50 y 37", () => {
    // El límite de 50 es DURO: mandar 51 items rechaza el lote completo, no
    // devuelve 50 resultados y un error.
    const items = Array.from({ length: 137 }, (_, i) => i);
    const grupos = trocear(items, MAX_ITEMS_BATCH);
    expect(grupos.map((g) => g.length)).toEqual([50, 50, 37]);
    expect(grupos.flat()).toEqual(items);
  });

  it("respeta el límite documentado de 50", () => {
    expect(MAX_ITEMS_BATCH).toBe(50);
  });

  it("no trocea lo que ya entra en un lote", () => {
    expect(trocear([1, 2, 3], 50)).toEqual([[1, 2, 3]]);
    expect(trocear(Array.from({ length: 50 }), 50)).toHaveLength(1);
  });

  it("un elemento más que el límite genera dos lotes", () => {
    expect(trocear(Array.from({ length: 51 }), 50).map((g) => g.length)).toEqual([50, 1]);
  });

  it("una lista vacía no produce lotes", () => {
    expect(trocear([], 50)).toEqual([]);
  });

  it("rechaza un tamaño inválido", () => {
    expect(() => trocear([1], 0)).toThrow(/>= 1/);
  });
});

describe("parseRetryAfter", () => {
  it("acepta segundos, que es lo que documenta el wrapper", () => {
    expect(parseRetryAfter("30")).toBe(30);
    expect(parseRetryAfter(" 5 ")).toBe(5);
  });

  it("acepta una fecha HTTP, por si un proxy reescribe la cabecera", () => {
    const futuro = new Date(Date.now() + 10_000).toUTCString();
    const segundos = parseRetryAfter(futuro);
    expect(segundos).not.toBeNull();
    expect(segundos!).toBeGreaterThanOrEqual(0);
    expect(segundos!).toBeLessThanOrEqual(11);
  });

  it("una fecha pasada da 0, no un negativo", () => {
    expect(parseRetryAfter(new Date(Date.now() - 60_000).toUTCString())).toBe(0);
  });

  it("devuelve null cuando no hay cabecera o es basura", () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("")).toBeNull();
    expect(parseRetryAfter("pronto")).toBeNull();
  });
});

describe("ShalomError y construirShalomError", () => {
  it("clasifica como reintentable solo lo que no decidió nada", () => {
    for (const code of [
      "upstream_unavailable",
      "upstream_timeout",
      "rate_limited",
      "internal",
      "network_error",
      "client_timeout",
    ] as const) {
      expect(new ShalomError(code, null, null, "x").esReintentable, code).toBe(true);
    }
    for (const code of [
      "bad_request",
      "unauthorized",
      "shalom_auth_failed",
      "not_found",
      "conflict",
      "upstream_rejected",
      "respuesta_invalida",
      "deshabilitado",
    ] as const) {
      expect(new ShalomError(code, null, null, "x").esReintentable, code).toBe(false);
    }
  });

  it("distingue el resultado incierto, que es lo que importa al emitir", () => {
    // Un 422 significa que no se creó nada; un timeout no significa nada.
    expect(new ShalomError("client_timeout", null, null, "x").resultadoIncierto).toBe(true);
    expect(new ShalomError("network_error", null, null, "x").resultadoIncierto).toBe(true);
    expect(new ShalomError("upstream_rejected", 422, null, "x").resultadoIncierto).toBe(false);
    expect(new ShalomError("bad_request", 400, null, "x").resultadoIncierto).toBe(false);
  });

  it("tiene un mensaje de cliente distinto del técnico", () => {
    const error = new ShalomError("upstream_rejected", 422, "req_1", "shalompro: detalle interno");
    expect(error.mensajeCliente).not.toContain("shalompro");
    expect(error.message).toContain("shalompro");
  });

  it("lee el código y el request_id del cuerpo del error", () => {
    const error = construirShalomError(
      422,
      JSON.stringify({
        error: { code: "upstream_rejected", message: "La guia ya fue recibida", request_id: "01KQ" },
      }),
      null,
    );
    expect(error.code).toBe("upstream_rejected");
    expect(error.requestId).toBe("01KQ");
    expect(error.detalle).toContain("La guia ya fue recibida");
  });

  it("cae al status cuando el cuerpo no es JSON del wrapper", () => {
    // Un HTML de balanceador es la única pista de que el fallo no vino del wrapper.
    const error = construirShalomError(502, "<html>Bad Gateway</html>", null);
    expect(error.code).toBe("upstream_unavailable");
    expect(error.detalle).toContain("Bad Gateway");
  });

  it("mapea los status documentados", () => {
    const casos: readonly [number, string][] = [
      [400, "bad_request"],
      [401, "unauthorized"],
      [403, "unauthorized"],
      [404, "not_found"],
      [409, "conflict"],
      [422, "upstream_rejected"],
      [429, "rate_limited"],
      [502, "upstream_unavailable"],
      [503, "upstream_unavailable"],
      [504, "upstream_timeout"],
      [500, "internal"],
    ];
    for (const [status, code] of casos) {
      expect(construirShalomError(status, "{}", null).code, String(status)).toBe(code);
    }
  });

  it("redacta los secretos que el wrapper haga eco en un 422", () => {
    const error = construirShalomError(
      422,
      JSON.stringify({ error: { message: `rechazado para password=${PASSWORD}` } }),
      null,
      PASSWORD,
    );
    expect(error.detalle).not.toContain(PASSWORD);
    expect(error.message).not.toContain(PASSWORD);
  });

  it("guarda el Retry-After del 429", () => {
    expect(construirShalomError(429, "{}", "45").retryAfterSegundos).toBe(45);
  });
});

describe("ShalomClient: sesión", () => {
  it("canjea email y contraseña por un token y lo reutiliza", async () => {
    // La contraseña debe viajar UNA vez, no en cada llamada.
    const { client, fetchImpl } = clienteCon([respuestaSesion()]);
    const token = await client.crearSesion();
    expect(token).toMatch(/^ssk_/);
    expect(await client.crearSesion()).toBe(token);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("la contraseña solo aparece en el cuerpo del login", async () => {
    const { client, llamadas } = clienteCon([
      respuestaSesion(),
      json({ detailed: false, status: { registrado: { fecha: "2026-07-28 09:12:00" } } }),
    ]);
    await client.consultarTrackingLote([{ ref: { tipo: "ose", oseId: "1" } }]).catch(() => {});

    const login = llamadas[0];
    expect(String(login.init?.body)).toContain(PASSWORD);
    // Las siguientes van con el token, nunca con la contraseña.
    for (const llamada of llamadas.slice(1)) {
      expect(String(llamada.init?.body ?? "")).not.toContain(PASSWORD);
      expect(JSON.stringify(llamada.init?.headers ?? {})).not.toContain(PASSWORD);
    }
  });

  it("serializa los logins concurrentes en uno solo", async () => {
    // El primer login tarda 90 s a 2 min. Cinco peticiones concurrentes sin la
    // promesa compartida dispararian cinco logins, quemando cuota y arriesgando
    // que Shalom trate la ráfaga como abuso.
    let logins = 0;
    const { client } = clienteCon([
      () => {
        logins++;
        return respuestaSesion();
      },
    ]);
    const tokens = await Promise.all([
      client.crearSesion(),
      client.crearSesion(),
      client.crearSesion(),
      client.crearSesion(),
      client.crearSesion(),
    ]);
    expect(logins).toBe(1);
    expect(new Set(tokens).size).toBe(1);
  });

  it("un login fallido no deja la promesa rechazada cacheada", async () => {
    // Si no se limpiara, todas las peticiones siguientes reusarían el rechazo y la
    // sesión nunca se recuperaría.
    let intento = 0;
    const { client } = clienteCon([
      () => {
        intento++;
        return intento === 1
          ? json({ error: { code: "shalom_auth_failed", message: "rechazado" } }, 401)
          : respuestaSesion();
      },
    ]);
    await expect(client.crearSesion()).rejects.toThrow(ShalomError);
    await expect(client.crearSesion()).resolves.toMatch(/^ssk_/);
  });

  it("renueva el token antes de que expire", async () => {
    // Una petición de cuenta puede durar 150 s: un token con 30 s de vida al
    // empezar llegaría caducado al upstream.
    let logins = 0;
    const { client } = clienteCon([
      () => {
        logins++;
        return json({
          session_token: `ssk_${logins}`,
          // Expira en 1 minuto: dentro del margen de renovación de 5 min.
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        });
      },
    ]);
    await client.crearSesion();
    await client.crearSesion();
    expect(logins).toBe(2);
  });

  it("asume 2 h de vida si expires_at no parsea", async () => {
    let logins = 0;
    const { client } = clienteCon([
      () => {
        logins++;
        return json({ session_token: `ssk_${logins}`, expires_at: "fecha-invalida" });
      },
    ]);
    await client.crearSesion();
    await client.crearSesion();
    // Un token sin caducidad daría 401 en bucle; con las 2 h documentadas se reusa.
    expect(logins).toBe(1);
  });

  it("forzar salta la caché", async () => {
    let logins = 0;
    const { client } = clienteCon([
      () => {
        logins++;
        return respuestaSesion();
      },
    ]);
    await client.crearSesion();
    await client.crearSesion(true);
    expect(logins).toBe(2);
  });
});

describe("ShalomClient: transporte", () => {
  it("se niega a operar si SHALOM_ENABLED está apagado", async () => {
    const client = new ShalomClient({
      config: { ...CONFIG, habilitado: false },
      fetchImpl: async () => json({}),
    });
    await expect(client.crearSesion()).rejects.toThrow(/apagado/);
  });

  it("manda la API key en todas las rutas, también las públicas", async () => {
    const { client, llamadas } = clienteCon([json({ data: [] })]);
    await client.buscarAgencias({ texto: "arequipa" });
    expect(JSON.stringify(llamadas[0].init?.headers)).toContain(API_KEY);
  });

  it("reintenta los fallos reintentables y respeta el Retry-After", async () => {
    const esperas: number[] = [];
    let intento = 0;
    const fetchImpl = vi.fn(async () => {
      intento++;
      if (intento === 1) {
        return json({ error: { code: "rate_limited", message: "muchas consultas" } }, 429, {
          "retry-after": "7",
        });
      }
      return json({ data: [{ id: 190, nombre: "MIRAFLORES" }] });
    });
    const client = new ShalomClient({
      config: CONFIG,
      fetchImpl,
      sleep: async (ms) => void esperas.push(ms),
    });

    const agencias = await client.buscarAgencias({ texto: "miraflores" });
    expect(agencias).toHaveLength(1);
    // Reintentar antes de que se reinicie la ventana solo consume cuota.
    expect(esperas).toEqual([7_000]);
  });

  it("NO reintenta un error de validación", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ error: { code: "bad_request", message: "falta numero" } }, 400),
    );
    const client = new ShalomClient({ config: CONFIG, fetchImpl, sleep: async () => {} });
    await expect(client.buscarAgencias({ texto: "x" })).rejects.toThrow(ShalomError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("traduce un abort a client_timeout", async () => {
    const fetchImpl = vi.fn(async () => {
      const error = new Error("tardó demasiado");
      error.name = "TimeoutError";
      throw error;
    });
    const client = new ShalomClient({
      config: CONFIG,
      fetchImpl,
      sleep: async () => {},
      maxReintentos: 0,
    });
    await expect(client.buscarAgencias()).rejects.toMatchObject({ code: "client_timeout" });
  });

  it("usa timeout largo para las rutas de cuenta y corto para las públicas", async () => {
    // El login real tarda hasta 2 min; un timeout corto lo cortaría antes de
    // terminar aunque la operación siguiera en curso del otro lado.
    const { client, llamadas } = clienteCon([json({ data: [] })], {
      timeoutPublicoMs: 15_000,
      timeoutCuentaMs: 150_000,
    });
    await client.buscarAgencias();
    expect(llamadas[0].init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("lee los headers de rate limit de cada respuesta", async () => {
    const { client } = clienteCon([
      json({ data: [] }, 200, {
        "x-ratelimit-limit": "60",
        "x-ratelimit-remaining": "55",
        "x-ratelimit-reset": "1713200060",
      }),
    ]);
    await client.buscarAgencias();
    expect(client.rateLimit.limite).toBe(60);
    expect(client.rateLimit.restantes).toBe(55);
    expect(client.rateLimit.resetEn?.getTime()).toBe(1713200060 * 1000);
  });

  it("NUNCA filtra la contraseña al mensaje de error, ni si el runtime la incluye", async () => {
    // El riesgo real no es un log deliberado, sino que el `error.message` de
    // `fetch` o el eco de un body de error acaben en un servicio de terceros.
    const fetchImpl = vi.fn(async () => {
      throw new Error(`connect ECONNREFUSED con password=${PASSWORD} y key=${API_KEY}`);
    });
    const client = new ShalomClient({
      config: CONFIG,
      fetchImpl,
      sleep: async () => {},
      maxReintentos: 0,
    });
    try {
      await client.buscarAgencias();
      throw new Error("debió lanzar");
    } catch (error) {
      const serializado = `${(error as Error).message} ${JSON.stringify(error)} ${
        (error as ShalomError).detalle ?? ""
      }`;
      expect(serializado).not.toContain(PASSWORD);
      expect(serializado).not.toContain(API_KEY);
    }
  });

  it("el logger recibe los headers con los valores redactados", async () => {
    const mensajes: string[] = [];
    const { client } = clienteCon([respuestaSesion()], {
      logger: { info: (m: string) => mensajes.push(m), warn: (m: string) => mensajes.push(m) },
    });
    await client.crearSesion();
    const todo = mensajes.join("\n");
    expect(todo).not.toContain(API_KEY);
    expect(todo).not.toContain(PASSWORD);
    expect(todo).toContain(MARCADOR_REDACTADO);
  });

  it("un 2xx con cuerpo que no es JSON es un error explicito", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("OK", { status: 200, headers: { "content-type": "text/plain" } }),
    );
    const client = new ShalomClient({ config: CONFIG, fetchImpl, sleep: async () => {} });
    await expect(client.buscarAgencias()).rejects.toMatchObject({ code: "respuesta_invalida" });
  });

  it("invalida la sesión cacheada al recibir un 401", async () => {
    let logins = 0;
    let tracking = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/sessions")) {
        logins++;
        return respuestaSesion();
      }
      tracking++;
      return tracking === 1
        ? json({ error: { code: "shalom_auth_failed", message: "token vencido" } }, 401)
        : json({ results: [] });
    });
    const client = new ShalomClient({ config: CONFIG, fetchImpl, sleep: async () => {} });
    await client.consultarTrackingLote([{ ref: { tipo: "ose", oseId: "1" } }]).catch(() => {});
    // El 401 no es reintentable, pero sí debe descartar la sesión para que el
    // próximo intento haga login limpio.
    await client.consultarTrackingLote([{ ref: { tipo: "ose", oseId: "1" } }]);
    expect(logins).toBe(2);
  });
});

/** `status` real de un envío entregado, con dos hitos en `null`. */
const STATUS_REAL = {
  registrado: { fecha: "2026-04-15 09:12:30" },
  origen: { fecha: "2026-04-15 09:12:30" },
  transito: { fecha: "2026-04-15 14:08:21", completo: true, carguero: "966345" },
  demora: null,
  destino: { fecha: "2026-04-16 01:01:03", completo: true },
  entregado: { fecha: "2026-04-16 11:40:45" },
  reparto: null,
};

describe("ShalomClient: tracking", () => {
  it("normaliza el status a la línea de tiempo del dominio", async () => {
    const { client } = clienteCon([json({ detailed: false, status: STATUS_REAL })]);
    const { tracking, detallado } = await client.consultarTracking({
      tipo: "guia",
      numero: "82100156",
      codigo: "W79H",
    });
    expect(detallado).toBe(false);
    expect(tracking.entregado).toBe(true);
    expect(tracking.eventos).toHaveLength(5);
    // La fecha es hora de Perú: 11:40 PET son 16:40 UTC.
    const entrega = tracking.eventos.find((e) => e.milestone === "entregado")!;
    expect(entrega.fecha.toISOString()).toBe("2026-04-16T16:40:45.000Z");
  });

  it("manda numero y codigo juntos en el modo público", async () => {
    const { client, llamadas } = clienteCon([json({ detailed: false, status: {} })]);
    await client.consultarTracking({ tipo: "guia", numero: "82100156", codigo: "W79H" });
    expect(llamadas[0].url).toContain("numero=82100156");
    expect(llamadas[0].url).toContain("codigo=W79H");
  });

  it("identifica por ose_id cuando es lo que hay", async () => {
    const { client, llamadas } = clienteCon([json({ detailed: false, status: {} })]);
    await client.consultarTracking({ tipo: "ose", oseId: "584210" });
    expect(llamadas[0].url).toContain("ose_id=584210");
  });

  it("DEGRADA al modo público si las credenciales fallan", async () => {
    // El cliente que espera ver dónde está su paquete no debe quedarse sin
    // respuesta porque nuestra contraseña de Shalom Pro caducó.
    const avisos: string[] = [];
    let paso = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/sessions")) return respuestaSesion();
      paso++;
      return paso === 1
        ? json({ error: { code: "shalom_auth_failed", message: "rechazado" } }, 401)
        : json({ detailed: false, status: STATUS_REAL });
    });
    const client = new ShalomClient({
      config: CONFIG,
      fetchImpl,
      sleep: async () => {},
      logger: { warn: (m) => avisos.push(m), info: () => {} },
    });

    const { tracking, detallado } = await client.consultarTracking(
      { tipo: "guia", numero: "82100156", codigo: "W79H" },
      true,
    );
    expect(detallado).toBe(false);
    expect(tracking.entregado).toBe(true);
    // El fallo sí se loguea, porque hay que arreglarlo.
    expect(avisos.join(" ")).toMatch(/degrada|SHALOM_PRO/i);
  });

  it("no degrada ante un error que no sea de autenticación", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/sessions")) return respuestaSesion();
      return json({ error: { code: "not_found", message: "orden no existe" } }, 404);
    });
    const client = new ShalomClient({ config: CONFIG, fetchImpl, sleep: async () => {} });
    await expect(
      client.consultarTracking({ tipo: "ose", oseId: "0" }, true),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("una respuesta con forma inesperada es un error, no datos a medias", async () => {
    const { client } = clienteCon([json({ status: "esto debería ser un objeto" })]);
    await expect(
      client.consultarTracking({ tipo: "ose", oseId: "1" }),
    ).rejects.toMatchObject({ code: "respuesta_invalida" });
  });
});

describe("ShalomClient: batch", () => {
  it("trocea 137 guías en 3 llamadas de 50, 50 y 37", async () => {
    // El límite de 50 es duro: dejar el troceo al llamador haría que el primer job
    // nocturno con 137 pedidos fallara entero.
    const tamanos: number[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/sessions")) return respuestaSesion();
      const body = JSON.parse(String(init?.body)) as { items: unknown[] };
      tamanos.push(body.items.length);
      return json({ results: body.items.map(() => ({ ok: true, status: {} })) });
    });
    const client = new ShalomClient({ config: CONFIG, fetchImpl, sleep: async () => {} });

    const items = Array.from({ length: 137 }, (_, i) => ({
      customId: `pedido-${i}`,
      ref: { tipo: "ose" as const, oseId: String(i) },
    }));
    const resultados = await client.consultarTrackingLote(items);

    expect(tamanos).toEqual([50, 50, 37]);
    expect(resultados).toHaveLength(137);
  });

  it("un item que falla no invalida los otros 49", async () => {
    // Los errores llegan POR ITEM con status global 200.
    const { client } = clienteCon([
      respuestaSesion(),
      json({
        results: [
          { custom_id: "pedido-001", ok: true, status: STATUS_REAL },
          { custom_id: "pedido-002", ok: false, error: { code: "not_found", message: "no existe" } },
        ],
      }),
    ]);
    const resultados = await client.consultarTrackingLote([
      { customId: "pedido-001", ref: { tipo: "ose", oseId: "1" } },
      { customId: "pedido-002", ref: { tipo: "ose", oseId: "2" } },
    ]);
    expect(resultados[0].ok).toBe(true);
    expect(resultados[0].tracking?.entregado).toBe(true);
    expect(resultados[1].ok).toBe(false);
    expect(resultados[1].error?.code).toBe("not_found");
    expect(resultados[1].tracking).toBeNull();
  });

  it("hace eco del custom_id para casar cada resultado con su pedido", async () => {
    const { client } = clienteCon([
      respuestaSesion(),
      json({ results: [{ custom_id: "pedido-abc", ok: true, status: {} }] }),
    ]);
    const [resultado] = await client.consultarTrackingLote([
      { customId: "pedido-abc", ref: { tipo: "ose", oseId: "1" } },
    ]);
    expect(resultado.customId).toBe("pedido-abc");
  });

  it("cae al customId de entrada si el wrapper no lo devuelve", async () => {
    const { client } = clienteCon([
      respuestaSesion(),
      json({ results: [{ ok: true, status: {} }] }),
    ]);
    const [resultado] = await client.consultarTrackingLote([
      { customId: "pedido-xyz", ref: { tipo: "ose", oseId: "1" } },
    ]);
    expect(resultado.customId).toBe("pedido-xyz");
  });

  it("una respuesta sin array results es un error", async () => {
    const { client } = clienteCon([respuestaSesion(), json({ datos: [] })]);
    await expect(
      client.consultarTrackingLote([{ ref: { tipo: "ose", oseId: "1" } }]),
    ).rejects.toMatchObject({ code: "respuesta_invalida" });
  });
});

describe("ShalomClient: tarifas y agencias", () => {
  it("convierte los soles de la tarifa a céntimos enteros", async () => {
    const { client } = clienteCon([
      respuestaSesion(),
      json({
        currency: "PEN",
        breakdown: {
          sobre: 8,
          caja_paquete_xs: 10.5,
          caja_paquete_s: "12.00",
          otra_medida: 25.15,
        },
        product: { id: 3, title: "Sobre", price: 8 },
      }),
    ]);
    const tarifa = await client.cotizarTarifa({
      terminalOrigenId: "66",
      terminalDestinoId: "7",
    });
    expect(tarifa.moneda).toBe("PEN");
    expect(tarifa.desglose.sobre).toBe(800);
    expect(tarifa.desglose.caja_paquete_xs).toBe(1_050);
    expect(tarifa.desglose.caja_paquete_s).toBe(1_200);
    expect(tarifa.desglose.otra_medida).toBe(2_515);
    expect(tarifa.producto?.precioCents).toBe(800);
  });

  it("acota per_page al máximo del wrapper", async () => {
    // Pedir 1000 devolvería un 400 y el buscador del checkout quedaría vacío.
    const { client, llamadas } = clienteCon([json({ data: [] })]);
    await client.buscarAgencias({ perPage: 5_000 });
    expect(llamadas[0].url).toContain("per_page=500");
  });

  it("pasa las coordenadas como near para ordenar por cercanía", async () => {
    const { client, llamadas } = clienteCon([
      json({ data: [{ id: 190, nombre: "MIRAFLORES", distancia_km: 0.51 }] }),
    ]);
    const agencia = await client.agenciaMasCercana(-12.1211, -77.03);
    expect(llamadas[0].url).toContain("near=-12.1211%2C-77.03");
    expect(agencia?.id).toBe("190");
  });

  it("devuelve null si no hay agencia cerca", async () => {
    const { client } = clienteCon([json({ data: [] })]);
    expect(await client.agenciaMasCercana(-12, -77)).toBeNull();
  });
});

/** Petición de emisión válida, con clave de retiro que Shalom acepta. */
const EMISION = {
  terminalOrigenId: "404",
  terminalDestinoId: "7",
  productoId: "3",
  destinatario: {
    tipoDocumento: "DNI" as const,
    documento: "87654321",
    nombre: "MARIA",
    apellidoPaterno: "GOMEZ",
    apellidoMaterno: "TORRES",
    telefono: "998765432",
  },
  claveRetiro: "2415",
  declaracionJurada: "ropa" as const,
};

const GUIA_CREADA = { guia: "80574902", serie: "v872", codigo: "CJTW", ose_id: 584210 };

/** Guard que afirma que no existe guía previa. */
const sinGuiaPrevia = async () => null;

describe("ShalomClient: emitirGuia", () => {
  it("emite y devuelve los identificadores", async () => {
    const { client } = clienteCon([respuestaSesion(), json(GUIA_CREADA)]);
    const r = await client.emitirGuia(EMISION, true, sinGuiaPrevia);
    expect(r.ok).toBe(true);
    expect(r.ok && r.guia).toEqual({
      guia: "80574902",
      serie: "v872",
      codigo: "CJTW",
      oseId: "584210",
    });
  });

  it("se NIEGA a emitir sin confirmación explícita", async () => {
    // Convierte un uso accidental (un `map` sobre pedidos, el reintento de un job)
    // en un rechazo en vez de en una factura.
    const { client, fetchImpl } = clienteCon([respuestaSesion(), json(GUIA_CREADA)]);
    const r = await client.emitirGuia(
      EMISION,
      false as unknown as true,
      sinGuiaPrevia,
    );
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.mensajeTecnico).toMatch(/confirmacionExplicita/);
    // Y sobre todo: no llegó a llamar a Shalom.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("valida la clave de retiro localmente antes de gastar 150 s", async () => {
    // Shalom rechaza repetidos y consecutivos con un 422, y descubrirlo del lado
    // del servidor cuesta una llamada larga.
    const { client, fetchImpl } = clienteCon([respuestaSesion(), json(GUIA_CREADA)]);
    for (const claveRetiro of ["1111", "1234", "9876", "12", "abcd"]) {
      const r = await client.emitirGuia({ ...EMISION, claveRetiro }, true, sinGuiaPrevia);
      expect(r.ok, claveRetiro).toBe(false);
      expect(r.ok === false && r.mensajeTecnico).toMatch(/clave de retiro/);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("no emite una segunda guía si el guard encuentra una previa", async () => {
    const { client, fetchImpl } = clienteCon([respuestaSesion(), json(GUIA_CREADA)]);
    const existente = { guia: "1", serie: "s", codigo: "ABCD", oseId: "9" };
    const r = await client.emitirGuia(EMISION, true, async () => existente);
    expect(r.ok && r.guia).toEqual(existente);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("NUNCA reintenta sola, ni ante un 503", async () => {
    // Un reintento a ciegas duplicaría un cargo real: no hay idempotencia.
    let emisiones = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/sessions")) return respuestaSesion();
      emisiones++;
      return json({ error: { code: "upstream_unavailable", message: "no responde" } }, 503);
    });
    const client = new ShalomClient({ config: CONFIG, fetchImpl, sleep: async () => {} });
    const r = await client.emitirGuia(EMISION, true, sinGuiaPrevia);
    expect(emisiones).toBe(1);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reintentable).toBe(false);
  });

  it("ante un timeout verifica si la guía se creó antes de decidir", async () => {
    // Un timeout NO significa que la guía no se creó. Este es el riesgo económico
    // central del módulo.
    let guardConsultado = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/sessions")) return respuestaSesion();
      const error = new Error("abortado");
      error.name = "TimeoutError";
      throw error;
    });
    const client = new ShalomClient({ config: CONFIG, fetchImpl, sleep: async () => {} });

    const r = await client.emitirGuia(EMISION, true, async () => {
      guardConsultado++;
      // La segunda consulta descubre que SÍ se había creado.
      return guardConsultado === 2
        ? { guia: "80574902", serie: "v872", codigo: "CJTW", oseId: "584210" }
        : null;
    });

    expect(guardConsultado).toBe(2);
    expect(r.ok).toBe(true);
    expect(r.ok && r.guia.guia).toBe("80574902");
  });

  it("tras un timeout con la guía no creada, exige que reemita un humano", async () => {
    // El listado de órdenes puede tardar en reflejar una guía recién creada, y un
    // reintento automático dentro de esa ventana duplicaría el cargo.
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/sessions")) return respuestaSesion();
      const error = new Error("abortado");
      error.name = "TimeoutError";
      throw error;
    });
    const client = new ShalomClient({ config: CONFIG, fetchImpl, sleep: async () => {} });
    const r = await client.emitirGuia(EMISION, true, sinGuiaPrevia);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reintentable).toBe(false);
    expect(r.ok === false && r.requiereRevisionManual).toBe(true);
  });

  it("si el guard falla ANTES de emitir, no llama a Shalom y es seguro reintentar", async () => {
    // Sin poder comprobar si ya existe una guía, emitir a ciegas es justo lo que
    // duplica un cargo real.
    const { client, fetchImpl } = clienteCon([respuestaSesion(), json(GUIA_CREADA)]);
    const r = await client.emitirGuia(EMISION, true, async () => {
      throw new Error("la tabla local no responde");
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.mensajeTecnico).toMatch(/NO SE EMITIÓ/);
    expect(r.ok === false && r.reintentable).toBe(true);
  });

  it("si el guard falla en la verificación posterior, avisa de NO REEMITIR", async () => {
    // Aquí sí se llamó a Shalom y el resultado es incierto: no queda información
    // con la que decidir, así que la decisión es humana.
    let consultas = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/sessions")) return respuestaSesion();
      throw new Error("network down");
    });
    const client = new ShalomClient({ config: CONFIG, fetchImpl, sleep: async () => {} });
    const r = await client.emitirGuia(EMISION, true, async () => {
      consultas++;
      if (consultas === 1) return null;
      throw new Error("el listado también falló");
    });
    expect(consultas).toBe(2);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.mensajeTecnico).toMatch(/NO REEMITIR/);
    expect(r.ok === false && r.requiereRevisionManual).toBe(true);
  });

  it("un 2xx con respuesta incompleta exige revisión: la guía pudo crearse", async () => {
    // Peor que un error: probablemente existe y no sabemos su número.
    const { client } = clienteCon([respuestaSesion(), json({ mensaje: "ok" })]);
    const r = await client.emitirGuia(EMISION, true, sinGuiaPrevia);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.requiereRevisionManual).toBe(true);
    expect(r.ok === false && r.mensajeTecnico).toMatch(/GET \/v1\/orders/);
  });

  it("un rechazo determinista no pide verificación: no se creó nada", async () => {
    let guardConsultado = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/sessions")) return respuestaSesion();
      return json(
        { error: { code: "upstream_rejected", message: "cuenta sin servicio de cobranza", request_id: "01KQ" } },
        422,
      );
    });
    const client = new ShalomClient({ config: CONFIG, fetchImpl, sleep: async () => {} });
    const r = await client.emitirGuia(EMISION, true, async () => {
      guardConsultado++;
      return null;
    });
    // Solo la verificación previa, no la posterior.
    expect(guardConsultado).toBe(1);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.mensajeTecnico).toContain("01KQ");
    expect(r.ok === false && r.requiereRevisionManual).toBe(true);
  });

  it("manda la declaración jurada, que Shalom exige en toda orden", async () => {
    const { client, llamadas } = clienteCon([respuestaSesion(), json(GUIA_CREADA)]);
    await client.emitirGuia(EMISION, true, sinGuiaPrevia);
    const body = JSON.parse(String(llamadas[1].init?.body)) as Record<string, unknown>;
    expect(body.declaracion_jurada).toBe("ropa");
    expect(body.pickup_code).toBe("2415");
    expect(body.receiver).toMatchObject({ document_type: "DNI", document: "87654321" });
  });

  it("omite los campos opcionales que no se pasan", async () => {
    const { client, llamadas } = clienteCon([respuestaSesion(), json(GUIA_CREADA)]);
    await client.emitirGuia(
      {
        ...EMISION,
        destinatario: { tipoDocumento: "DNI", documento: "87654321", nombre: "MARIA" },
      },
      true,
      sinGuiaPrevia,
    );
    const body = JSON.parse(String(llamadas[1].init?.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty("quantity");
    expect(body).not.toHaveProperty("aereo");
    expect(body.receiver).not.toHaveProperty("last_name");
  });

  it("nunca expone la contraseña en el mensaje técnico", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/sessions")) return respuestaSesion();
      return json({ error: { message: `rechazado con password=${PASSWORD}` } }, 422);
    });
    const client = new ShalomClient({ config: CONFIG, fetchImpl, sleep: async () => {} });
    const r = await client.emitirGuia(EMISION, true, sinGuiaPrevia);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.mensajeTecnico).not.toContain(PASSWORD);
  });
});

describe("ShalomClient: webhooks y suscripciones", () => {
  it("registra el webhook y devuelve el signing_secret", async () => {
    const { client } = clienteCon([
      respuestaSesion(),
      json({ url: "https://tienda.pe/webhooks/shalom", signing_secret: "9f8b1c".padEnd(64, "a") }),
    ]);
    const { signingSecret } = await client.registrarWebhook("https://tienda.pe/webhooks/shalom");
    expect(signingSecret).toHaveLength(64);
  });

  it("rechaza una URL que no sea https", async () => {
    // Shalom rechaza http y localhost; comprobarlo aquí evita gastar un registro.
    const { client, fetchImpl } = clienteCon([respuestaSesion()]);
    await expect(client.registrarWebhook("http://localhost:3000/webhook")).rejects.toThrow(
      /https/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("un registro sin signing_secret avisa de comprobar antes de reintentar", async () => {
    // Cada registro genera un secreto nuevo e invalida el anterior.
    const { client } = clienteCon([respuestaSesion(), json({ url: "https://x.pe/w" })]);
    await expect(client.registrarWebhook("https://x.pe/w")).rejects.toThrow(/antes de reintentar/);
  });

  it("suscribe un envío", async () => {
    const { client } = clienteCon([
      respuestaSesion(),
      json({ id: 812, numero: "80574902", activa: true }),
    ]);
    const r = await client.suscribirEnvio("80574902", "CJTW");
    expect(r.ok).toBe(true);
  });

  it("distingue el cupo agotado del rate limit, porque se resuelven distinto", async () => {
    // Esperar libera el rate limit; el cupo solo se libera cuando se entrega un
    // paquete.
    const { client } = clienteCon([
      respuestaSesion(),
      json({ error: { code: "rate_limited", message: "quota_exceeded" } }, 429),
    ]);
    const r = await client.suscribirEnvio("80574902", "CJTW");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.cupoAgotado).toBe(true);
    expect(r.ok === false && r.motivo).toMatch(/sondeo por lotes/);
  });

  it("un rate limit normal no se marca como cupo agotado", async () => {
    const { client } = clienteCon([
      respuestaSesion(),
      json({ error: { code: "rate_limited", message: "too many requests" } }, 429),
    ]);
    const r = await client.suscribirEnvio("80574902", "CJTW");
    expect(r.ok === false && r.cupoAgotado).toBe(false);
  });

  it("un envío ya suscrito es el resultado deseado, no un fallo", async () => {
    const { client } = clienteCon([
      respuestaSesion(),
      json({ error: { code: "conflict", message: "ya suscrito" } }, 409),
    ]);
    expect((await client.suscribirEnvio("80574902", "CJTW")).ok).toBe(true);
  });
});
