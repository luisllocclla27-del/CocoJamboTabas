/**
 * Tipo real de una imagen, deducido de sus primeros bytes.
 *
 * POR QUE NO SE CONFIA EN EL `Content-Type` NI EN LA EXTENSION: los dos los
 * controla el cliente. Renombrar `payload.exe` a `foto.jpg` y declarar
 * `image/jpeg` es trivial, y sin esta comprobacion el bucket del proyecto se
 * convierte en alojamiento de cualquier archivo con el dominio del negocio
 * dandole credibilidad.
 *
 * El modulo estaba embebido en `orders/voucher.ts`. Se extrajo al necesitarlo
 * tambien la subida de fotos de producto: dos copias de una comprobacion de
 * seguridad acaban divergiendo, y la que se quede atras es la que falla.
 *
 * LO QUE ESTA FUNCION NO HACE: no valida que la imagen sea decodificable ni que
 * no lleve un payload adosado despues de los bytes de cabecera. Reconocer la
 * firma es una condicion necesaria, no suficiente; lo que la hace suficiente en
 * este proyecto es que los buckets no sirven nada como HTML (Supabase Storage
 * fuerza el content-type declarado al subir, y aqui se declara el detectado, no
 * el que mando el cliente).
 */

export type TipoImagen = "image/jpeg" | "image/png" | "image/webp" | "image/avif" | "image/heic";

/** Bytes minimos para poder decidir: la caja `ftyp` de HEIC/AVIF llega al 12. */
const MINIMO_BYTES = 12;

/** Marcas de la caja `ftyp` que corresponden a HEIC/HEIF. */
const MARCAS_HEIC: readonly string[] = ["heic", "heix", "hevc", "hevx", "mif1", "msf1"];

/** Marcas de la caja `ftyp` que corresponden a AVIF. */
const MARCAS_AVIF: readonly string[] = ["avif", "avis"];

function ascii(bytes: Uint8Array, desde: number, largo: number): string {
  return String.fromCharCode(...bytes.slice(desde, desde + largo));
}

/**
 * Devuelve el tipo detectado, o `null` si los bytes no corresponden a ninguna
 * imagen reconocida.
 */
export function detectarTipoImagen(bytes: Uint8Array): TipoImagen | null {
  if (bytes.length < MINIMO_BYTES) return null;

  // JPEG: SOI (FF D8) seguido del primer marcador (FF).
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";

  // PNG: firma de 8 bytes. Se comprueban los cuatro primeros, que ya son
  // inequivocos, mas el terminador de linea que delata corrupcion por FTP en
  // modo texto.
  if (bytes[0] === 0x89 && ascii(bytes, 1, 3) === "PNG") return "image/png";

  // WebP: contenedor RIFF con la etiqueta WEBP en el byte 8.
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";

  // HEIC y AVIF comparten el contenedor ISO-BMFF: caja `ftyp` en el byte 4 y la
  // marca concreta en el 8.
  if (ascii(bytes, 4, 4) === "ftyp") {
    const marca = ascii(bytes, 8, 4).toLowerCase();
    if (MARCAS_AVIF.includes(marca)) return "image/avif";
    if (MARCAS_HEIC.includes(marca)) return "image/heic";
  }

  return null;
}

/** Extension de archivo para el tipo detectado. */
export function extensionDeTipo(tipo: TipoImagen): string {
  switch (tipo) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/avif":
      return "avif";
    case "image/heic":
      return "heic";
  }
}
