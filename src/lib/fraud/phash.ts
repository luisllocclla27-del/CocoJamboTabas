/**
 * Hash perceptual (pHash) de comprobantes de pago.
 *
 * ¿Por qué no SHA-256? Porque el hash criptográfico responde a la pregunta
 * equivocada. Nos interesa "¿este cliente me está mandando el mismo voucher que
 * ya usó otro pedido?", y el atacante no reenvía el archivo idéntico: lo
 * recorta, lo reenvía por WhatsApp (que recomprime a JPEG y reescala), le hace
 * una captura de pantalla, o le cambia un píxel. Cualquiera de esas cosas
 * cambia el SHA-256 por completo y el duplicado pasa desapercibido. El pHash
 * describe la *estructura* de la imagen, así que sobrevive a recompresión,
 * reescalado, cambios de brillo y recortes leves, y sigue delatando el voucher
 * reutilizado.
 *
 * El precio es que el pHash es difuso: no hay igualdad, hay distancia. Por eso
 * todo lo que sale de aquí alimenta un score de riesgo para revisión humana y
 * nunca una decisión automática de rechazo.
 */

/**
 * Imagen en escala de grises, ya decodificada.
 *
 * Trabajamos sobre luminancia y no sobre RGB porque el color aporta poco a la
 * identidad estructural de un voucher (fondo blanco, texto oscuro) y triplica
 * el costo. `pixels` es luminancia 0-255 en orden fila-mayor.
 */
export type GrayscaleImage = {
  width: number;
  height: number;
  /** Luminancia 0-255, longitud exacta width*height. */
  pixels: Uint8Array;
};

/**
 * Decodificador de bytes a escala de grises, inyectable.
 *
 * No se implementa en este módulo a propósito. Decodificar JPEG/PNG/WebP/HEIC
 * en TypeScript puro sería reescribir mal lo que `sharp` ya hace bien, y HEIC
 * (formato por defecto de los iPhone, que son la mitad de los vouchers que
 * llegan) es directamente inviable sin binding nativo.
 *
 * En producción, en el servidor:
 *
 *   const decodeToGrayscale: ImageDecoder = async (bytes) => {
 *     const { data, info } = await sharp(bytes)
 *       .rotate()               // respeta la orientación EXIF; sin esto los
 *                               // vouchers de iPhone salen girados y el pHash
 *                               // de la misma imagen no coincide consigo mismo
 *       .greyscale()
 *       .raw()
 *       .toBuffer({ resolveWithObject: true });
 *     return { width: info.width, height: info.height, pixels: new Uint8Array(data) };
 *   };
 *
 * Mantenerlo como parámetro deja los tests de este módulo puros y síncronos:
 * se les pasan imágenes sintéticas y no hace falta ningún archivo real.
 */
export type ImageDecoder = (bytes: Uint8Array) => Promise<GrayscaleImage>;

/** Lado de la imagen reducida sobre la que corre la DCT. */
const TAMANIO_REDUCIDO = 32;
/** Lado del bloque de baja frecuencia que forma el hash. 8x8 = 64 bits. */
const TAMANIO_BLOQUE = 8;

/**
 * Umbral de Hamming por defecto, sobre 64 bits.
 *
 * El número sale del compromiso entre los dos errores:
 *
 * - Por debajo de ~6 aparecen falsos negativos: el mismo voucher reenviado por
 *   WhatsApp y recomprimido a JPEG de baja calidad se aleja varios bits de su
 *   original, y lo dejaríamos pasar como imagen nueva.
 * - Por encima de ~14 aparecen falsos positivos entre vouchers legítimos
 *   distintos.
 *
 * Y aquí está el riesgo real de este mecanismo, que conviene decir claro: todos
 * los vouchers de Yape comparten plantilla (mismo layout, mismo morado, mismos
 * rótulos), así que la distancia base entre dos vouchers *reales y distintos*
 * es mucho menor que entre dos fotos cualesquiera. Las diferencias reales entre
 * dos pagos —monto, nombre, número de operación— son texto pequeño, justo la
 * información que la reducción a 32x32 y el filtrado a baja frecuencia
 * destruyen. En consecuencia:
 *
 * 1. Este umbral se calibra con vouchers reales, no con imágenes genéricas.
 * 2. `phashDuplicado` es una señal para el admin, no una prueba. La prueba
 *    dura del duplicado es el número de operación, que es único por
 *    transacción; el pHash solo cubre el caso en que el OCR no pudo leerlo.
 */
export const UMBRAL_HAMMING_POR_DEFECTO = 10;

/**
 * Reduce la imagen a 32x32 promediando por área.
 *
 * El vecino más cercano sería más rápido, pero muestrea un solo píxel por
 * bloque: dos reescalados distintos de la misma foto eligen píxeles distintos y
 * el hash se vuelve frágil justo ante la transformación que más nos interesa
 * tolerar. El promedio por área actúa como filtro paso bajo y hace que la
 * versión grande y la pequeña de una misma imagen converjan al mismo bloque.
 */
function reducirPorArea(image: GrayscaleImage): Float64Array {
  const { width, height, pixels } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`dimensiones de imagen inválidas: ${width}x${height}`);
  }
  if (pixels.length !== width * height) {
    throw new Error(
      `pixels no coincide con las dimensiones: se esperaban ${width * height}, hay ${pixels.length}`,
    );
  }

  const salida = new Float64Array(TAMANIO_REDUCIDO * TAMANIO_REDUCIDO);
  for (let by = 0; by < TAMANIO_REDUCIDO; by++) {
    // Los límites se calculan con proporciones y no con un paso entero para no
    // dejar filas de la imagen fuera del promedio cuando el lado no es
    // múltiplo de 32.
    const y0 = Math.floor((by * height) / TAMANIO_REDUCIDO);
    const y1 = Math.max(y0 + 1, Math.floor(((by + 1) * height) / TAMANIO_REDUCIDO));
    for (let bx = 0; bx < TAMANIO_REDUCIDO; bx++) {
      const x0 = Math.floor((bx * width) / TAMANIO_REDUCIDO);
      const x1 = Math.max(x0 + 1, Math.floor(((bx + 1) * width) / TAMANIO_REDUCIDO));

      let suma = 0;
      let cuenta = 0;
      for (let y = y0; y < y1 && y < height; y++) {
        const fila = y * width;
        for (let x = x0; x < x1 && x < width; x++) {
          suma += pixels[fila + x];
          cuenta++;
        }
      }
      salida[by * TAMANIO_REDUCIDO + bx] = cuenta === 0 ? 0 : suma / cuenta;
    }
  }
  return salida;
}

/**
 * Tabla de cosenos de la DCT-II precalculada: cos(pi*(2x+1)*u / (2N)).
 *
 * Se calcula una sola vez a nivel de módulo porque cada hash haría ~16 mil
 * llamadas a Math.cos con los mismos argumentos.
 */
const COSENOS = (() => {
  const tabla = new Float64Array(TAMANIO_REDUCIDO * TAMANIO_BLOQUE);
  for (let x = 0; x < TAMANIO_REDUCIDO; x++) {
    for (let u = 0; u < TAMANIO_BLOQUE; u++) {
      tabla[x * TAMANIO_BLOQUE + u] = Math.cos(
        (Math.PI * (2 * x + 1) * u) / (2 * TAMANIO_REDUCIDO),
      );
    }
  }
  return tabla;
})();

/**
 * DCT-II 2D de la que solo se materializa el bloque 8x8 de baja frecuencia.
 *
 * La DCT 2D es separable, así que se aplica por filas y luego por columnas. Se
 * limitan los índices de salida a 0..7 desde el principio: los 1024
 * coeficientes completos se calcularían para descartar 960, y las altas
 * frecuencias son precisamente el ruido de compresión que queremos ignorar.
 *
 * Se omiten los factores de normalización de la DCT ortonormal: son constantes
 * positivas por coeficiente y el hash solo compara cada coeficiente contra la
 * mediana del mismo conjunto, así que no cambian ningún bit.
 */
function dctBloqueBajaFrecuencia(reducida: Float64Array): Float64Array {
  const porFilas = new Float64Array(TAMANIO_REDUCIDO * TAMANIO_BLOQUE);
  for (let y = 0; y < TAMANIO_REDUCIDO; y++) {
    const filaEntrada = y * TAMANIO_REDUCIDO;
    const filaSalida = y * TAMANIO_BLOQUE;
    for (let u = 0; u < TAMANIO_BLOQUE; u++) {
      let suma = 0;
      for (let x = 0; x < TAMANIO_REDUCIDO; x++) {
        suma += reducida[filaEntrada + x] * COSENOS[x * TAMANIO_BLOQUE + u];
      }
      porFilas[filaSalida + u] = suma;
    }
  }

  const bloque = new Float64Array(TAMANIO_BLOQUE * TAMANIO_BLOQUE);
  for (let v = 0; v < TAMANIO_BLOQUE; v++) {
    for (let u = 0; u < TAMANIO_BLOQUE; u++) {
      let suma = 0;
      for (let y = 0; y < TAMANIO_REDUCIDO; y++) {
        suma += porFilas[y * TAMANIO_BLOQUE + u] * COSENOS[y * TAMANIO_BLOQUE + v];
      }
      bloque[v * TAMANIO_BLOQUE + u] = suma;
    }
  }
  return bloque;
}

/** Mediana de una copia ordenada. Con longitud par se promedian los centrales. */
function mediana(valores: readonly number[]): number {
  const orden = [...valores].sort((a, b) => a - b);
  const mitad = orden.length >> 1;
  return orden.length % 2 === 0 ? (orden[mitad - 1] + orden[mitad]) / 2 : orden[mitad];
}

/**
 * pHash de 64 bits en hexadecimal (16 caracteres).
 *
 * El bit i (de más significativo a menos) corresponde al coeficiente en orden
 * fila-mayor del bloque 8x8, y vale 1 si el coeficiente supera la mediana.
 */
export function perceptualHash(image: GrayscaleImage): string {
  const bloque = dctBloqueBajaFrecuencia(reducirPorArea(image));

  // El coeficiente DC (0,0) es la suma de toda la imagen: mide el brillo global
  // y es dos órdenes de magnitud mayor que el resto, así que arrastraría la
  // mediana y haría que el hash dependiera de la exposición de la foto en vez
  // de su estructura. Se excluye del cálculo de la mediana. Su bit sí se emite
  // (compara el brillo global contra la mediana de las frecuencias, valor
  // prácticamente constante) para no perder un bit del ancho fijo de 64.
  const sinDC: number[] = [];
  for (let i = 1; i < bloque.length; i++) sinDC.push(bloque[i]);
  const umbral = mediana(sinDC);

  let hex = "";
  for (let nibble = 0; nibble < 16; nibble++) {
    let valor = 0;
    for (let bit = 0; bit < 4; bit++) {
      valor <<= 1;
      if (bloque[nibble * 4 + bit] > umbral) valor |= 1;
    }
    hex += valor.toString(16);
  }
  return hex;
}

const HASH_VALIDO = /^[0-9a-f]{16}$/;

function parsearHash(hash: string, nombre: string): string {
  const normalizado = hash.trim().toLowerCase();
  if (!HASH_VALIDO.test(normalizado)) {
    throw new Error(`${nombre} no es un pHash válido de 16 dígitos hex: ${hash}`);
  }
  return normalizado;
}

/**
 * Bits que difieren entre dos hashes, 0..64.
 *
 * Se compara nibble a nibble en vez de convertir a BigInt o a Number: 64 bits
 * no caben en el entero seguro de JS y las operaciones bit a bit de JS truncan
 * a 32 bits, así que un XOR ingenuo daría resultados silenciosamente erróneos.
 */
export function hammingDistance(hashA: string, hashB: string): number {
  const a = parsearHash(hashA, "hashA");
  const b = parsearHash(hashB, "hashB");

  let distancia = 0;
  for (let i = 0; i < 16; i++) {
    let xor = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (xor !== 0) {
      distancia += xor & 1;
      xor >>= 1;
    }
  }
  return distancia;
}

/**
 * ¿Los dos hashes describen plausiblemente la misma imagen?
 *
 * Devuelve una sospecha, no un veredicto: ver `UMBRAL_HAMMING_POR_DEFECTO` para
 * por qué la plantilla compartida de los vouchers de Yape hace que el falso
 * positivo sea un escenario esperable y no una anomalía.
 */
export function isLikelySameImage(
  hashA: string,
  hashB: string,
  umbral: number = UMBRAL_HAMMING_POR_DEFECTO,
): boolean {
  return hammingDistance(hashA, hashB) <= umbral;
}

/**
 * Hash más parecido de un conjunto ya conocido.
 *
 * Se devuelve la distancia mínima y no solo un booleano porque el score de
 * riesgo la usa como magnitud: una distancia de 0 (archivo idéntico) y una de 9
 * (parecido en el límite) merecen mensajes distintos para el admin.
 */
export function encontrarMasParecido(
  hash: string,
  conocidos: readonly string[],
): { hash: string; distancia: number } | null {
  let mejor: { hash: string; distancia: number } | null = null;
  for (const candidato of conocidos) {
    const distancia = hammingDistance(hash, candidato);
    if (mejor === null || distancia < mejor.distancia) {
      mejor = { hash: candidato, distancia };
    }
  }
  return mejor;
}
