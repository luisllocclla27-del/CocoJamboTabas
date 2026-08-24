import { describe, expect, it } from "vitest";
import { assessRisk, type RiskInput } from "./risk-score";

const PEDIDO_CREADO = new Date("2026-04-15T14:00:00Z");
const PAGO = new Date("2026-04-15T14:20:00Z");
const AHORA = new Date("2026-04-15T15:00:00Z");

/**
 * Caso perfecto: monto exacto, voucher reciente, nada repetido.
 *
 * Cada test parte de aquí y estropea un solo dato, para que el efecto medido sea
 * atribuible a la regla que se está probando.
 */
function entradaPerfecta(sobrescribir: Partial<RiskInput> = {}): RiskInput {
  return {
    montoEsperadoCents: 24937,
    montoVoucherCents: 24937,
    operationNumberYaUsado: false,
    phashDuplicado: false,
    distanciaPhashMinima: 45,
    fechaVoucher: PAGO,
    pedidoCreadoEn: PEDIDO_CREADO,
    ahora: AHORA,
    ocrConfidence: 0.94,
    destinatarioVoucher: "Luis Gómez Ñañez",
    destinatarioEsperado: "Luis Gómez Ñañez",
    tieneExifDeEditor: false,
    esPrimeraCompraDelCliente: false,
    ...sobrescribir,
  };
}

function codigos(input: RiskInput): string[] {
  return assessRisk(input).signals.map((s) => s.codigo);
}

describe("assessRisk: voucher impecable", () => {
  const resultado = assessRisk(entradaPerfecta());

  it("no levanta ninguna señal", () => {
    expect(resultado.signals).toEqual([]);
  });

  it("da score 0 y nivel limpio", () => {
    expect(resultado.score).toBe(0);
    expect(resultado.nivel).toBe("limpio");
  });

  it("es el único caso que habilita la aprobación automática", () => {
    expect(resultado.autoAprobable).toBe(true);
  });
});

describe("assessRisk: la aprobación automática se desactiva ante cualquier duda", () => {
  // Aprobar un pago libera mercadería y en la práctica no se revierte, así que
  // basta una sola señal no informativa para que decida una persona.
  const dudas: [string, Partial<RiskInput>][] = [
    ["monto ilegible", { montoVoucherCents: null }],
    ["monto distinto", { montoVoucherCents: 24900 }],
    ["operación ya usada", { operationNumberYaUsado: true }],
    ["imagen duplicada", { phashDuplicado: true, distanciaPhashMinima: 2 }],
    ["fecha ilegible", { fechaVoucher: null }],
    ["pago anterior al pedido", { fechaVoucher: new Date("2026-04-14T09:00:00Z") }],
    ["voucher de hace días", { fechaVoucher: new Date("2026-04-10T14:00:00Z") }],
    ["metadatos de editor", { tieneExifDeEditor: true }],
    ["OCR poco fiable", { ocrConfidence: 0.4 }],
    ["destinatario distinto", { destinatarioVoucher: "Otra Persona Distinta" }],
  ];

  for (const [descripcion, parche] of dudas) {
    it(`no auto-aprueba con ${descripcion}`, () => {
      const resultado = assessRisk(entradaPerfecta(parche));
      expect(resultado.autoAprobable).toBe(false);
      expect(resultado.score).toBeGreaterThan(0);
    });
  }

  it("tampoco auto-aprueba cuando la única señal es informativa pero suma puntos", () => {
    const resultado = assessRisk(entradaPerfecta({ esPrimeraCompraDelCliente: true }));
    expect(resultado.signals.map((s) => s.severidad)).toEqual(["info"]);
    expect(resultado.autoAprobable).toBe(false);
  });
});

describe("assessRisk: número de operación ya usado", () => {
  const resultado = assessRisk(entradaPerfecta({ operationNumberYaUsado: true }));

  it("es crítico y basta por sí solo para recomendar el rechazo", () => {
    // Es la señal más dura del sistema: un mismo pago no puede cubrir dos
    // pedidos y no hay lectura inocente del duplicado.
    expect(resultado.nivel).toBe("rechazar");
    expect(resultado.signals[0]).toMatchObject({
      codigo: "OPERACION_DUPLICADA",
      severidad: "critico",
    });
  });

  it("sigue siendo solo una recomendación: el módulo nunca rechaza por su cuenta", () => {
    // El contrato no expone ninguna acción, solo un nivel y las razones. Quien
    // rechaza es el admin.
    expect(Object.keys(resultado).sort()).toEqual([
      "autoAprobable",
      "nivel",
      "score",
      "signals",
    ]);
  });
});

describe("assessRisk: imagen duplicada", () => {
  it("es crítica y lleva a recomendar rechazo", () => {
    const resultado = assessRisk(entradaPerfecta({ phashDuplicado: true, distanciaPhashMinima: 3 }));
    expect(resultado.nivel).toBe("rechazar");
    expect(resultado.signals[0]).toMatchObject({ codigo: "PHASH_DUPLICADO", severidad: "critico" });
  });

  it("incluye la distancia perceptual para que el admin pueda juzgar el parecido", () => {
    const { signals } = assessRisk(entradaPerfecta({ phashDuplicado: true, distanciaPhashMinima: 7 }));
    expect(signals[0].mensaje).toContain("7 de 64");
  });

  it("señala explícitamente el caso de imagen idéntica", () => {
    const { signals } = assessRisk(entradaPerfecta({ phashDuplicado: true, distanciaPhashMinima: 0 }));
    expect(signals[0].mensaje).toContain("imagen idéntica");
  });

  it("no inventa una distancia cuando no se pudo calcular", () => {
    const { signals } = assessRisk(
      entradaPerfecta({ phashDuplicado: true, distanciaPhashMinima: null }),
    );
    expect(signals[0].mensaje).not.toContain("Distancia");
  });
});

describe("assessRisk: monto", () => {
  it("trata cualquier diferencia como crítica, aunque sea de un céntimo", () => {
    // Los céntimos del total son el identificador del pedido: con tolerancia, un
    // pago casaría con varios pedidos y el mecanismo entero deja de servir.
    const resultado = assessRisk(entradaPerfecta({ montoVoucherCents: 24936 }));
    expect(resultado.nivel).toBe("rechazar");
    expect(resultado.signals[0]).toMatchObject({
      codigo: "MONTO_NO_COINCIDE",
      severidad: "critico",
    });
  });

  it("muestra ambos importes formateados en soles para que el admin compare", () => {
    const { signals } = assessRisk(entradaPerfecta({ montoVoucherCents: 24900 }));
    expect(signals[0].mensaje).toContain("S/ 249.00");
    expect(signals[0].mensaje).toContain("S/ 249.37");
  });

  it("manda a revisión humana cuando el OCR no leyó el monto, sin recomendar rechazo", () => {
    // No leer el monto es una limitación nuestra, no una conducta del cliente.
    const resultado = assessRisk(entradaPerfecta({ montoVoucherCents: null }));
    expect(resultado.signals[0]).toMatchObject({
      codigo: "MONTO_ILEGIBLE",
      severidad: "advertencia",
    });
    expect(resultado.nivel).not.toBe("rechazar");
  });

  it("no acumula la señal de monto ilegible con la de monto distinto", () => {
    expect(codigos(entradaPerfecta({ montoVoucherCents: null }))).toEqual(["MONTO_ILEGIBLE"]);
  });
});

describe("assessRisk: cronología del pago", () => {
  it("marca como crítico un voucher anterior a la creación del pedido", () => {
    // Imposibilidad lógica: el caso típico es reciclar un voucher de otra compra.
    const resultado = assessRisk(
      entradaPerfecta({ fechaVoucher: new Date("2026-04-15T13:00:00Z") }),
    );
    expect(resultado.nivel).toBe("rechazar");
    expect(resultado.signals[0]).toMatchObject({
      codigo: "FECHA_ANTERIOR_AL_PEDIDO",
      severidad: "critico",
    });
  });

  it("tolera unos minutos de desfase de relojes antes de gritar", () => {
    // Yape muestra la hora al minuto y el reloj del celular no está
    // sincronizado con el servidor: un cliente rapidísimo no debe disparar la
    // señal más grave del sistema.
    const resultado = assessRisk(
      entradaPerfecta({ fechaVoucher: new Date("2026-04-15T13:58:30Z") }),
    );
    expect(codigos(entradaPerfecta({ fechaVoucher: new Date("2026-04-15T13:58:30Z") }))).not.toContain(
      "FECHA_ANTERIOR_AL_PEDIDO",
    );
    expect(resultado.autoAprobable).toBe(true);
  });

  it("advierte cuando el voucher pasa de las 48 horas", () => {
    // El pedido también es viejo: así se aísla la antigüedad de la señal de pago
    // anterior al pedido, que se dispara sola si solo se mueve el voucher.
    const resultado = assessRisk(
      entradaPerfecta({
        fechaVoucher: new Date("2026-04-12T15:00:00Z"),
        pedidoCreadoEn: new Date("2026-04-12T14:00:00Z"),
      }),
    );
    expect(resultado.signals[0]).toMatchObject({
      codigo: "VOUCHER_ANTIGUO",
      severidad: "advertencia",
    });
    expect(resultado.signals[0].mensaje).toContain("72 horas");
  });

  it("no advierte por antigüedad justo por debajo del límite de 48 horas", () => {
    const casi = new Date(AHORA.getTime() - 47 * 3_600_000);
    expect(codigos(entradaPerfecta({ fechaVoucher: casi, pedidoCreadoEn: casi }))).not.toContain(
      "VOUCHER_ANTIGUO",
    );
  });

  it("advierte, sin rechazar, cuando no se pudo leer la fecha", () => {
    const resultado = assessRisk(entradaPerfecta({ fechaVoucher: null }));
    expect(resultado.signals[0]).toMatchObject({
      codigo: "FECHA_ILEGIBLE",
      severidad: "advertencia",
    });
    expect(resultado.nivel).toBe("revisar");
  });
});

describe("assessRisk: metadatos de la imagen", () => {
  it("es solo advertencia, porque la señal tiene falsos positivos conocidos", () => {
    // WhatsApp borra el EXIF y las galerías lo reescriben al rotar o recortar:
    // un editor en los metadatos es compatible con un cliente honesto que tapó
    // su saldo antes de mandar la captura.
    const resultado = assessRisk(entradaPerfecta({ tieneExifDeEditor: true }));
    expect(resultado.signals[0]).toMatchObject({ codigo: "EXIF_EDITOR", severidad: "advertencia" });
    expect(resultado.nivel).toBe("revisar");
  });
});

describe("assessRisk: confianza del OCR", () => {
  it("advierte por debajo de 0.6", () => {
    const resultado = assessRisk(entradaPerfecta({ ocrConfidence: 0.59 }));
    expect(resultado.signals[0]).toMatchObject({
      codigo: "OCR_BAJA_CONFIANZA",
      severidad: "advertencia",
    });
  });

  it("no advierte justo en el umbral", () => {
    expect(codigos(entradaPerfecta({ ocrConfidence: 0.6 }))).not.toContain("OCR_BAJA_CONFIANZA");
  });

  it("no inventa una señal cuando el motor no reportó confianza", () => {
    expect(codigos(entradaPerfecta({ ocrConfidence: null }))).not.toContain("OCR_BAJA_CONFIANZA");
  });
});

describe("assessRisk: destinatario", () => {
  it("advierte, sin rechazar, cuando el nombre no coincide", () => {
    // El OCR falla con nombres propios y Yape los enmascara: la comparación
    // trabaja con información incompleta por diseño de la propia app.
    const resultado = assessRisk(entradaPerfecta({ destinatarioVoucher: "Pedro Ramos Solís" }));
    expect(resultado.signals[0]).toMatchObject({
      codigo: "DESTINATARIO_NO_COINCIDE",
      severidad: "advertencia",
    });
    expect(resultado.nivel).toBe("revisar");
  });

  it("acepta el nombre con tildes perdidas por el OCR", () => {
    expect(
      codigos(entradaPerfecta({ destinatarioVoucher: "LUIS GOMEZ NANEZ" })),
    ).not.toContain("DESTINATARIO_NO_COINCIDE");
  });

  it("acepta el nombre enmascarado a inicial que muestra Yape", () => {
    expect(codigos(entradaPerfecta({ destinatarioVoucher: "Luis G. ***" }))).not.toContain(
      "DESTINATARIO_NO_COINCIDE",
    );
  });

  it("acepta que el voucher muestre solo parte del nombre completo", () => {
    expect(codigos(entradaPerfecta({ destinatarioVoucher: "Luis Gómez" }))).not.toContain(
      "DESTINATARIO_NO_COINCIDE",
    );
  });

  it("no afirma que los nombres difieren cuando falta alguno de los dos", () => {
    // Sin dato no hay comparación posible; inventar la señal sería fabricar
    // sospecha a partir de nada.
    expect(codigos(entradaPerfecta({ destinatarioVoucher: null }))).not.toContain(
      "DESTINATARIO_NO_COINCIDE",
    );
    expect(codigos(entradaPerfecta({ destinatarioEsperado: null }))).not.toContain(
      "DESTINATARIO_NO_COINCIDE",
    );
  });

  it("no afirma que difieren cuando el enmascarado no deja nada comparable", () => {
    expect(codigos(entradaPerfecta({ destinatarioVoucher: "***" }))).not.toContain(
      "DESTINATARIO_NO_COINCIDE",
    );
  });
});

describe("assessRisk: primera compra", () => {
  it("es informativa y pesa poco, porque un cliente nuevo es el objetivo del negocio", () => {
    const resultado = assessRisk(entradaPerfecta({ esPrimeraCompraDelCliente: true }));
    expect(resultado.signals[0]).toMatchObject({ codigo: "PRIMERA_COMPRA", severidad: "info" });
    expect(resultado.score).toBeLessThan(10);
    expect(resultado.nivel).toBe("revisar");
  });
});

describe("assessRisk: niveles y acumulación", () => {
  it("una sola advertencia leve queda en revisar", () => {
    expect(assessRisk(entradaPerfecta({ ocrConfidence: 0.3 })).nivel).toBe("revisar");
  });

  it("varias advertencias juntas escalan a sospechoso", () => {
    // Individualmente son débiles, pero se refuerzan: OCR malo *y* nombre
    // distinto *y* metadatos de editor ya no parecen mala suerte.
    const resultado = assessRisk(
      entradaPerfecta({
        ocrConfidence: 0.3,
        destinatarioVoucher: "Pedro Ramos Solís",
        tieneExifDeEditor: true,
      }),
    );
    expect(resultado.nivel).toBe("sospechoso");
  });

  it("una sola señal crítica alcanza el nivel de rechazo", () => {
    const criticos: Partial<RiskInput>[] = [
      { operationNumberYaUsado: true },
      { phashDuplicado: true, distanciaPhashMinima: 1 },
      { montoVoucherCents: 24000 },
      { fechaVoucher: new Date("2026-04-10T09:00:00Z") },
    ];
    for (const parche of criticos) {
      expect(assessRisk(entradaPerfecta(parche)).nivel).toBe("rechazar");
    }
  });

  it("el score es la suma de los puntos de las señales emitidas", () => {
    const resultado = assessRisk(
      entradaPerfecta({ tieneExifDeEditor: true, esPrimeraCompraDelCliente: true }),
    );
    const suma = resultado.signals.reduce((t, s) => t + s.puntos, 0);
    expect(resultado.score).toBe(suma);
  });
});

describe("assessRisk: orden de las señales", () => {
  it("pone los críticos antes que las advertencias y estas antes que los informativos", () => {
    // La pantalla del admin muestra las primeras señales sin scroll: lo que
    // decide tiene que estar arriba.
    const resultado = assessRisk(
      entradaPerfecta({
        esPrimeraCompraDelCliente: true,
        tieneExifDeEditor: true,
        operationNumberYaUsado: true,
        ocrConfidence: 0.2,
      }),
    );
    expect(resultado.signals.map((s) => s.severidad)).toEqual([
      "critico",
      "advertencia",
      "advertencia",
      "info",
    ]);
  });

  it("dentro de la misma severidad ordena por peso descendente", () => {
    const resultado = assessRisk(
      entradaPerfecta({
        montoVoucherCents: null,
        ocrConfidence: 0.2,
        destinatarioVoucher: "Pedro Ramos Solís",
      }),
    );
    expect(resultado.signals.map((s) => s.codigo)).toEqual([
      "MONTO_ILEGIBLE",
      "DESTINATARIO_NO_COINCIDE",
      "OCR_BAJA_CONFIANZA",
    ]);
  });

  it("acompaña cada señal de un mensaje en español que el admin pueda leer", () => {
    const resultado = assessRisk(
      entradaPerfecta({ operationNumberYaUsado: true, montoVoucherCents: null }),
    );
    for (const señal of resultado.signals) {
      expect(señal.mensaje.length).toBeGreaterThan(20);
      expect(señal.puntos).toBeGreaterThan(0);
    }
  });
});

describe("assessRisk: caso de fraude completo", () => {
  it("acumula críticos y advertencias en un voucher reciclado y editado", () => {
    const resultado = assessRisk(
      entradaPerfecta({
        operationNumberYaUsado: true,
        phashDuplicado: true,
        distanciaPhashMinima: 0,
        montoVoucherCents: 19900,
        fechaVoucher: new Date("2026-04-01T10:00:00Z"),
        tieneExifDeEditor: true,
        esPrimeraCompraDelCliente: true,
      }),
    );
    expect(resultado.nivel).toBe("rechazar");
    expect(resultado.signals.filter((s) => s.severidad === "critico")).toHaveLength(4);
    expect(resultado.autoAprobable).toBe(false);
  });
});
