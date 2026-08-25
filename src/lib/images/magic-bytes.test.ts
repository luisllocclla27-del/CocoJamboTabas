import { describe, expect, it } from "vitest";
import { detectarTipoImagen, extensionDeTipo, type TipoImagen } from "./magic-bytes";

/**
 * Estos tests cubren la comprobacion de seguridad que impide que el bucket del
 * proyecto acabe alojando archivos que no son imagenes. El caso importante no es
 * "reconoce un JPEG", es "rechaza un ejecutable renombrado".
 */

/** Construye un buffer con los bytes indicados y relleno hasta `largo`. */
function bytes(cabecera: number[], largo = 32): Uint8Array {
  const salida = new Uint8Array(largo);
  salida.set(cabecera.slice(0, largo));
  return salida;
}

function conAscii(prefijo: number[], texto: string, largo = 32): Uint8Array {
  return bytes([...prefijo, ...[...texto].map((c) => c.charCodeAt(0))], largo);
}

const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0]);
const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** RIFF....WEBP: los cuatro bytes intermedios son el tamano y no importan. */
const WEBP = conAscii([], "RIFF\u0000\u0000\u0000\u0000WEBP");

/** ....ftypheic: los cuatro primeros bytes son el tamano de la caja. */
function isoBmff(marca: string): Uint8Array {
  return conAscii([0x00, 0x00, 0x00, 0x20], `ftyp${marca}`);
}

describe("detectarTipoImagen", () => {
  it("reconoce los formatos que aceptan los buckets", () => {
    const casos: Array<[Uint8Array, TipoImagen]> = [
      [JPEG, "image/jpeg"],
      [PNG, "image/png"],
      [WEBP, "image/webp"],
      [isoBmff("avif"), "image/avif"],
      [isoBmff("heic"), "image/heic"],
    ];
    for (const [entrada, esperado] of casos) {
      expect(detectarTipoImagen(entrada), esperado).toBe(esperado);
    }
  });

  it("reconoce las variantes de la caja ftyp", () => {
    // Los moviles etiquetan sus HEIC de varias formas; rechazar `mif1` dejaria
    // fuera comprobantes legitimos de iPhone.
    for (const marca of ["heic", "heix", "hevc", "hevx", "mif1", "msf1"]) {
      expect(detectarTipoImagen(isoBmff(marca)), marca).toBe("image/heic");
    }
    for (const marca of ["avif", "avis"]) {
      expect(detectarTipoImagen(isoBmff(marca)), marca).toBe("image/avif");
    }
  });

  it("acepta la marca ftyp en mayusculas", () => {
    // Algunos codificadores escriben la marca en caja alta. El contenedor es el
    // mismo, y rechazarlo seria un falso negativo por un detalle de formato.
    expect(detectarTipoImagen(isoBmff("HEIC"))).toBe("image/heic");
  });

  it("rechaza un ejecutable de Windows renombrado a .jpg", () => {
    // Es el ataque concreto que esta funcion existe para frenar: `MZ` es la
    // firma de un PE, y el navegador puede declarar image/jpeg sin problema.
    expect(detectarTipoImagen(conAscii([], "MZ\u0090\u0000\u0003"))).toBeNull();
  });

  it("rechaza un ELF, un ZIP y un PDF", () => {
    expect(detectarTipoImagen(bytes([0x7f, 0x45, 0x4c, 0x46]))).toBeNull();
    expect(detectarTipoImagen(bytes([0x50, 0x4b, 0x03, 0x04]))).toBeNull();
    expect(detectarTipoImagen(conAscii([], "%PDF-1.7"))).toBeNull();
  });

  it("rechaza HTML, que es el caso peligroso en un bucket publico", () => {
    // Un HTML servido desde el dominio del proyecto habilita phishing con la
    // reputacion del negocio detras.
    expect(detectarTipoImagen(conAscii([], "<!DOCTYPE html><html>"))).toBeNull();
    expect(detectarTipoImagen(conAscii([], "<svg xmlns=\"http://\">"))).toBeNull();
  });

  it("rechaza un archivo demasiado corto para decidir", () => {
    // Sin 12 bytes no se puede leer la caja ftyp, y adivinar seria peor que
    // rechazar: el cliente reintenta con una captura completa.
    expect(detectarTipoImagen(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
    expect(detectarTipoImagen(new Uint8Array())).toBeNull();
  });

  it("rechaza un RIFF que no es WebP", () => {
    // Un WAV tambien es RIFF. Sin comprobar la etiqueta del byte 8 pasaria.
    expect(detectarTipoImagen(conAscii([], "RIFF\u0000\u0000\u0000\u0000WAVE"))).toBeNull();
  });

  it("rechaza un PNG con la firma corrompida", () => {
    expect(detectarTipoImagen(bytes([0x89, 0x50, 0x4e, 0x46]))).toBeNull();
  });

  it("no se confunde con bytes nulos", () => {
    expect(detectarTipoImagen(new Uint8Array(64))).toBeNull();
  });
});

describe("extensionDeTipo", () => {
  it("da una extension para cada tipo reconocido", () => {
    const tipos: TipoImagen[] = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/avif",
      "image/heic",
    ];
    for (const tipo of tipos) {
      const extension = extensionDeTipo(tipo);
      // Sin punto y sin barras: se concatena a una ruta de Storage.
      expect(extension, tipo).toMatch(/^[a-z]{3,4}$/);
    }
  });

  it("usa jpg y no jpeg", () => {
    // Consistencia con lo que escriben las camaras y con las rutas ya guardadas.
    expect(extensionDeTipo("image/jpeg")).toBe("jpg");
  });
});
