/**
 * Extracción de datos del voucher de Yape/Plin.
 *
 * Este módulo separa dos cosas que suelen venir mezcladas:
 *
 * 1. El **motor de OCR**, que convierte píxeles en texto. No se implementa aquí:
 *    reconocer caracteres necesita un modelo (tesseract.js, un servicio de
 *    visión, o el OCR del sistema) y no hay forma honesta de hacerlo en
 *    TypeScript puro. Queda como `OcrEngine` inyectable.
 * 2. El **parser** del texto resultante, que sí es implementable, puro y
 *    testeable. Es también donde está toda la dificultad real: el OCR devuelve
 *    texto sucio y hay que interpretarlo sin inventar datos.
 *
 * Principio que atraviesa todo el parser: **ante la duda, `null`**. Un campo
 * nulo manda el pago a revisión humana, que es barato. Un campo adivinado mal
 * puede aprobar un pago que no existió, que no lo es. Esto importa
 * especialmente en el monto, porque el mecanismo de céntimos identificadores
 * (ver `src/lib/payment-cents.ts`) depende de leer el importe exacto: un
 * céntimo mal leído apunta a otro pedido.
 */

/**
 * Motor de OCR inyectable.
 *
 * `confidence` es 0..1 y la usa el score de riesgo para exigir revisión humana
 * cuando el reconocimiento fue pobre. En producción, en el servidor:
 *
 *   const engine: OcrEngine = async (bytes) => {
 *     const { data } = await Tesseract.recognize(bytes, "spa");
 *     return { text: data.text, confidence: data.confidence / 100 };
 *   };
 *
 * Conviene preprocesar la imagen antes (escala de grises, binarizado, subir a
 * ~300 dpi equivalentes): el OCR sobre una captura de pantalla pequeña de un
 * celular falla mucho más que sobre la misma imagen ampliada.
 */
export type OcrEngine = (bytes: Uint8Array) => Promise<{ text: string; confidence: number }>;

export type VoucherData = {
  operationNumber: string | null;
  amountCents: number | null;
  fecha: Date | null;
  destinatario: string | null;
  emisor: string | null;
};

/**
 * Perú no tiene horario de verano: su desfase es fijo -05:00.
 *
 * Las horas del voucher están en hora peruana, pero el servidor que parsea
 * puede estar en UTC (así corre en Vercel). Construir la fecha con
 * `new Date(y, m, d, h, min)` la interpretaría en la zona del proceso y movería
 * el instante hasta 5 horas, lo que rompe la comparación "el pago no puede ser
 * anterior al pedido" del score de riesgo. Se fija el desfase explícitamente.
 */
const DESFASE_PERU_HORAS = 5;

const MESES: Readonly<Record<string, number>> = {
  ene: 1,
  enero: 1,
  feb: 2,
  febrero: 2,
  mar: 3,
  marzo: 3,
  abr: 4,
  abril: 4,
  may: 5,
  mayo: 5,
  jun: 6,
  junio: 6,
  jul: 7,
  julio: 7,
  ago: 8,
  agosto: 8,
  // En Perú lo habitual es "set."; se aceptan las tres formas porque el rótulo
  // depende de la versión de la app y del idioma del sistema.
  set: 9,
  sep: 9,
  sept: 9,
  setiembre: 9,
  septiembre: 9,
  oct: 10,
  octubre: 10,
  nov: 11,
  noviembre: 11,
  dic: 12,
  diciembre: 12,
};

/**
 * Limpia el texto del OCR conservando lo que el parser necesita.
 *
 * Se preservan los saltos de línea porque son información: en los vouchers el
 * nombre del destinatario suele estar en la línea siguiente a su rótulo. Se
 * preservan las tildes y la ñ porque los nombres son datos que el admin va a
 * comparar a ojo.
 */
function normalizarTexto(texto: string): string {
  return (
    texto
      // El OCR y los portapapeles meten espacios raros (NBSP, finos) que no
      // casan con \s en algunos motores ni se ven al depurar.
      .replace(/[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g, " ")
      // Zero-width y marcas de dirección: invisibles y rompen cualquier regex.
      .replace(/[\u200b-\u200f\u2028\u2029\ufeff]/g, "")
      .replace(/\r\n?/g, "\n")
      // Controles sueltos que aparecen cuando el OCR falla sobre un borde.
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ")
      .replace(/[^\S\n]+/g, " ")
      .split("\n")
      .map((linea) => linea.trim())
      .join("\n")
  );
}

/* ------------------------------------------------------------------ montos */

const MAX_CENTIMOS_PLAUSIBLE = 100_000_000; // S/ 1,000,000: por encima es basura del OCR.

/**
 * Convierte el número de un voucher a céntimos, o `null` si es ambiguo.
 *
 * El problema central es que `.` y `,` cambian de papel: `1,249.37` y
 * `1.249,37` son el mismo importe, y el OCR además confunde una coma con un
 * punto a menudo (la coma de un voucher comprimido es literalmente un punto con
 * dos píxeles de cola). La regla que resuelve casi todo sin adivinar: mirar
 * cuántos dígitos hay **después del último separador**.
 */
function parsearMontoACentimos(token: string): number | null {
  if (!/^\d[\d.,]*$/.test(token)) return null;

  const ultimoSeparador = Math.max(token.lastIndexOf("."), token.lastIndexOf(","));
  if (ultimoSeparador === -1) {
    const soles = Number(token);
    return Number.isSafeInteger(soles) ? validarCentimos(soles * 100) : null;
  }

  const parteEntera = token.slice(0, ultimoSeparador);
  const cola = token.slice(ultimoSeparador + 1);
  if (!/^\d+$/.test(cola)) return null;

  if (cola.length === 2) {
    // El último separador es el decimal, sea punto o coma. Los anteriores son
    // agrupación de miles, incluidos los que el OCR pudo transformar: en
    // "1.249.37" el primer punto agrupa y el segundo decimaliza.
    const enteros = digitosDeParteEntera(parteEntera);
    if (enteros === null) return null;
    return validarCentimos(enteros * 100 + Number(cola));
  }

  if (cola.length === 3) {
    // Tres dígitos tras el último separador solo tienen sentido como grupo de
    // miles: en soles no existen milésimas. "1.249" son mil doscientos
    // cuarenta y nueve soles exactos.
    const enteros = digitosDeParteEntera(token);
    if (enteros === null) return null;
    return validarCentimos(enteros * 100);
  }

  // Un solo dígito decimal es el caso peligroso: "S/ 249.3" puede ser 249.30 o
  // un 249.37 al que el OCR le comió el último dígito. Como los céntimos son
  // justamente el identificador del pedido, adivinar aquí es peor que no leer.
  return null;
}

/**
 * Valida la agrupación de miles y devuelve el entero, o `null` si no cuadra.
 *
 * Si no hay separadores no se valida nada: "1249.37" es perfectamente válido
 * aunque no venga agrupado. Si los hay, todos los grupos salvo el primero deben
 * tener exactamente tres dígitos; algo como "1,2349.37" es OCR roto y merece
 * revisión humana, no una interpretación creativa.
 */
function digitosDeParteEntera(parte: string): number | null {
  const grupos = parte.split(/[.,]/);
  if (grupos.some((g) => g.length === 0)) return null;
  if (grupos.length > 1) {
    if (grupos[0].length < 1 || grupos[0].length > 3) return null;
    if (grupos.slice(1).some((g) => g.length !== 3)) return null;
  }
  const valor = Number(grupos.join(""));
  return Number.isSafeInteger(valor) ? valor : null;
}

function validarCentimos(centimos: number): number | null {
  if (!Number.isSafeInteger(centimos) || centimos <= 0) return null;
  return centimos <= MAX_CENTIMOS_PLAUSIBLE ? centimos : null;
}

/**
 * Todo lo que parezca un importe en soles, con la línea en que aparece.
 *
 * Se exige el símbolo `S/` (con sus variantes `S/.` y el espacio que el OCR
 * mete donde quiere) en vez de aceptar cualquier número: un voucher está lleno
 * de dígitos —número de operación, fecha, hora, teléfono— y sin el símbolo la
 * tasa de aciertos se hunde.
 */
function extraerMontos(texto: string): { centimos: number; linea: string }[] {
  const encontrados: { centimos: number; linea: string }[] = [];
  for (const linea of texto.split("\n")) {
    const re = /s\s*\/\s*\.?\s*(\d[\d.,]*)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(linea)) !== null) {
      // Un separador final es puntuación de la frase, no del número.
      const token = m[1].replace(/[.,]+$/, "");
      const centimos = parsearMontoACentimos(token);
      if (centimos !== null) encontrados.push({ centimos, linea });
    }
  }
  return encontrados;
}

const RE_LINEA_DE_MONTO = /\b(monto|importe|total|pagaste|enviaste|env[ií]o|cantidad)\b/i;

function extraerMonto(texto: string): number | null {
  const montos = extraerMontos(texto);
  if (montos.length === 0) return null;

  // Un voucher puede mostrar más de un importe (saldo disponible, comisión). Si
  // alguno está en una línea rotulada como monto, ese manda.
  const rotulados = montos.filter((m) => RE_LINEA_DE_MONTO.test(m.linea));
  const candidatos = rotulados.length > 0 ? rotulados : montos;

  const distintos = new Set(candidatos.map((c) => c.centimos));
  // Dos importes distintos sin nada que los desempate: no hay forma de saber
  // cuál pagó el cliente, y equivocarse aquí asigna el pago a otro pedido.
  return distintos.size === 1 ? candidatos[0].centimos : null;
}

/* ---------------------------------------------------- número de operación */

const RE_ETIQUETA_OPERACION =
  /(?:n\s*(?:[°ºo*.]|ro\.?|r[°º]|úm(?:ero)?\.?)?\s*(?:de\s*)?|c[óo]d(?:igo)?\.?\s*(?:de\s*)?|)(?:operaci[óo]n|operacion|transacci[óo]n|movimiento)\s*(?:n\s*[°ºo*.]?\s*)?[:\-–.]?\s*/i;

/**
 * Número de operación, normalizado a solo dígitos.
 *
 * Es el dato más valioso del voucher: es único por transacción, así que un
 * número repetido significa que el mismo pago se está usando dos veces. Por eso
 * se tolera agresivamente el ruido del OCR (`O` por `0`, dígitos partidos por
 * espacios) antes de rendirse.
 */
function extraerNumeroOperacion(texto: string): string | null {
  const lineas = texto.split("\n");
  for (let i = 0; i < lineas.length; i++) {
    const m = RE_ETIQUETA_OPERACION.exec(lineas[i]);
    if (m === null) continue;

    let resto = lineas[i].slice(m.index + m[0].length);
    // La app parte el rótulo y el número en dos líneas cuando el nombre del
    // destinatario es largo y empuja el layout.
    if (!/\d/.test(resto) && i + 1 < lineas.length) resto = lineas[i + 1];

    const numero = primerNumeroLargo(resto);
    if (numero !== null) return numero;
  }
  return null;
}

const MIN_DIGITOS_OPERACION = 6;
const MAX_DIGITOS_OPERACION = 20;

/**
 * Primer número suficientemente largo del segmento.
 *
 * Se aceptan 6 a 20 dígitos en vez de exigir los 8 típicos de Yape porque Plin
 * y los bancos usan longitudes distintas, y descartar un número real por no
 * medir 8 nos costaría la única señal fuerte de duplicado que tenemos.
 */
function primerNumeroLargo(segmento: string): string | null {
  const tokens = [...segmento.matchAll(/[0-9Oo]{2,}/g)];
  for (let i = 0; i < tokens.length; i++) {
    const bruto = tokens[i][0];
    // Exigir al menos un dígito real evita que una palabra con "OO" se
    // convierta en "00" y pase por número de operación.
    if (!/\d/.test(bruto)) continue;

    const normalizado = bruto.replace(/[Oo]/g, "0");
    if (esLargoPlausible(normalizado)) return normalizado;

    // El OCR parte números largos por la mitad ("1234 5678"). Se reconstruyen
    // solo si los trozos están separados por espacios, nunca por otros
    // caracteres: un guion o una barra indican que son campos distintos.
    let unido = normalizado;
    let fin = (tokens[i].index ?? 0) + bruto.length;
    for (let j = i + 1; j < tokens.length; j++) {
      const inicioSiguiente = tokens[j].index ?? 0;
      if (!/^ +$/.test(segmento.slice(fin, inicioSiguiente))) break;
      unido += tokens[j][0].replace(/[Oo]/g, "0");
      fin = inicioSiguiente + tokens[j][0].length;
      if (esLargoPlausible(unido)) return unido;
      if (unido.length > MAX_DIGITOS_OPERACION) break;
    }
  }
  return null;
}

function esLargoPlausible(digitos: string): boolean {
  return digitos.length >= MIN_DIGITOS_OPERACION && digitos.length <= MAX_DIGITOS_OPERACION;
}

/* ------------------------------------------------------------------ fechas */

const RE_FECHA_TEXTUAL =
  /\b(\d{1,2})\s*(?:de\s+)?([a-záéíóúñ]{3,10})\.?\s*(?:de[l]?\s+)?(\d{4})\b/i;
const RE_FECHA_NUMERICA = /\b(\d{1,2})\s*[/\-.]\s*(\d{1,2})\s*[/\-.]\s*(\d{2,4})\b/;
/**
 * Hora con meridiano opcional.
 *
 * El meridiano se escribe de todas las formas imaginables según cómo el OCR
 * interprete los puntos: "p. m.", "p.m.", "pm", "P M". Se admite cualquier
 * combinación de puntos y espacios.
 */
const RE_HORA = /\b(\d{1,2})\s*[:.]\s*(\d{2})(?:\s*[:.]\s*(\d{2}))?\s*([ap])\s*\.?\s*m\s*\.?/i;
const RE_HORA_24 = /\b(\d{1,2})\s*[:.]\s*(\d{2})(?:\s*[:.]\s*(\d{2}))?\b/;

/** Ventana tras la fecha donde se busca la hora, en caracteres. */
const VENTANA_HORA = 40;

function extraerFecha(texto: string): Date | null {
  const textual = RE_FECHA_TEXTUAL.exec(texto);
  if (textual !== null) {
    const mes = MESES[quitarTildes(textual[2].toLowerCase())];
    if (mes !== undefined) {
      const hora = buscarHora(texto, textual.index + textual[0].length);
      return construirFechaPeru(Number(textual[3]), mes, Number(textual[1]), hora);
    }
  }

  const numerica = RE_FECHA_NUMERICA.exec(texto);
  if (numerica !== null) {
    // Formato peruano: día primero. No hay ambigüedad que resolver porque la
    // app está en es-PE; asumir mm/dd aquí sería importar una convención ajena.
    const anio = normalizarAnio(Number(numerica[3]));
    const hora = buscarHora(texto, numerica.index + numerica[0].length);
    return construirFechaPeru(anio, Number(numerica[2]), Number(numerica[1]), hora);
  }

  return null;
}

function quitarTildes(texto: string): string {
  return texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function normalizarAnio(anio: number): number {
  // Un voucher de dos dígitos es de este siglo: no existen vouchers de Yape
  // anteriores a 2016.
  return anio < 100 ? 2000 + anio : anio;
}

function buscarHora(
  texto: string,
  desde: number,
): { horas: number; minutos: number; segundos: number } | null {
  const ventana = texto.slice(desde, desde + VENTANA_HORA);

  const con12 = RE_HORA.exec(ventana);
  if (con12 !== null) {
    let horas = Number(con12[1]);
    const minutos = Number(con12[2]);
    const segundos = con12[3] === undefined ? 0 : Number(con12[3]);
    if (horas < 1 || horas > 12 || minutos > 59 || segundos > 59) return null;
    const esPM = con12[4].toLowerCase() === "p";
    // 12 a. m. es medianoche y 12 p. m. mediodía: el caso que siempre se
    // escapa si se suma 12 sin más.
    if (esPM && horas !== 12) horas += 12;
    if (!esPM && horas === 12) horas = 0;
    return { horas, minutos, segundos };
  }

  const con24 = RE_HORA_24.exec(ventana);
  if (con24 !== null) {
    const horas = Number(con24[1]);
    const minutos = Number(con24[2]);
    const segundos = con24[3] === undefined ? 0 : Number(con24[3]);
    if (horas > 23 || minutos > 59 || segundos > 59) return null;
    return { horas, minutos, segundos };
  }

  return null;
}

function diasEnMes(anio: number, mes: number): number {
  return new Date(Date.UTC(anio, mes, 0)).getUTCDate();
}

/**
 * Construye el instante a partir de componentes en hora peruana.
 *
 * Se validan los componentes antes de construir porque `Date.UTC` desborda en
 * silencio: el 31 de febrero se convierte en marzo sin avisar, y una fecha
 * inventada por el OCR pasaría por buena.
 */
function construirFechaPeru(
  anio: number,
  mes: number,
  dia: number,
  hora: { horas: number; minutos: number; segundos: number } | null,
): Date | null {
  if (mes < 1 || mes > 12) return null;
  if (anio < 2016 || anio > 2100) return null;
  if (dia < 1 || dia > diasEnMes(anio, mes)) return null;

  const h = hora ?? { horas: 0, minutos: 0, segundos: 0 };
  return new Date(
    Date.UTC(anio, mes - 1, dia, h.horas + DESFASE_PERU_HORAS, h.minutos, h.segundos),
  );
}

/* ------------------------------------------------------------------ nombres */

// El `\b` tras el rótulo no es decorativo: sin él, "de" casaría con el prefijo
// de "Destinatario" y el emisor se llenaría con el nombre del destinatario.
const RE_ETIQUETA_DESTINATARIO =
  /^\s*(?:para|destinatario|destino|enviado\s+a|beneficiario|recibe)\b\s*:?\s*(.*)$/i;
const RE_ETIQUETA_EMISOR =
  /^\s*(?:de|desde|emisor|remitente|titular|enviado\s+por|env[ií]a)\b\s*:?\s*(.*)$/i;

/**
 * Nombre que sigue a un rótulo.
 *
 * Yape muestra el nombre a veces enmascarado ("Luis G. ***"). Se devuelve tal
 * como viene, sin intentar reconstruirlo: el admin compara lo que ve, y el
 * score de riesgo ya trata la no coincidencia de nombre como advertencia y no
 * como rechazo justamente porque el dato llega incompleto.
 */
function extraerNombre(texto: string, etiqueta: RegExp): string | null {
  const lineas = texto.split("\n");
  for (let i = 0; i < lineas.length; i++) {
    const m = etiqueta.exec(lineas[i]);
    if (m === null) continue;

    const candidatos = [m[1], lineas[i + 1] ?? ""];
    for (const candidato of candidatos) {
      const limpio = limpiarNombre(candidato);
      if (limpio !== null) return limpio;
    }
  }
  return null;
}

const RE_OTRA_ETIQUETA =
  /\b(operaci[óo]n|monto|importe|total|fecha|hora|destinatario|emisor|banco|celular|tel[ée]fono|comisi[óo]n|estado)\b/i;

function limpiarNombre(bruto: string): string | null {
  const limpio = bruto
    // Puntuación decorativa del layout, pero se conservan el punto de la
    // inicial abreviada y los asteriscos del enmascarado de Yape.
    .replace(/^[\s:\-–—•|>]+/, "")
    .replace(/[\s:\-–—•|>]+$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (limpio.length < 2) return null;
  // Una línea con importe, fecha u otro rótulo no es un nombre: el rótulo que
  // buscábamos estaba solo y lo siguiente ya es otro campo.
  if (/s\s*\/\s*\.?\s*\d/i.test(limpio)) return null;
  if (RE_OTRA_ETIQUETA.test(limpio)) return null;
  // Debe tener al menos dos letras seguidas; "12 04 2026" o "***" no son nombres.
  if (!/[a-záéíóúñü]{2}/i.test(limpio)) return null;
  return limpio;
}

/* -------------------------------------------------------------------- api */

export function parseVoucherText(text: string): VoucherData {
  const texto = normalizarTexto(text);
  return {
    operationNumber: extraerNumeroOperacion(texto),
    amountCents: extraerMonto(texto),
    fecha: extraerFecha(texto),
    destinatario: extraerNombre(texto, RE_ETIQUETA_DESTINATARIO),
    emisor: extraerNombre(texto, RE_ETIQUETA_EMISOR),
  };
}

/**
 * Corre el OCR y parsea, dejando ver la confianza al llamador.
 *
 * Se expone la confianza sin filtrar en vez de decidir aquí un mínimo: quien
 * decide qué hacer con un reconocimiento pobre es el score de riesgo, que tiene
 * el resto del contexto del pedido.
 */
export async function leerVoucher(
  bytes: Uint8Array,
  engine: OcrEngine,
): Promise<{ data: VoucherData; confidence: number; text: string }> {
  const { text, confidence } = await engine(bytes);
  return { data: parseVoucherText(text), confidence, text };
}
