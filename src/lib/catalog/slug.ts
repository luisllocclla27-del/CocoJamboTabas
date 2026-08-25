/**
 * Slugs y SKUs de producto.
 *
 * El slug es parte de la URL publica (`/producto/converse-chuck-70-blanco`) y es
 * la clave por la que Google indexa la ficha. Dos consecuencias practicas que
 * gobiernan este modulo:
 *
 * 1. **No se regenera al editar.** Cambiar el slug de un producto ya publicado
 *    rompe los enlaces compartidos por WhatsApp y tira el posicionamiento. Por eso
 *    se calcula una vez, al dar de alta, y despues es un dato que solo se cambia a
 *    mano y a sabiendas.
 *
 * 2. **Tiene que ser unico en la base**, y la unicidad real la impone el indice de
 *    `products.slug`. Aqui solo se propone un candidato libre, porque comprobar la
 *    disponibilidad requiere consultar la base y esta capa es pura y testeable.
 */

/**
 * Convierte texto libre en un slug.
 *
 * Las tildes se descomponen y se quitan en vez de sustituirse a mano: `NFD` mas
 * eliminar diacriticos cubre tambien la dieresis y la cedilla sin mantener una
 * tabla de reemplazos que siempre acaba incompleta.
 */
export function slugify(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    // La enie no siempre llega descompuesta, asi que se trata explicitamente
    // antes del filtro general; sin esto "Niño" daria "nio".
    .replace(/ñ/gi, "n")
    .toLowerCase()
    // Todo lo que no sea alfanumerico se vuelve separador. Incluye el punto y la
    // barra, que en una URL significarian otra cosa.
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    // Tope defensivo: un slug de 300 caracteres no aporta nada y complica los
    // enlaces al compartirlos por WhatsApp.
    .slice(0, 80)
    .replace(/-+$/g, "");
}

/**
 * Slug de un producto a partir de marca, modelo y colorway.
 *
 * Se incluye la marca porque "old-skool-negro" podria existir en dos marcas, y el
 * colorway porque el mismo modelo en dos colores son dos productos con dos fichas
 * distintas.
 */
export function slugProducto(entrada: {
  marca: string;
  modelo: string;
  colorway: string;
}): string {
  return slugify(`${entrada.marca} ${entrada.modelo} ${entrada.colorway}`);
}

/**
 * Propone un slug libre a partir de uno ocupado.
 *
 * El sufijo es numerico y correlativo (`-2`, `-3`) en lugar de aleatorio: un
 * `converse-chuck-70-blanco-2` sigue siendo legible y adivinable por una persona,
 * mientras que `converse-chuck-70-blanco-a7f3` parece un error del sistema.
 */
export function slugDisponible(base: string, ocupados: Iterable<string>): string {
  const tomados = new Set(ocupados);
  if (!tomados.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidato = `${base}-${n}`;
    if (!tomados.has(candidato)) return candidato;
  }
  // Mil colisiones del mismo slug no ocurren por accidente. Se cae al azar en vez
  // de devolver un duplicado, porque un slug repetido rompe el indice unico.
  return `${base}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * SKU por defecto de una variante.
 *
 * Formato `MAR-MODELO-COL-TALLA`, con la talla en tres digitos y sin punto
 * (`9.5` -> `095`), igual que el seed. El ancho constante de la talla hace que las
 * etiquetas se ordenen solas al leerlas entre cajas.
 *
 * Es una PROPUESTA editable: si el comerciante ya rotula sus cajas con otro
 * codigo, el SKU tiene que coincidir con la etiqueta fisica, no con lo que nos
 * parezca ordenado.
 */
export function skuPropuesto(entrada: {
  marca: string;
  modelo: string;
  colorway: string;
  sizeUs: number;
}): string {
  const trozo = (texto: string, largo: number): string =>
    slugify(texto).replace(/-/g, "").slice(0, largo).toUpperCase();

  const talla = String(Math.round(entrada.sizeUs * 10)).padStart(3, "0");
  return [
    trozo(entrada.marca, 3),
    trozo(entrada.modelo, 6),
    trozo(entrada.colorway, 3),
    talla,
  ].join("-");
}
