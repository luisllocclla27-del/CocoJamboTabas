import { describe, expect, it } from "vitest";
import {
  encontrarMasParecido,
  hammingDistance,
  isLikelySameImage,
  perceptualHash,
  UMBRAL_HAMMING_POR_DEFECTO,
  type GrayscaleImage,
} from "./phash";

/* ------------------------------------------------------ utilidades de test */

/** Imagen sintética a partir de una función de luminancia. */
function generar(
  width: number,
  height: number,
  fn: (x: number, y: number) => number,
): GrayscaleImage {
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      pixels[y * width + x] = Math.max(0, Math.min(255, Math.round(fn(x, y))));
    }
  }
  return { width, height, pixels };
}

/**
 * PRNG determinista.
 *
 * `Math.random` haría que un fallo de robustez del hash apareciera solo en
 * algunas ejecuciones, que es la peor forma de enterarse.
 */
function prng(semilla: number): () => number {
  let estado = semilla >>> 0;
  return () => {
    estado = (estado * 1664525 + 1013904223) >>> 0;
    return estado / 0x100000000;
  };
}

/** Ruido uniforme: aproxima el grano que deja la recompresión JPEG. */
function conRuido(image: GrayscaleImage, amplitud: number, semilla = 7): GrayscaleImage {
  const rnd = prng(semilla);
  const pixels = new Uint8Array(image.pixels.length);
  for (let i = 0; i < pixels.length; i++) {
    const delta = (rnd() * 2 - 1) * amplitud;
    pixels[i] = Math.max(0, Math.min(255, Math.round(image.pixels[i] + delta)));
  }
  return { width: image.width, height: image.height, pixels };
}

function conBrillo(image: GrayscaleImage, delta: number): GrayscaleImage {
  const pixels = new Uint8Array(image.pixels.length);
  for (let i = 0; i < pixels.length; i++) {
    pixels[i] = Math.max(0, Math.min(255, image.pixels[i] + delta));
  }
  return { width: image.width, height: image.height, pixels };
}

/** Reduce a la mitad promediando: imita el reescalado que aplica WhatsApp. */
function mitad(image: GrayscaleImage): GrayscaleImage {
  const width = Math.floor(image.width / 2);
  const height = Math.floor(image.height / 2);
  const pixels = new Uint8Array(width * height);
  const p = image.pixels;
  const w = image.width;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const suma =
        p[2 * y * w + 2 * x] +
        p[2 * y * w + 2 * x + 1] +
        p[(2 * y + 1) * w + 2 * x] +
        p[(2 * y + 1) * w + 2 * x + 1];
      pixels[y * width + x] = Math.round(suma / 4);
    }
  }
  return { width, height, pixels };
}

/** Recorte simétrico: imita al cliente que corta los bordes de la captura. */
function recortar(image: GrayscaleImage, margen: number): GrayscaleImage {
  const width = image.width - 2 * margen;
  const height = image.height - 2 * margen;
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      pixels[y * width + x] = image.pixels[(y + margen) * image.width + (x + margen)];
    }
  }
  return { width, height, pixels };
}

/**
 * Voucher sintético: cabecera y renglones de texto de longitud variable.
 *
 * Se usa esto en vez de gradientes o tableros para medir la robustez porque es
 * el tipo de imagen que el sistema recibe de verdad. Todos los vouchers
 * comparten la cabecera y la retícula de renglones (la plantilla de Yape) y se
 * diferencian en la longitud y posición de los renglones, que es exactamente la
 * situación que hace difícil el problema.
 */
function voucherSintetico(semilla: number): GrayscaleImage {
  const rnd = prng(semilla);
  const renglones: { y: number; x0: number; x1: number; tono: number }[] = [];
  for (let i = 0; i < 9; i++) {
    const x0 = 20 + Math.floor(rnd() * 30);
    renglones.push({
      y: 40 + i * 22,
      x0,
      x1: x0 + 40 + Math.floor(rnd() * 150),
      tono: 30 + Math.floor(rnd() * 60),
    });
  }
  return generar(240, 300, (x, y) => {
    if (y < 30) return 90; // banda de cabecera, igual en todos los vouchers
    for (const r of renglones) {
      if (y >= r.y && y < r.y + 10 && x >= r.x0 && x < r.x1) return r.tono;
    }
    return 245;
  });
}

const voucherA = voucherSintetico(1);
const voucherB = voucherSintetico(2);
const voucherC = voucherSintetico(9);

const gradienteDiagonal = generar(128, 128, (x, y) => (x + y) * 0.9);
const tableroAjedrez = generar(128, 128, (x, y) =>
  (Math.floor(x / 16) + Math.floor(y / 16)) % 2 === 0 ? 30 : 220,
);
const franjasVerticales = generar(128, 128, (x) => (Math.floor(x / 8) % 2 === 0 ? 20 : 235));
const circuloCentrado = generar(128, 128, (x, y) => (Math.hypot(x - 64, y - 64) < 40 ? 40 : 210));

/* ------------------------------------------------------------------ tests */

describe("perceptualHash: forma del hash", () => {
  it("devuelve 16 caracteres hexadecimales en minúscula", () => {
    for (const img of [voucherA, gradienteDiagonal, tableroAjedrez, circuloCentrado]) {
      expect(perceptualHash(img)).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it("es determinista: la misma imagen da siempre el mismo hash", () => {
    const primero = perceptualHash(voucherA);
    for (let i = 0; i < 5; i++) {
      expect(perceptualHash(voucherA)).toBe(primero);
    }
  });

  it("rechaza imágenes cuyo array de píxeles no cuadra con las dimensiones", () => {
    expect(() => perceptualHash({ width: 10, height: 10, pixels: new Uint8Array(50) })).toThrow(
      /no coincide/,
    );
  });

  it("rechaza dimensiones inválidas en vez de devolver un hash sin sentido", () => {
    expect(() => perceptualHash({ width: 0, height: 5, pixels: new Uint8Array(0) })).toThrow(
      /dimensiones/,
    );
  });

  it("funciona con imágenes más pequeñas que la ventana de 32x32", () => {
    // El promedio por área tiene que tolerar bloques de menos de un píxel de
    // lado sin dejar celdas vacías.
    expect(perceptualHash(generar(9, 7, (x, y) => x * 20 + y * 10))).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("perceptualHash: tolerancia a transformaciones inocuas", () => {
  it("no cambia con ruido leve, como el de una recompresión JPEG", () => {
    const original = perceptualHash(voucherA);
    for (const semilla of [1, 2, 3, 4, 5]) {
      const ruidoso = perceptualHash(conRuido(voucherA, 12, semilla));
      expect(hammingDistance(original, ruidoso)).toBeLessThan(UMBRAL_HAMMING_POR_DEFECTO);
    }
  });

  it("aguanta ruido fuerte más un cambio de exposición, como una foto de la pantalla", () => {
    const original = perceptualHash(voucherA);
    const degradado = perceptualHash(conRuido(conBrillo(voucherA, 20), 30, 4));
    expect(isLikelySameImage(original, degradado)).toBe(true);
  });

  it("ignora un cambio de brillo global, porque el coeficiente DC no fija el umbral", () => {
    expect(hammingDistance(perceptualHash(voucherA), perceptualHash(conBrillo(voucherA, 25)))).toBe(
      0,
    );
    expect(
      hammingDistance(perceptualHash(circuloCentrado), perceptualHash(conBrillo(circuloCentrado, 25))),
    ).toBe(0);
  });

  it("sobrevive al reescalado a la mitad, que es lo que hace WhatsApp al reenviar", () => {
    expect(hammingDistance(perceptualHash(voucherA), perceptualHash(mitad(voucherA)))).toBeLessThan(
      UMBRAL_HAMMING_POR_DEFECTO,
    );
    expect(
      hammingDistance(perceptualHash(circuloCentrado), perceptualHash(mitad(circuloCentrado))),
    ).toBeLessThan(UMBRAL_HAMMING_POR_DEFECTO);
  });

  it("reconoce el mismo voucher tras un recorte leve de los bordes", () => {
    const original = perceptualHash(voucherA);
    for (const margen of [6, 12]) {
      expect(isLikelySameImage(original, perceptualHash(recortar(voucherA, margen)))).toBe(true);
    }
  });
});

describe("perceptualHash: capacidad de distinguir", () => {
  it("separa dos vouchers legítimos distintos pese a compartir plantilla", () => {
    // Este es el caso que de verdad importa y el más difícil: misma cabecera,
    // misma retícula, solo cambian los datos. Si esta distancia cayera dentro
    // del umbral, el sistema acusaría de fraude a clientes honestos.
    const a = perceptualHash(voucherA);
    expect(hammingDistance(a, perceptualHash(voucherB))).toBeGreaterThan(
      UMBRAL_HAMMING_POR_DEFECTO,
    );
    expect(hammingDistance(a, perceptualHash(voucherC))).toBeGreaterThan(
      UMBRAL_HAMMING_POR_DEFECTO,
    );
  });

  it("da distancia grande entre patrones estructuralmente distintos", () => {
    const pares: [GrayscaleImage, GrayscaleImage][] = [
      [tableroAjedrez, gradienteDiagonal],
      [franjasVerticales, circuloCentrado],
      [gradienteDiagonal, circuloCentrado],
    ];
    for (const [a, b] of pares) {
      expect(hammingDistance(perceptualHash(a), perceptualHash(b))).toBeGreaterThan(
        UMBRAL_HAMMING_POR_DEFECTO,
      );
    }
  });

  it("no confunde dos patrones distintos aunque compartan el mismo brillo medio", () => {
    // Franjas verticales contra horizontales: mismo histograma, estructura
    // opuesta. Si el hash mirase el brillo en vez de la estructura, fallaría.
    const horizontales = generar(128, 128, (_x, y) => (Math.floor(y / 8) % 2 === 0 ? 20 : 235));
    expect(isLikelySameImage(perceptualHash(franjasVerticales), perceptualHash(horizontales))).toBe(
      false,
    );
  });
});

describe("perceptualHash: límites conocidos", () => {
  it("es inestable ante ruido en imágenes casi sin estructura, como un degradado liso", () => {
    // Límite real, documentado a propósito en vez de escondido: un degradado
    // tiene casi todos los coeficientes de baja frecuencia pegados a cero, así
    // que la mediana cae entre ellos y un poco de ruido invierte el signo de
    // decenas de bits. No afecta a los vouchers (tienen texto y bordes, que
    // producen coeficientes grandes), pero sí significa que este hash no sirve
    // para comparar imágenes planas, por ejemplo una captura en blanco tomada
    // por error.
    const distancia = hammingDistance(
      perceptualHash(gradienteDiagonal),
      perceptualHash(conRuido(gradienteDiagonal, 10, 3)),
    );
    expect(distancia).toBeGreaterThan(UMBRAL_HAMMING_POR_DEFECTO);
  });
});

describe("hammingDistance", () => {
  it("es 0 entre un hash y sí mismo", () => {
    expect(hammingDistance("0f1e2d3c4b5a6978", "0f1e2d3c4b5a6978")).toBe(0);
  });

  it("cuenta los 64 bits cuando los hashes son complementarios", () => {
    expect(hammingDistance("0000000000000000", "ffffffffffffffff")).toBe(64);
  });

  it("cuenta bits en los nibbles altos, que un XOR de 32 bits perdería", () => {
    expect(hammingDistance("8000000000000000", "0000000000000000")).toBe(1);
    expect(hammingDistance("f000000000000000", "0000000000000001")).toBe(5);
  });

  it("acepta mayúsculas y espacios sobrantes", () => {
    expect(hammingDistance(" 0F1E2D3C4B5A6978 ", "0f1e2d3c4b5a6978")).toBe(0);
  });

  it("falla ante un hash mal formado en vez de devolver una distancia inventada", () => {
    expect(() => hammingDistance("abc", "0f1e2d3c4b5a6978")).toThrow(/pHash válido/);
    expect(() => hammingDistance("0f1e2d3c4b5a6978", "zzzzzzzzzzzzzzzz")).toThrow(/pHash válido/);
  });
});

describe("isLikelySameImage", () => {
  it("respeta el umbral explícito por encima del valor por defecto", () => {
    const a = "0000000000000000";
    const b = "000000000000000f"; // 4 bits de diferencia
    expect(isLikelySameImage(a, b, 3)).toBe(false);
    expect(isLikelySameImage(a, b, 4)).toBe(true);
  });

  it("usa 10 sobre 64 como umbral por defecto, inclusive", () => {
    expect(UMBRAL_HAMMING_POR_DEFECTO).toBe(10);
    expect(isLikelySameImage("0000000000000000", "00000000000003ff")).toBe(true); // 10 bits
    expect(isLikelySameImage("0000000000000000", "00000000000007ff")).toBe(false); // 11 bits
  });
});

describe("encontrarMasParecido", () => {
  it("devuelve null cuando no hay hashes conocidos con los que comparar", () => {
    expect(encontrarMasParecido(perceptualHash(voucherA), [])).toBeNull();
  });

  it("elige el más cercano y reporta su distancia", () => {
    const objetivo = perceptualHash(voucherA);
    const casiIgual = perceptualHash(conRuido(voucherA, 8));
    const lejano = perceptualHash(voucherB);

    const resultado = encontrarMasParecido(objetivo, [lejano, casiIgual]);
    expect(resultado?.hash).toBe(casiIgual);
    expect(resultado?.distancia).toBeLessThan(UMBRAL_HAMMING_POR_DEFECTO);
  });

  it("reporta distancia 0 cuando el hash exacto ya está registrado", () => {
    const hash = perceptualHash(voucherC);
    expect(encontrarMasParecido(hash, ["ffffffffffffffff", hash])).toEqual({ hash, distancia: 0 });
  });
});
