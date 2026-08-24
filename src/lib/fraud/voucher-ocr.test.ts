import { describe, expect, it } from "vitest";
import { leerVoucher, parseVoucherText, type OcrEngine } from "./voucher-ocr";

/** Instante en hora peruana (UTC-5) para comparar contra lo parseado. */
function peru(
  anio: number,
  mes: number,
  dia: number,
  horas = 0,
  minutos = 0,
  segundos = 0,
): Date {
  return new Date(Date.UTC(anio, mes - 1, dia, horas + 5, minutos, segundos));
}

const VOUCHER_YAPE = `
Yape
¡Yapeaste!
S/ 249.37
Para
Luis Gómez Ñañez
15 abr. 2026 - 09:12 p. m.
N° de operación
01234567
Destino
Yape
`;

const VOUCHER_PLIN = `
Plin
Transferencia exitosa
Monto: S/ 1,249.37
Destinatario: María Fernández Quispe
Fecha: 15/04/2026 21:12
Código de operación: 98765432
`;

describe("parseVoucherText: voucher completo de Yape", () => {
  const data = parseVoucherText(VOUCHER_YAPE);

  it("lee el monto en céntimos enteros", () => {
    expect(data.amountCents).toBe(24937);
  });

  it("lee el número de operación", () => {
    expect(data.operationNumber).toBe("01234567");
  });

  it("lee la fecha con la hora en formato de 12 horas y meridiano separado", () => {
    expect(data.fecha).toEqual(peru(2026, 4, 15, 21, 12));
  });

  it("preserva las tildes y la ñ del nombre del destinatario", () => {
    expect(data.destinatario).toBe("Luis Gómez Ñañez");
  });
});

describe("parseVoucherText: voucher completo de Plin", () => {
  const data = parseVoucherText(VOUCHER_PLIN);

  it("lee montos con separador de miles", () => {
    expect(data.amountCents).toBe(124937);
  });

  it("lee el número de operación tras la etiqueta 'Código de operación'", () => {
    expect(data.operationNumber).toBe("98765432");
  });

  it("lee la fecha numérica en formato peruano día/mes/año con hora de 24 horas", () => {
    expect(data.fecha).toEqual(peru(2026, 4, 15, 21, 12));
  });

  it("lee el destinatario cuando está en la misma línea que la etiqueta", () => {
    expect(data.destinatario).toBe("María Fernández Quispe");
  });
});

describe("parseVoucherText: montos", () => {
  const casos: [string, number][] = [
    ["S/ 249.37", 24937],
    ["S/249.37", 24937],
    ["S/. 249.37", 24937],
    ["S/ 1,249.37", 124937],
    ["s/ 1249.37", 124937],
    ["S / 89.05", 8905],
    ["Total S/ 12,345.67", 1234567],
  ];

  for (const [texto, esperado] of casos) {
    it(`lee "${texto}" como ${esperado} céntimos`, () => {
      expect(parseVoucherText(texto).amountCents).toBe(esperado);
    });
  }

  it("interpreta el formato con coma decimal, que aparece cuando el OCR invierte los separadores", () => {
    expect(parseVoucherText("S/ 1.249,37").amountCents).toBe(124937);
  });

  it("interpreta el caso en que el OCR lee la coma de miles como punto", () => {
    // "S/ 1.249.37": el último separador es el decimal y el primero agrupa.
    expect(parseVoucherText("S/ 1.249.37").amountCents).toBe(124937);
  });

  it("trata tres dígitos finales como grupo de miles, porque no existen milésimas de sol", () => {
    expect(parseVoucherText("S/ 1.249").amountCents).toBe(124900);
    expect(parseVoucherText("S/ 1,249").amountCents).toBe(124900);
  });

  it("lee montos sin parte decimal", () => {
    expect(parseVoucherText("S/ 250").amountCents).toBe(25000);
  });

  it("devuelve null con un solo dígito decimal en vez de adivinar el céntimo", () => {
    // 249.3 puede ser 249.30 o un 249.37 con el último dígito perdido, y los
    // céntimos son el identificador del pedido: adivinar apuntaría a otro pedido.
    expect(parseVoucherText("S/ 249.3").amountCents).toBeNull();
  });

  it("devuelve null cuando la agrupación de miles es incoherente", () => {
    expect(parseVoucherText("S/ 1,2349.37").amountCents).toBeNull();
  });

  it("devuelve null cuando no hay ningún importe reconocible", () => {
    expect(parseVoucherText("Operación exitosa\nGracias por usar Yape").amountCents).toBeNull();
  });

  it("ignora números que no vienen precedidos del símbolo de soles", () => {
    // El número de operación y la fecha son dígitos, y sin exigir "S/" los
    // confundiría con importes.
    expect(parseVoucherText("N° de operación 01234567\n15/04/2026").amountCents).toBeNull();
  });

  it("devuelve null cuando hay dos importes distintos y nada que los desempate", () => {
    expect(parseVoucherText("S/ 249.37\nSaldo disponible S/ 512.80").amountCents).toBeNull();
  });

  it("elige el importe rotulado cuando conviven varios en el voucher", () => {
    const texto = "Saldo disponible S/ 512.80\nMonto S/ 249.37";
    expect(parseVoucherText(texto).amountCents).toBe(24937);
  });

  it("acepta el mismo importe repetido en varias líneas", () => {
    expect(parseVoucherText("S/ 249.37\nPagaste S/ 249.37").amountCents).toBe(24937);
  });

  it("descarta importes absurdos que solo pueden venir de un error de OCR", () => {
    expect(parseVoucherText("S/ 999999999.99").amountCents).toBeNull();
  });

  it("descarta un importe de cero, que ningún voucher real muestra", () => {
    expect(parseVoucherText("S/ 0.00").amountCents).toBeNull();
  });
});

describe("parseVoucherText: número de operación", () => {
  const etiquetas = [
    "N° de operación 01234567",
    "Nro de operación 01234567",
    "Nro. de operación: 01234567",
    "N. de operacion 01234567",
    "Código de operación 01234567",
    "Cod. de operación: 01234567",
    "Operación: 01234567",
    "Número de operación 01234567",
    "Operación N° 01234567",
  ];

  for (const linea of etiquetas) {
    it(`reconoce la etiqueta en "${linea}"`, () => {
      expect(parseVoucherText(linea).operationNumber).toBe("01234567");
    });
  }

  it("normaliza las O que el OCR confunde con ceros", () => {
    expect(parseVoucherText("N° de operación O123456O").operationNumber).toBe("01234560");
  });

  it("lee el número de la línea siguiente cuando la app parte el rótulo", () => {
    expect(parseVoucherText("N° de operación\n01234567").operationNumber).toBe("01234567");
  });

  it("reconstruye un número que el OCR partió con un espacio", () => {
    expect(parseVoucherText("N° de operación 0123 4567").operationNumber).toBe("01234567");
  });

  it("acepta números más largos que los 8 dígitos típicos de Yape", () => {
    expect(parseVoucherText("Código de operación 004512300987").operationNumber).toBe(
      "004512300987",
    );
  });

  it("devuelve null cuando no hay etiqueta de operación", () => {
    expect(parseVoucherText("S/ 249.37\nPara Luis Gómez").operationNumber).toBeNull();
  });

  it("devuelve null cuando tras la etiqueta no hay dígitos suficientes", () => {
    // Cuatro dígitos no son un número de operación; es más probable que el OCR
    // haya cortado el campo, y un número truncado no sirve para detectar
    // duplicados.
    expect(parseVoucherText("N° de operación 123").operationNumber).toBeNull();
  });

  it("no confunde una fecha con un número de operación", () => {
    expect(parseVoucherText("Operación: 15/04/2026").operationNumber).toBeNull();
  });
});

describe("parseVoucherText: fechas", () => {
  it("lee meses en español abreviados con punto", () => {
    expect(parseVoucherText("15 abr. 2026 - 09:12 p. m.").fecha).toEqual(peru(2026, 4, 15, 21, 12));
  });

  it("lee meses en español completos con la preposición 'de'", () => {
    expect(parseVoucherText("15 de abril de 2026 21:12").fecha).toEqual(peru(2026, 4, 15, 21, 12));
  });

  it("acepta 'set.' además de 'sep.', que es la forma habitual en Perú", () => {
    expect(parseVoucherText("03 set. 2026 - 10:05 a. m.").fecha).toEqual(peru(2026, 9, 3, 10, 5));
  });

  it("tolera las variantes de espaciado del meridiano que produce el OCR", () => {
    const variantes = ["09:12p.m.", "09:12 pm", "09:12 P. M.", "09:12  p . m ."];
    for (const hora of variantes) {
      expect(parseVoucherText(`15 abr. 2026 ${hora}`).fecha).toEqual(peru(2026, 4, 15, 21, 12));
    }
  });

  it("interpreta 12 a. m. como medianoche y 12 p. m. como mediodía", () => {
    expect(parseVoucherText("15 abr. 2026 - 12:30 a. m.").fecha).toEqual(peru(2026, 4, 15, 0, 30));
    expect(parseVoucherText("15 abr. 2026 - 12:30 p. m.").fecha).toEqual(peru(2026, 4, 15, 12, 30));
  });

  it("interpreta la fecha numérica como día/mes/año, la convención peruana", () => {
    // 04/03 es el 4 de marzo, no el 3 de abril.
    expect(parseVoucherText("04/03/2026 08:00").fecha).toEqual(peru(2026, 3, 4, 8, 0));
  });

  it("acepta guiones y puntos como separadores de la fecha numérica", () => {
    expect(parseVoucherText("15-04-2026 21:12").fecha).toEqual(peru(2026, 4, 15, 21, 12));
    expect(parseVoucherText("15.04.2026 21:12").fecha).toEqual(peru(2026, 4, 15, 21, 12));
  });

  it("completa el siglo en años de dos dígitos", () => {
    expect(parseVoucherText("15/04/26 21:12").fecha).toEqual(peru(2026, 4, 15, 21, 12));
  });

  it("usa medianoche cuando el voucher trae fecha pero no hora legible", () => {
    expect(parseVoucherText("15 abr. 2026").fecha).toEqual(peru(2026, 4, 15));
  });

  it("interpreta la hora en zona peruana y no en la del servidor", () => {
    // Verifica el desfase fijo -05:00: las 21:12 de Perú son las 02:12 UTC del
    // día siguiente. Sin esto, un servidor en UTC desplazaría el instante y
    // rompería la comprobación de que el pago es posterior al pedido.
    const fecha = parseVoucherText("15 abr. 2026 - 09:12 p. m.").fecha;
    expect(fecha?.toISOString()).toBe("2026-04-16T02:12:00.000Z");
  });

  it("devuelve null ante un día imposible en vez de desbordar al mes siguiente", () => {
    expect(parseVoucherText("31/02/2026 10:00").fecha).toBeNull();
  });

  it("devuelve null cuando el mes no es un mes en español", () => {
    expect(parseVoucherText("15 xyz. 2026 - 09:12 p. m.").fecha).toBeNull();
  });

  it("devuelve null cuando no hay ninguna fecha en el texto", () => {
    expect(parseVoucherText("S/ 249.37\nOperación: 01234567").fecha).toBeNull();
  });
});

describe("parseVoucherText: nombres", () => {
  it("lee el destinatario de la línea siguiente a la etiqueta 'Para'", () => {
    expect(parseVoucherText("Para\nLuis Gómez Ñañez\nS/ 249.37").destinatario).toBe(
      "Luis Gómez Ñañez",
    );
  });

  const etiquetas = ["Para:", "Destinatario:", "Enviado a", "Beneficiario:"];
  for (const etiqueta of etiquetas) {
    it(`reconoce la etiqueta "${etiqueta}"`, () => {
      expect(parseVoucherText(`${etiqueta} Ana Ríos`).destinatario).toBe("Ana Ríos");
    });
  }

  it("lee el emisor cuando el voucher lo rotula", () => {
    expect(parseVoucherText("De: Carlos Chávez\nPara: Ana Ríos").emisor).toBe("Carlos Chávez");
  });

  it("no confunde 'Destinatario' con la etiqueta 'De' del emisor", () => {
    const data = parseVoucherText("Destinatario: Ana Ríos");
    expect(data.destinatario).toBe("Ana Ríos");
    expect(data.emisor).toBeNull();
  });

  it("conserva el enmascarado parcial que aplica Yape a los nombres", () => {
    expect(parseVoucherText("Para\nLuis G. ***").destinatario).toBe("Luis G. ***");
  });

  it("no toma como nombre la línea siguiente si contiene otro campo", () => {
    expect(parseVoucherText("Para\nN° de operación 01234567").destinatario).toBeNull();
    expect(parseVoucherText("Para\nS/ 249.37").destinatario).toBeNull();
  });

  it("devuelve null cuando no hay etiqueta de nombre", () => {
    const data = parseVoucherText("S/ 249.37\n15 abr. 2026");
    expect(data.destinatario).toBeNull();
    expect(data.emisor).toBeNull();
  });
});

describe("parseVoucherText: robustez ante texto sucio", () => {
  it("sobrevive a un texto vacío devolviendo todo en null", () => {
    expect(parseVoucherText("")).toEqual({
      operationNumber: null,
      amountCents: null,
      fecha: null,
      destinatario: null,
      emisor: null,
    });
  });

  it("normaliza espacios dobles, tabulaciones y espacios no separables", () => {
    const sucio = "Monto:\t\tS/\u00a0 249.37\n\n\nPara \u00a0 Luis   Gómez";
    const data = parseVoucherText(sucio);
    expect(data.amountCents).toBe(24937);
    expect(data.destinatario).toBe("Luis Gómez");
  });

  it("ignora caracteres invisibles que meten los portapapeles", () => {
    const data = parseVoucherText("\ufeffS/ 249.37\u200b\nN° de operación\u200e 01234567");
    expect(data.amountCents).toBe(24937);
    expect(data.operationNumber).toBe("01234567");
  });

  it("parsea un voucher de Yape realista con ruido de OCR alrededor", () => {
    // Texto tal como sale de un OCR mediocre: cabecera y pie basura, saltos de
    // línea de más, y la marca del monto pegada al número.
    const crudo = [
      "yape |||",
      "",
      "¡Yapeaste!",
      "S/249.37",
      "",
      "Para",
      "Rocío Ñopo Bermúdez",
      "*** 789",
      "",
      "15 abr. 2026 - 9:12 p.m.",
      "Nro. de operación:",
      "O1234567",
      "",
      "~~~ Comparte tu constancia ~~~",
    ].join("\n");

    const data = parseVoucherText(crudo);
    expect(data.amountCents).toBe(24937);
    expect(data.destinatario).toBe("Rocío Ñopo Bermúdez");
    expect(data.fecha).toEqual(peru(2026, 4, 15, 21, 12));
    // Siete dígitos más la O normalizada: el número real tenía un cero delante.
    expect(data.operationNumber).toBe("01234567");
  });
});

describe("leerVoucher", () => {
  it("devuelve los datos parseados junto a la confianza que reporta el motor", async () => {
    const engine: OcrEngine = async () => ({ text: VOUCHER_YAPE, confidence: 0.91 });
    const { data, confidence, text } = await leerVoucher(new Uint8Array([1, 2, 3]), engine);
    expect(data.amountCents).toBe(24937);
    expect(confidence).toBe(0.91);
    expect(text).toBe(VOUCHER_YAPE);
  });

  it("no filtra por confianza: entrega el resultado incluso con reconocimiento pobre", () => {
    // La decisión de qué hacer con un OCR malo es del score de riesgo, que tiene
    // el contexto del pedido; aquí solo se transporta el dato.
    const engine: OcrEngine = async () => ({ text: "basura ilegible", confidence: 0.12 });
    return expect(leerVoucher(new Uint8Array(), engine)).resolves.toMatchObject({
      confidence: 0.12,
      data: { amountCents: null, operationNumber: null },
    });
  });
});
