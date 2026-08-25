"use server";

/**
 * Alta de productos desde el panel.
 *
 * CIERRA LA ÚLTIMA DEPENDENCIA DEL SQL EDITOR. Hasta ahora, dar de alta un modelo
 * nuevo exigía escribir tres `insert` a mano en Supabase: producto, imágenes y una
 * fila por talla. Eso funciona para quien escribió el esquema y para nadie más, y
 * convierte la tarea más frecuente del negocio (llegó mercadería nueva) en algo que
 * el comerciante no puede hacer solo.
 *
 * TRES DECISIONES QUE GOBIERNAN ESTE ARCHIVO:
 *
 * 1. **El producto se crea primero y las fotos después.** No es lo ideal (un fallo
 *    al subir deja un producto sin foto), pero la alternativa es peor: subir a
 *    Storage antes de tener el `product_id` obliga a inventar una ruta temporal y
 *    a moverla luego, y un fallo ahí deja archivos huérfanos que nadie limpia. Con
 *    este orden, el caso degradado es un producto visible sin foto, que el admin ve
 *    de inmediato en su lista y corrige subiéndola otra vez.
 *
 * 2. **El producto nace inactivo si algo falla a medias.** Un producto sin fotos ni
 *    tallas en el catálogo público es peor que un producto que no existe: el cliente
 *    entra, no ve nada y se va. Ante un fallo parcial se desactiva y se le dice al
 *    admin qué quedó pendiente.
 *
 * 3. **Los magic bytes se validan antes de subir**, con el módulo compartido de
 *    `lib/images`. El bucket `productos` es público en lectura, así que un archivo
 *    que no sea imagen ahí es alojamiento gratuito con el dominio del negocio
 *    dándole credibilidad.
 */

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/client";
import { createServerClient, isAdmin } from "@/lib/supabase/server";
import { detectarTipoImagen, extensionDeTipo, type TipoImagen } from "@/lib/images/magic-bytes";
import { slugDisponible, slugProducto, skuPropuesto } from "@/lib/catalog/slug";
import { fromUS } from "@/lib/sizes";
import {
  altaProductoSchema,
  MAX_BYTES_FOTO,
  MAX_FOTOS,
  type ResultadoAlta,
} from "./products-config";

/** Tipos que acepta el bucket `productos`. HEIC queda fuera: no lo pinta el navegador. */
const TIPOS_FOTO = new Set<TipoImagen>(["image/jpeg", "image/png", "image/webp", "image/avif"]);

/**
 * Crea un producto con sus tallas y sus fotos.
 *
 * Recibe `FormData` y no un objeto porque los archivos solo viajan así. Los campos
 * de texto se parsean con Zod igual que en el resto del proyecto.
 */
export async function crearProducto(datos: FormData): Promise<ResultadoAlta> {
  if (!(await isAdmin())) return { ok: false, error: "No tienes permiso para esta acción." };

  const parsed = altaProductoSchema.safeParse(leerEntrada(datos));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      error: issue?.message ?? "Revisa los datos del formulario.",
      ...(issue !== undefined ? { campo: issue.path.join(".") } : {}),
    };
  }
  const entrada = parsed.data;

  // Las fotos se leen y validan ANTES de tocar la base: rechazar un archivo
  // después de haber creado el producto dejaría basura que alguien tiene que
  // limpiar a mano.
  const fotos = await leerFotos(datos);
  if ("error" in fotos) return { ok: false, error: fotos.error, campo: "fotos" };

  const supabase = createAdminClient();

  const { data: marca, error: errorMarca } = await supabase
    .from("brands")
    .select("id, nombre")
    .eq("slug", entrada.brandSlug)
    .maybeSingle();

  if (errorMarca !== null || marca === null) {
    return { ok: false, error: "Esa marca no existe.", campo: "brandSlug" };
  }

  const slug = await slugLibre(supabase, {
    marca: marca.nombre,
    modelo: entrada.modelo,
    colorway: entrada.colorway,
  });

  const { data: producto, error: errorProducto } = await supabase
    .from("products")
    .insert({
      slug,
      brand_id: marca.id,
      modelo: entrada.modelo,
      colorway: entrada.colorway,
      silueta: entrada.silueta ?? null,
      descripcion: entrada.descripcion ?? null,
      condicion: entrada.condicion,
      cost_cents: entrada.costCents,
      price_cents: entrada.priceCents,
      compare_at_price_cents: entrada.compareAtPriceCents ?? null,
      nota_calce: entrada.notaCalce ?? null,
      // Nace oculto: se publica cuando el admin confirma que las fotos y las
      // tallas quedaron bien. Publicar a ciegas expone una ficha a medias al
      // primer cliente que entre.
      activo: false,
      destacado: entrada.destacado,
    })
    .select("id")
    .single();

  if (errorProducto !== null || producto === null) {
    // 23505 sobre el slug: dos altas simultáneas del mismo modelo. La unicidad la
    // impone el índice, y aquí basta con pedir que se reintente.
    if (errorProducto?.code === "23505") {
      return { ok: false, error: "Ese producto ya existe. Revisa el catálogo." };
    }
    return { ok: false, error: "No pudimos crear el producto." };
  }

  const errores: string[] = [];

  const variantes = entrada.variantes.map((v) => {
    const equivalencia = fromUS(v.sizeUs);
    return {
      product_id: producto.id,
      size_us: v.sizeUs,
      // Las equivalencias EU y CM salen de la tabla de referencia como valor por
      // defecto. Son aproximadas por marca y el comerciante puede corregirlas;
      // ver la cabecera de `lib/sizes.ts`.
      size_eu: equivalencia?.eu ?? null,
      size_cm: equivalencia?.cm ?? null,
      sku:
        v.sku !== undefined && v.sku !== ""
          ? v.sku
          : skuPropuesto({
              marca: marca.nombre,
              modelo: entrada.modelo,
              colorway: entrada.colorway,
              sizeUs: v.sizeUs,
            }),
      stock: v.stock,
      activo: true,
    };
  });

  const { error: errorVariantes } = await supabase.from("variants").insert(variantes);
  if (errorVariantes !== null) {
    errores.push(
      errorVariantes.code === "23505"
        ? "Alguna talla quedó sin crear porque su SKU ya existe en otro producto."
        : "Las tallas no se pudieron crear.",
    );
  } else {
    // El movimiento inicial de inventario: sin él, el historial de una talla
    // empezaría con un stock que apareció de la nada y no cuadraría al sumar
    // los deltas.
    await registrarAltaEnHistorial(supabase, producto.id, await actorAdmin());
  }

  const subidas = await subirFotos(supabase, producto.id, slug, fotos.archivos);
  if (subidas.fallidas > 0) {
    errores.push(
      `${subidas.fallidas} de ${fotos.archivos.length} fotos no se pudieron guardar.`,
    );
  }

  revalidatePath("/admin/productos");
  revalidatePath("/catalogo");

  if (errores.length > 0) {
    return {
      ok: false,
      error: `El producto se creó oculto, pero quedó incompleto: ${errores.join(" ")} Revísalo en la lista y corrige lo que falte.`,
    };
  }

  return { ok: true, slug, fotosSubidas: subidas.correctas };
}

/**
 * Extrae y aplana el `FormData`.
 *
 * Las variantes llegan como JSON en un solo campo en vez de como `variantes[0].sizeUs`:
 * el formato indexado obliga a reconstruir el array adivinando índices, y un hueco
 * en la numeración produce un `undefined` en medio del array que Zod reporta con un
 * mensaje incomprensible.
 */
function leerEntrada(datos: FormData): Record<string, unknown> {
  const texto = (clave: string): string | undefined => {
    const valor = datos.get(clave);
    if (typeof valor !== "string") return undefined;
    const limpio = valor.trim();
    return limpio === "" ? undefined : limpio;
  };

  let variantes: unknown = [];
  try {
    variantes = JSON.parse(String(datos.get("variantes") ?? "[]"));
  } catch {
    // Un JSON inválido se deja como array vacío: Zod lo reportará como "agrega al
    // menos una talla", que es lo que el admin necesita leer.
    variantes = [];
  }

  return {
    brandSlug: texto("brandSlug") ?? "",
    modelo: texto("modelo") ?? "",
    colorway: texto("colorway") ?? "",
    silueta: texto("silueta"),
    descripcion: texto("descripcion"),
    condicion: texto("condicion") ?? "nuevo_en_caja",
    priceCents: texto("precio") ?? "",
    costCents: texto("costo") ?? "",
    compareAtPriceCents: texto("precioTachado"),
    notaCalce: texto("notaCalce"),
    destacado: datos.get("destacado") === "true",
    variantes,
  };
}

type FotoValidada = { bytes: Uint8Array; tipo: TipoImagen; alt: string };

/**
 * Lee las fotos del `FormData` y valida cada una.
 *
 * Un solo archivo inválido aborta el alta entera en lugar de subir el resto: el
 * admin acaba de elegir esas fotos y espera que estén todas, y descubrir tres días
 * después que falta una es peor que corregirlo ahora.
 */
async function leerFotos(
  datos: FormData,
): Promise<{ archivos: FotoValidada[] } | { error: string }> {
  const archivos = datos.getAll("fotos").filter((f): f is File => f instanceof File && f.size > 0);

  if (archivos.length > MAX_FOTOS) {
    return { error: `Máximo ${MAX_FOTOS} fotos por producto.` };
  }

  // El `alt` de cada foto es obligatorio en la base por accesibilidad. Si el admin
  // no lo escribió, se compone uno con el modelo y el color, que es mejor que un
  // texto vacío y honesto sobre lo que describe.
  const altsCrudos = datos.getAll("fotosAlt").map((a) => String(a).trim());
  const modelo = String(datos.get("modelo") ?? "").trim();
  const colorway = String(datos.get("colorway") ?? "").trim();

  const validadas: FotoValidada[] = [];
  for (const [indice, archivo] of archivos.entries()) {
    if (archivo.size > MAX_BYTES_FOTO) {
      return {
        error: `"${archivo.name}" pesa más de ${Math.round(MAX_BYTES_FOTO / (1024 * 1024))} MB. Redúcela antes de subirla.`,
      };
    }

    const bytes = new Uint8Array(await archivo.arrayBuffer());
    const tipo = detectarTipoImagen(bytes);

    // No se confía en `archivo.type`: lo declara el cliente. Ver `lib/images`.
    if (tipo === null || !TIPOS_FOTO.has(tipo)) {
      return {
        error: `"${archivo.name}" no es una imagen JPG, PNG, WebP o AVIF válida.`,
      };
    }

    const alt = altsCrudos[indice] ?? "";
    validadas.push({
      bytes,
      tipo,
      alt:
        alt !== ""
          ? alt.slice(0, 200)
          : `${modelo} ${colorway}, foto ${indice + 1}`.trim(),
    });
  }

  return { archivos: validadas };
}

/**
 * Sube las fotos y crea las filas de `product_images`.
 *
 * La primera es la principal. El índice único `ux_product_images_principal` de
 * 0007 garantiza que no haya dos, y por eso solo la de orden 0 lleva la marca.
 */
async function subirFotos(
  supabase: ReturnType<typeof createAdminClient>,
  productId: string,
  slug: string,
  fotos: FotoValidada[],
): Promise<{ correctas: number; fallidas: number }> {
  let correctas = 0;
  let fallidas = 0;

  for (const [indice, foto] of fotos.entries()) {
    // El slug en la ruta hace legible el bucket al mirarlo desde el panel de
    // Supabase; el uuid evita colisiones al resubir la misma foto.
    const nombre = `${crypto.randomUUID()}.${extensionDeTipo(foto.tipo)}`;
    const ruta = `${slug}/${nombre}`;

    const { error: errorSubida } = await supabase.storage
      .from("productos")
      .upload(ruta, foto.bytes, { contentType: foto.tipo, upsert: false });

    if (errorSubida !== null) {
      fallidas++;
      continue;
    }

    const { data: publica } = supabase.storage.from("productos").getPublicUrl(ruta);

    const { error: errorFila } = await supabase.from("product_images").insert({
      product_id: productId,
      url: publica.publicUrl,
      alt: foto.alt,
      orden: indice,
      es_principal: indice === 0,
    });

    if (errorFila !== null) {
      // La fila es lo que hace visible la foto: sin ella el archivo es peso
      // muerto en el bucket, así que se borra.
      await supabase.storage.from("productos").remove([ruta]);
      fallidas++;
      continue;
    }

    correctas++;
  }

  return { correctas, fallidas };
}

/**
 * Registra el stock inicial de cada talla en el historial.
 *
 * Se hace después de insertar las variantes y no con `adjust_stock()`, porque esa
 * función parte de un stock anterior y aquí el anterior es cero por definición.
 * Un fallo aquí no invalida el alta: se registra y se sigue.
 */
async function registrarAltaEnHistorial(
  supabase: ReturnType<typeof createAdminClient>,
  productId: string,
  actor: string,
): Promise<void> {
  const { data } = await supabase
    .from("variants")
    .select("id, stock")
    .eq("product_id", productId)
    .gt("stock", 0);

  const movimientos = (data ?? []).map((v) => ({
    variant_id: v.id,
    delta: v.stock,
    stock_antes: 0,
    stock_despues: v.stock,
    motivo: "alta_producto",
    actor,
  }));

  if (movimientos.length === 0) return;

  const { error } = await supabase.from("inventory_moves").insert(movimientos);
  if (error !== null) {
    // Sin la migración 0007 la tabla no existe. El producto está creado y
    // funcional; lo que falta es la traza, y decirlo en el log es suficiente.
    console.warn(`[productos] no se registró el alta en inventory_moves: ${error.message}`);
  }
}

/** Slug libre, consultando los que ya empiezan por el candidato. */
async function slugLibre(
  supabase: ReturnType<typeof createAdminClient>,
  entrada: { marca: string; modelo: string; colorway: string },
): Promise<string> {
  const base = slugProducto(entrada);
  const { data } = await supabase.from("products").select("slug").like("slug", `${base}%`);
  return slugDisponible(base, (data ?? []).map((f) => f.slug));
}

async function actorAdmin(): Promise<string> {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user === null ? "admin:desconocido" : `admin:${user.id}`;
}
