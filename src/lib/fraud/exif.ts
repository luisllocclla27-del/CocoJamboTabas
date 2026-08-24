/**
 * Rastros de edición en los metadatos EXIF del comprobante.
 *
 * La utilidad de esta señal es limitada y conviene entender por qué antes de
 * darle peso: en este flujo la mayoría de vouchers llegan como captura de
 * pantalla reenviada por WhatsApp, y WhatsApp elimina el EXIF de toda imagen
 * que pasa por él. Es decir, **el caso normal es no tener EXIF**. Por eso la
 * ausencia total de metadatos se reporta como dato neutro y jamás como
 * sospecha: penalizarla castigaría al 90% de clientes honestos.
 *
 * Lo que sí es informativo es lo contrario: que el EXIF exista *y* nombre un
 * editor de imágenes. Eso significa que el archivo se guardó desde una
 * herramienta de edición y llegó sin pasar por un canal que limpie metadatos.
 * Sigue teniendo falsos positivos (ver `EDITORES_CONOCIDOS`), así que la señal
 * es de advertencia, no de rechazo.
 *
 * El parseo del EXIF binario no se hace aquí: esta función recibe el objeto ya
 * extraído. En producción se obtiene con `exifr` en el servidor
 * (`await exifr.parse(bytes, { ifd0: true, exif: true, xmp: true })`), que hace
 * falta porque leer los IFD de un JPEG/HEIC a mano es un pozo sin fondo de
 * casos raros. Mantener la entrada como `Record<string, unknown>` deja esta
 * lógica pura y testeable sin dependencia nativa.
 */

/**
 * Editores conocidos, en minúsculas, buscados como subcadena.
 *
 * Se busca por subcadena porque el campo `Software` viene con versión y sufijos
 * ("Adobe Photoshop 25.1 (Windows)", "Snapseed 2.21.0.56697644").
 *
 * Advertencia sobre falsos positivos: varias de estas apps son también galerías
 * o editores triviales. Un cliente que recortó el voucher para que no se vea su
 * saldo, o que le puso un círculo al monto para ayudar, dispara esta señal
 * siendo honesto. Además muchas apps de galería de Android reescriben los
 * metadatos al hacer cualquier operación, incluso rotar. De ahí que la
 * severidad en el score sea 'advertencia'.
 */
const EDITORES_CONOCIDOS: readonly string[] = [
  "photoshop",
  "lightroom",
  "adobe",
  "gimp",
  "snapseed",
  "picsart",
  "canva",
  "pixlr",
  "paint.net",
  "affinity",
  "inkscape",
  "krita",
  "facetune",
  "photoroom",
  "remini",
  "photopea",
  "meitu",
  "polarr",
  "vsco",
  "figma",
  "coreldraw",
  "paint 3d",
  "ms paint",
  "imagemagick",
  "picsay",
  "photo editor",
  "photodirector",
  "airbrush",
  "retouch",
];

/**
 * Campos donde puede aparecer el nombre de la herramienta.
 *
 * Se cubren varios porque cada formato y cada app usa el suyo: `Software` es el
 * clásico de EXIF/TIFF, `CreatorTool` y `HistorySoftwareAgent` vienen de XMP
 * (Photoshop deja rastro ahí incluso cuando limpia `Software`), y
 * `ProcessingSoftware` lo usan algunos pipelines de escaneo.
 */
const CAMPOS_SOFTWARE: readonly string[] = [
  "Software",
  "ProcessingSoftware",
  "CreatorTool",
  "HistorySoftwareAgent",
  "Application",
  "ImageEditingSoftware",
];

/**
 * Lee un campo del EXIF ignorando mayúsculas en el nombre de la clave.
 *
 * Cada librería y cada cámara normaliza distinto (`Software`, `software`,
 * `SOFTWARE`), así que no se puede indexar directo.
 */
function leerCampoInsensible(exif: Record<string, unknown>, campo: string): unknown {
  const buscado = campo.toLowerCase();
  for (const clave of Object.keys(exif)) {
    if (clave.toLowerCase() === buscado) return exif[clave];
  }
  return undefined;
}

/** Aplana valores que pueden venir como string, número o lista (XMP History). */
function aTextos(valor: unknown): string[] {
  if (typeof valor === "string") return [valor];
  if (typeof valor === "number") return [String(valor)];
  if (Array.isArray(valor)) return valor.flatMap(aTextos);
  return [];
}

export function detectImageEditing(exif: Record<string, unknown> | null): {
  tieneExifDeEditor: boolean;
  señales: string[];
} {
  // Sin EXIF no hay nada que afirmar. Se deja constancia para que el admin sepa
  // que la comprobación se hizo y no dio información, en lugar de que el
  // silencio parezca "revisado y limpio".
  if (exif === null || Object.keys(exif).length === 0) {
    return {
      tieneExifDeEditor: false,
      señales: [
        "Sin metadatos EXIF. Es lo esperado: WhatsApp elimina el EXIF de las imágenes que reenvía, así que su ausencia no indica manipulación.",
      ],
    };
  }

  const señales: string[] = [];
  let tieneExifDeEditor = false;

  for (const campo of CAMPOS_SOFTWARE) {
    for (const texto of aTextos(leerCampoInsensible(exif, campo))) {
      const normalizado = texto.toLowerCase();
      const editor = EDITORES_CONOCIDOS.find((e) => normalizado.includes(e));
      if (editor !== undefined) {
        tieneExifDeEditor = true;
        señales.push(`Campo ${campo} nombra un editor de imágenes: "${texto.trim()}".`);
      }
    }
  }

  if (!tieneExifDeEditor) {
    señales.push("Metadatos EXIF presentes sin rastro de editores de imagen conocidos.");
  } else {
    // Se repite en cada caso positivo porque este texto termina en la pantalla
    // del admin, que verá la señal sin el contexto de este módulo.
    señales.push(
      "Un editor en los metadatos no prueba fraude: recortar el voucher o rotarlo desde la galería también deja rastro.",
    );
  }

  return { tieneExifDeEditor, señales };
}
