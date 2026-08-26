/**
 * Compresión de imágenes en el navegador antes de subir.
 *
 * POR QUÉ ES CRUCIAL PARA MÓVIL:
 * Las cámaras de smartphone modernas generan fotos de 5 a 15 MB o en formatos
 * específicos como HEIC (iPhone).
 *
 * Subir archivos de 10 MB directamente:
 * 1. Excede el límite de 4.5 MB de Vercel Serverless para el cuerpo de petición (Error 413).
 * 2. Tarda varios segundos o falla con conexiones 3G/4G inestables en Perú.
 * 3. Consume el espacio del bucket con fotos de 4000x3000 px que ningún usuario necesita.
 *
 * Esta utilidad redimensiona la imagen a un máximo de 1600x1600 píxeles y la comprime
 * en JPEG con calidad 85%, reduciendo el peso de 10 MB a ~300 KB en memoria en ~100 ms
 * antes del envío del formulario.
 */

const MAX_DIMENSION = 1600;
const CALIDAD_JPEG = 0.85;

export async function optimizarImagenParaSubida(archivo: File): Promise<File> {
  // Si no estamos en el navegador o el archivo no es imagen, retornar tal cual
  if (typeof window === "undefined" || !archivo.type.startsWith("image/")) {
    return archivo;
  }

  // Si ya es un archivo muy pequeño (< 400 KB) y es formato web estándar, no tocar
  if (
    archivo.size <= 400 * 1024 &&
    (archivo.type === "image/jpeg" || archivo.type === "image/webp" || archivo.type === "image/png")
  ) {
    return archivo;
  }

  try {
    const url = URL.createObjectURL(archivo);
    const imagen = await cargarElementoImagen(url);
    URL.revokeObjectURL(url);

    let { width, height } = imagen;

    // Calcular escala proporcional si supera el máximo
    if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
      if (width > height) {
        height = Math.round((height * MAX_DIMENSION) / width);
        width = MAX_DIMENSION;
      } else {
        width = Math.round((width * MAX_DIMENSION) / height);
        height = MAX_DIMENSION;
      }
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext("2d");
    if (!ctx) return archivo;

    // Fondo blanco para imágenes con transparencia convertidas a JPEG
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(imagen, 0, 0, width, height);

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), "image/jpeg", CALIDAD_JPEG);
    });

    if (!blob) return archivo;

    // Mantener el nombre cambiando la extensión a .jpg si es necesario
    const nuevoNombre = archivo.name.replace(/\.[^/.]+$/, "") + ".jpg";
    return new File([blob], nuevoNombre, {
      type: "image/jpeg",
      lastModified: Date.now(),
    });
  } catch (error) {
    console.warn("[compresion-cliente] no se pudo optimizar la imagen, usando original:", error);
    return archivo;
  }
}

function cargarElementoImagen(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e);
    img.src = src;
  });
}
