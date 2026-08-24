import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import {
  buildAuthorizationHeader,
  computeTupaySignature,
  formatTupayDate,
  isWithinDateWindow,
  normalizeSignatureHeader,
  parseTupayDate,
  TUPAY_AUTH_PREFIX,
  verifyTupaySignature,
} from "./signature";

const SECRET = "api-signature-de-prueba-no-real";
const LOGIN = "api-key-de-prueba";
const X_DATE = "2026-08-19T10:30:00Z";
const PAYLOAD = JSON.stringify({
  country: "PE",
  currency: "PEN",
  amount: 249.37,
  invoice_id: "COCO-7F3K2M",
});

describe("computeTupaySignature", () => {
  it("firma la concatenación X-Date + X-Login + payload con HMAC-SHA256 hex", () => {
    // Referencia calculada de forma independiente: si alguien cambia el orden de
    // concatenación, este test lo detecta aunque el resto siga funcionando.
    const esperada = createHmac("sha256", SECRET).update(X_DATE + LOGIN + PAYLOAD).digest("hex");
    expect(computeTupaySignature({ xDate: X_DATE, xLogin: LOGIN, payload: PAYLOAD, secret: SECRET })).toBe(
      esperada,
    );
  });

  it("devuelve hex minúsculas de 64 caracteres", () => {
    const firma = computeTupaySignature({
      xDate: X_DATE,
      xLogin: LOGIN,
      payload: PAYLOAD,
      secret: SECRET,
    });
    expect(firma).toMatch(/^[0-9a-f]{64}$/);
  });

  it("cambia si cambia un solo byte del payload", () => {
    const original = computeTupaySignature({
      xDate: X_DATE,
      xLogin: LOGIN,
      payload: PAYLOAD,
      secret: SECRET,
    });
    // 249.37 → 249.38: un céntimo de diferencia debe invalidar la firma.
    const alterado = computeTupaySignature({
      xDate: X_DATE,
      xLogin: LOGIN,
      payload: PAYLOAD.replace("249.37", "249.38"),
      secret: SECRET,
    });
    expect(alterado).not.toBe(original);
  });

  it("cambia si cambia el orden de las claves del mismo objeto", () => {
    // Este es el escenario que justifica pasar el payload como string: dos
    // serializaciones del mismo objeto con orden distinto firman distinto, así que
    // hay que firmar exactamente los bytes que se envían.
    const a = JSON.stringify({ amount: 249.37, invoice_id: "COCO-7F3K2M" });
    const b = JSON.stringify({ invoice_id: "COCO-7F3K2M", amount: 249.37 });
    expect(a).not.toBe(b);
    expect(
      computeTupaySignature({ xDate: X_DATE, xLogin: LOGIN, payload: a, secret: SECRET }),
    ).not.toBe(computeTupaySignature({ xDate: X_DATE, xLogin: LOGIN, payload: b, secret: SECRET }));
  });

  it("cambia si cambia el X-Date o el X-Login", () => {
    const base = computeTupaySignature({
      xDate: X_DATE,
      xLogin: LOGIN,
      payload: PAYLOAD,
      secret: SECRET,
    });
    expect(
      computeTupaySignature({
        xDate: "2026-08-19T10:30:01Z",
        xLogin: LOGIN,
        payload: PAYLOAD,
        secret: SECRET,
      }),
    ).not.toBe(base);
    expect(
      computeTupaySignature({ xDate: X_DATE, xLogin: "otra-key", payload: PAYLOAD, secret: SECRET }),
    ).not.toBe(base);
  });

  it("trata el payload como UTF-8 y no como latin1", () => {
    // Un apellido acentuado debe producir la misma firma que el HMAC sobre los
    // bytes UTF-8 explícitos. Si se firmara en latin1, "Muñoz" daría otros bytes.
    const conTilde = JSON.stringify({ last_name: "Muñoz Peña" });
    const esperada = createHmac("sha256", Buffer.from(SECRET, "utf8"))
      .update(Buffer.from(X_DATE + LOGIN + conTilde, "utf8"))
      .digest("hex");
    expect(
      computeTupaySignature({ xDate: X_DATE, xLogin: LOGIN, payload: conTilde, secret: SECRET }),
    ).toBe(esperada);
  });

  it("falla ruidosamente si la secret está vacía, en vez de firmar con clave vacía", () => {
    expect(() =>
      computeTupaySignature({ xDate: X_DATE, xLogin: LOGIN, payload: PAYLOAD, secret: "" }),
    ).toThrow(/TUPAY_API_SECRET/);
  });
});

describe("buildAuthorizationHeader", () => {
  it("antepone el prefijo TUPAY que exige la cabecera Authorization", () => {
    const header = buildAuthorizationHeader({
      xDate: X_DATE,
      xLogin: LOGIN,
      payload: PAYLOAD,
      secret: SECRET,
    });
    expect(header.startsWith(TUPAY_AUTH_PREFIX)).toBe(true);
    expect(header.slice(TUPAY_AUTH_PREFIX.length)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("normalizeSignatureHeader", () => {
  it("acepta la firma con prefijo, sin prefijo, en mayúsculas y con espacios", () => {
    const firma = computeTupaySignature({
      xDate: X_DATE,
      xLogin: LOGIN,
      payload: PAYLOAD,
      secret: SECRET,
    });
    expect(normalizeSignatureHeader(`TUPAY ${firma}`)).toBe(firma);
    expect(normalizeSignatureHeader(firma)).toBe(firma);
    expect(normalizeSignatureHeader(`  TUPAY   ${firma.toUpperCase()}  `)).toBe(firma);
  });
});

describe("verifyTupaySignature", () => {
  const firmaValida = computeTupaySignature({
    xDate: X_DATE,
    xLogin: LOGIN,
    payload: PAYLOAD,
    secret: SECRET,
  });

  it("acepta la firma correcta con y sin prefijo", () => {
    for (const header of [firmaValida, `TUPAY ${firmaValida}`, firmaValida.toUpperCase()]) {
      expect(
        verifyTupaySignature({
          signatureHeader: header,
          xDate: X_DATE,
          xLogin: LOGIN,
          payload: PAYLOAD,
          secret: SECRET,
        }),
      ).toBe(true);
    }
  });

  it("rechaza una firma correcta calculada sobre otro payload", () => {
    expect(
      verifyTupaySignature({
        signatureHeader: firmaValida,
        xDate: X_DATE,
        xLogin: LOGIN,
        payload: PAYLOAD.replace("249.37", "1.00"),
        secret: SECRET,
      }),
    ).toBe(false);
  });

  it("rechaza firmas de longitud distinta sin lanzar excepción", () => {
    // `timingSafeEqual` lanza con longitudes distintas: una firma truncada es
    // justo lo que enviaría alguien probando el endpoint, y debe devolver false.
    const casos = [
      "",
      "abc",
      firmaValida.slice(0, 63),
      firmaValida + "0",
      "TUPAY ",
      "x".repeat(200),
    ];
    for (const header of casos) {
      expect(() =>
        verifyTupaySignature({
          signatureHeader: header,
          xDate: X_DATE,
          xLogin: LOGIN,
          payload: PAYLOAD,
          secret: SECRET,
        }),
      ).not.toThrow();
      expect(
        verifyTupaySignature({
          signatureHeader: header,
          xDate: X_DATE,
          xLogin: LOGIN,
          payload: PAYLOAD,
          secret: SECRET,
        }),
      ).toBe(false);
    }
  });

  it("devuelve false en vez de lanzar cuando falta la secret", () => {
    // El endpoint de notificaciones no debe caer con un 500 por una variable de
    // entorno ausente: se comporta como firma inválida.
    expect(() =>
      verifyTupaySignature({
        signatureHeader: firmaValida,
        xDate: X_DATE,
        xLogin: LOGIN,
        payload: PAYLOAD,
        secret: "",
      }),
    ).not.toThrow();
    expect(
      verifyTupaySignature({
        signatureHeader: firmaValida,
        xDate: X_DATE,
        xLogin: LOGIN,
        payload: PAYLOAD,
        secret: "",
      }),
    ).toBe(false);
  });

  it("rechaza una firma hecha con otra secret", () => {
    const ajena = computeTupaySignature({
      xDate: X_DATE,
      xLogin: LOGIN,
      payload: PAYLOAD,
      secret: "otra-secret-igual-de-larga-que-la-buena",
    });
    expect(
      verifyTupaySignature({
        signatureHeader: ajena,
        xDate: X_DATE,
        xLogin: LOGIN,
        payload: PAYLOAD,
        secret: SECRET,
      }),
    ).toBe(false);
  });
});

describe("formatTupayDate", () => {
  it("emite yyyy-MM-ddTHH:mm:ssZ sin milisegundos", () => {
    expect(formatTupayDate(new Date("2026-08-19T10:30:00.123Z"))).toBe("2026-08-19T10:30:00Z");
  });

  it("rellena con ceros y usa siempre UTC", () => {
    expect(formatTupayDate(new Date("2026-01-02T03:04:05Z"))).toBe("2026-01-02T03:04:05Z");
    // Un instante expresado en -05:00 (hora de Perú) debe salir en UTC.
    expect(formatTupayDate(new Date("2026-01-02T03:04:05-05:00"))).toBe("2026-01-02T08:04:05Z");
  });

  it("nunca produce el formato con milisegundos que Tupay rechaza", () => {
    expect(formatTupayDate(new Date("2026-08-19T10:30:00.999Z"))).not.toContain(".");
  });

  it("lanza con una fecha inválida en vez de emitir 'Invalid Date'", () => {
    expect(() => formatTupayDate(new Date("no es fecha"))).toThrow(/fecha inválida/);
  });
});

describe("parseTupayDate", () => {
  it("acepta el formato exigido, con Z y con desplazamiento", () => {
    expect(parseTupayDate("2026-08-19T10:30:00Z")?.toISOString()).toBe("2026-08-19T10:30:00.000Z");
    expect(parseTupayDate("2026-08-19T05:30:00-05:00")?.toISOString()).toBe(
      "2026-08-19T10:30:00.000Z",
    );
  });

  it("rechaza formatos laxos que new Date() aceptaría", () => {
    // Delegar en `new Date()` haría que "2026" pasara la ventana por accidente.
    for (const malo of ["2026", "2026-08-19", "19/08/2026", "2026-08-19T10:30:00.000Z", ""]) {
      expect(parseTupayDate(malo)).toBeNull();
    }
  });
});

describe("isWithinDateWindow", () => {
  const ahora = new Date("2026-08-19T10:30:00Z");

  it("acepta un X-Date del mismo instante", () => {
    expect(isWithinDateWindow("2026-08-19T10:30:00Z", ahora)).toBe(true);
  });

  it("acepta el desfase de reloj dentro de la ventana, en ambos sentidos", () => {
    expect(isWithinDateWindow("2026-08-19T10:26:00Z", ahora)).toBe(true);
    expect(isWithinDateWindow("2026-08-19T10:34:00Z", ahora)).toBe(true);
  });

  it("rechaza un X-Date viejo: es el escenario de replay de una notificación capturada", () => {
    expect(isWithinDateWindow("2026-08-19T10:24:00Z", ahora)).toBe(false);
    expect(isWithinDateWindow("2026-08-19T08:00:00Z", ahora)).toBe(false);
  });

  it("rechaza un X-Date del futuro: una firma adelantada seguiría válida durante horas", () => {
    expect(isWithinDateWindow("2026-08-19T10:36:00Z", ahora)).toBe(false);
    expect(isWithinDateWindow("2026-08-19T23:00:00Z", ahora)).toBe(false);
  });

  it("es exacta en el borde de la ventana", () => {
    expect(isWithinDateWindow("2026-08-19T10:25:00Z", ahora, 300)).toBe(true);
    expect(isWithinDateWindow("2026-08-19T10:24:59Z", ahora, 300)).toBe(false);
    expect(isWithinDateWindow("2026-08-19T10:35:00Z", ahora, 300)).toBe(true);
    expect(isWithinDateWindow("2026-08-19T10:35:01Z", ahora, 300)).toBe(false);
  });

  it("respeta una ventana personalizada", () => {
    expect(isWithinDateWindow("2026-08-19T10:30:30Z", ahora, 10)).toBe(false);
    expect(isWithinDateWindow("2026-08-19T10:30:05Z", ahora, 10)).toBe(true);
  });

  it("rechaza un X-Date ilegible en vez de dejarlo pasar", () => {
    expect(isWithinDateWindow("cualquier cosa", ahora)).toBe(false);
  });
});
