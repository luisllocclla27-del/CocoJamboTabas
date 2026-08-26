"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatSoles } from "@/lib/money";
import {
  actualizarProducto,
  agregarVarianteAProducto,
  eliminarFotoProducto,
  eliminarProducto,
  eliminarVarianteDeProducto,
  establecerFotoPrincipal,
  subirFotosAdicionales,
} from "@/lib/admin/products";
import { ajustarStock } from "@/lib/admin/inventory";
import { optimizarImagenParaSubida } from "@/lib/images/client-compress";
import {
  CONDICIONES,
  DESCRIPCION_CONDICION,
  ETIQUETA_CONDICION,
  MAX_FOTOS,
  TALLAS_DISPONIBLES,
  type Condicion,
} from "@/lib/admin/products-config";
import type { ProductoAdminDetalle } from "@/lib/admin/queries";
import { BotonCompartirRedes } from "../../boton-compartir";

type Marca = { slug: string; nombre: string; activo: boolean };

export function FormularioEdicion({
  producto,
  marcas,
}: {
  producto: ProductoAdminDetalle;
  marcas: Marca[];
}) {
  const router = useRouter();

  // Estados del formulario principal
  const [guardando, setGuardando] = useState(false);
  const [mensajeOk, setMensajeOk] = useState<string | null>(null);
  const [errorPrincipal, setErrorPrincipal] = useState<string | null>(null);

  const [precio, setPrecio] = useState((producto.priceCents / 100).toFixed(2));
  const [costo, setCosto] = useState((producto.costCents / 100).toFixed(2));
  const [precioTachado, setPrecioTachado] = useState(
    producto.compareAtPriceCents ? (producto.compareAtPriceCents / 100).toFixed(2) : "",
  );
  const [condicionSeleccionada, setCondicionSeleccionada] = useState<Condicion>(
    CONDICIONES.includes(producto.condicion as Condicion)
      ? (producto.condicion as Condicion)
      : "nuevo_en_caja",
  );

  // Estados de gestión de fotos
  const [fotosNuevas, setFotosNuevas] = useState<File[]>([]);
  const [subiendoFotos, setSubiendoFotos] = useState(false);
  const [errorFotos, setErrorFotos] = useState<string | null>(null);
  const [procesandoFotoId, setProcesandoFotoId] = useState<string | null>(null);

  // Estados de nueva talla
  const [nuevaTallaUs, setNuevaTallaUs] = useState<number>(9);
  const [nuevoStock, setNuevoStock] = useState<string>("1");
  const [nuevoSku, setNuevoSku] = useState<string>("");
  const [agregandoTalla, setAgregandoTalla] = useState(false);
  const [errorTalla, setErrorTalla] = useState<string | null>(null);

  // Estado de eliminación de producto
  const [eliminando, setEliminando] = useState(false);

  const margen = useMemo(() => calcularMargen(precio, costo), [precio, costo]);

  // Tallas ya creadas para filtrar las disponibles en el selector de agregar
  const tallasYaCreadas = new Set(producto.variantes.map((v) => v.sizeUs));
  const tallasParaAgregar = TALLAS_DISPONIBLES.filter((t) => !tallasYaCreadas.has(t));

  async function alGuardarDatos(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorPrincipal(null);
    setMensajeOk(null);
    setGuardando(true);

    const datos = new FormData(event.currentTarget);
    const resultado = await actualizarProducto(producto.id, datos);
    setGuardando(false);

    if (!resultado.ok) {
      setErrorPrincipal(resultado.error);
      return;
    }

    setMensajeOk("¡Cambios guardados con éxito!");
    setTimeout(() => setMensajeOk(null), 4000);
    router.refresh();
  }

  async function alElegirFotosNuevas(event: React.ChangeEvent<HTMLInputElement>) {
    const seleccionadas = Array.from(event.target.files ?? []);
    setErrorFotos(null);

    const totalPosible = producto.images.length + seleccionadas.length;
    if (totalPosible > MAX_FOTOS) {
      setErrorFotos(
        `Solo puedes tener un máximo de ${MAX_FOTOS} fotos. Ya tienes ${producto.images.length}.`,
      );
      return;
    }

    // Comprimir en cliente para móvil
    setSubiendoFotos(true);
    try {
      const optimizadas = await Promise.all(
        seleccionadas.map((archivo) => optimizarImagenParaSubida(archivo)),
      );
      setFotosNuevas(optimizadas);
    } catch {
      setFotosNuevas(seleccionadas);
    } finally {
      setSubiendoFotos(false);
    }
  }

  async function alSubirFotosNuevas() {
    if (fotosNuevas.length === 0) return;
    setErrorFotos(null);
    setSubiendoFotos(true);

    const formData = new FormData();
    for (const foto of fotosNuevas) {
      formData.append("fotos", foto);
      formData.append("fotosAlt", `${producto.modelo} ${producto.colorway}`);
    }

    const resultado = await subirFotosAdicionales(producto.id, producto.slug, formData);
    setSubiendoFotos(false);

    if (!resultado.ok) {
      setErrorFotos(resultado.error ?? "No se pudieron subir las fotos.");
      return;
    }

    setFotosNuevas([]);
    router.refresh();
  }

  async function alHacerPrincipal(fotoId: string) {
    setProcesandoFotoId(fotoId);
    await establecerFotoPrincipal(producto.id, fotoId);
    setProcesandoFotoId(null);
    router.refresh();
  }

  async function alEliminarFoto(fotoId: string) {
    if (!confirm("¿Seguro que deseas eliminar esta foto?")) return;
    setProcesandoFotoId(fotoId);
    await eliminarFotoProducto(fotoId);
    setProcesandoFotoId(null);
    router.refresh();
  }

  async function alAgregarNuevaTalla(e: React.FormEvent) {
    e.preventDefault();
    setErrorTalla(null);
    const stockNum = parseInt(nuevoStock, 10);
    if (Number.isNaN(stockNum) || stockNum < 0) {
      setErrorTalla("El stock debe ser un número positivo.");
      return;
    }

    setAgregandoTalla(true);
    const resultado = await agregarVarianteAProducto(
      producto.id,
      nuevaTallaUs,
      stockNum,
      nuevoSku.trim() || undefined,
    );
    setAgregandoTalla(false);

    if (!resultado.ok) {
      setErrorTalla(resultado.error ?? "No se pudo agregar la talla.");
      return;
    }

    setNuevoStock("1");
    setNuevoSku("");
    router.refresh();
  }

  async function alBorrarVariante(variantId: string, sizeUs: number) {
    if (!confirm(`¿Eliminar la talla US ${sizeUs} de este producto?`)) return;
    await eliminarVarianteDeProducto(variantId);
    router.refresh();
  }

  async function alEliminarProductoCompleto() {
    const confirmacion = prompt(
      `Para eliminar este producto escribe "${producto.modelo}" (sin comillas):`,
    );
    if (confirmacion !== producto.modelo) {
      if (confirmacion !== null) alert("El texto no coincide. No se eliminó el producto.");
      return;
    }

    setEliminando(true);
    const resultado = await eliminarProducto(producto.id);
    setEliminando(false);

    if (!resultado.ok) {
      alert(resultado.error ?? "No se pudo eliminar el producto.");
      return;
    }

    if (resultado.archivado) {
      alert(resultado.error);
    } else {
      alert("Producto eliminado exitosamente.");
    }
    router.push("/admin/productos");
  }

  return (
    <div className="space-y-10 pb-20">
      {/* Encabezado con navegación y accesos rápidos */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--color-borde)] pb-5">
        <div>
          <Link
            href="/admin/productos"
            className="text-sm font-semibold text-[var(--color-gris)] hover:text-[var(--color-tinta)]"
          >
            ← Volver a productos
          </Link>
          <h1 className="titular mt-1 text-3xl sm:text-4xl">
            Editar: {producto.brandNombre} {producto.modelo}
          </h1>
          <p className="text-sm text-[var(--color-gris)]">{producto.colorway}</p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Link
            href={`/producto/${producto.slug}`}
            target="_blank"
            className="rounded-full border border-[var(--color-borde)] px-4 py-2 text-sm font-medium hover:border-[var(--color-tinta)]"
          >
            👁️ Ver en la tienda
          </Link>
          <BotonCompartirRedes
            producto={{
              marca: producto.brandNombre,
              modelo: producto.modelo,
              colorway: producto.colorway,
              priceCents: producto.priceCents,
              compareAtPriceCents: producto.compareAtPriceCents,
              tallas: producto.variantes.map((v) => ({ sizeUs: v.sizeUs, stock: v.stock })),
              slug: producto.slug,
            }}
          />
        </div>
      </div>

      {mensajeOk && (
        <div
          role="status"
          className="rounded-xl border-2 border-[var(--color-exito)] bg-[var(--color-exito)]/10 p-4 font-semibold text-[var(--color-exito)]"
        >
          {mensajeOk}
        </div>
      )}

      {errorPrincipal && (
        <div
          role="alert"
          className="rounded-xl border-2 border-[var(--color-alerta)] bg-[var(--color-alerta)]/10 p-4 font-medium text-[var(--color-alerta)]"
        >
          {errorPrincipal}
        </div>
      )}

      {/* SECCIÓN 1: GESTIÓN DE FOTOS */}
      <section className="rounded-2xl border border-[var(--color-borde)] bg-[var(--color-papel)] p-6 shadow-xs">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-[var(--color-borde)] pb-4">
          <div>
            <h2 className="titular text-2xl">Fotos del producto</h2>
            <p className="text-sm text-[var(--color-gris)]">
              La primera foto marcada como portada es la que se muestra en el catálogo. Máximo{" "}
              {MAX_FOTOS} fotos.
            </p>
          </div>
          <span className="rounded-full bg-[var(--color-humo)] px-3 py-1 text-xs font-semibold">
            {producto.images.length} / {MAX_FOTOS} fotos
          </span>
        </div>

        {/* Galería actual */}
        {producto.images.length === 0 ? (
          <p className="py-8 text-center text-sm text-[var(--color-gris)]">
            Este producto aún no tiene fotos cargadas. Sube al menos una para publicarlo.
          </p>
        ) : (
          <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
            {producto.images.map((img) => (
              <div
                key={img.id}
                className={`group relative flex flex-col overflow-hidden rounded-xl border-2 bg-[var(--color-humo)] ${
                  img.esPrincipal
                    ? "border-[var(--color-acento-oscuro)] ring-2 ring-[var(--color-acento-oscuro)]/30"
                    : "border-[var(--color-borde)]"
                }`}
              >
                <div className="relative aspect-square w-full">
                  <Image src={img.url} alt={img.alt} fill className="object-cover" sizes="200px" />
                  {img.esPrincipal && (
                    <span className="absolute left-2 top-2 rounded-md bg-[var(--color-tinta)] px-2 py-0.5 text-[10px] font-bold text-[var(--color-papel)]">
                      PORTADA
                    </span>
                  )}
                </div>

                <div className="flex flex-col gap-1.5 p-2 bg-[var(--color-papel)] border-t border-[var(--color-borde)]">
                  {!img.esPrincipal && (
                    <button
                      type="button"
                      onClick={() => alHacerPrincipal(img.id)}
                      disabled={procesandoFotoId === img.id}
                      className="rounded bg-[var(--color-humo)] py-1 text-xs font-semibold text-[var(--color-tinta)] hover:bg-[var(--color-acento)] disabled:opacity-50"
                    >
                      {procesandoFotoId === img.id ? "Cambiando..." : "Hacer portada"}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => alEliminarFoto(img.id)}
                    disabled={procesandoFotoId === img.id}
                    className="rounded py-1 text-xs font-semibold text-[var(--color-alerta)] hover:bg-[var(--color-alerta)]/10 disabled:opacity-50"
                  >
                    {procesandoFotoId === img.id ? "Borrando..." : "Eliminar"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Añadir más fotos */}
        {producto.images.length < MAX_FOTOS && (
          <div className="mt-8 rounded-xl border-2 border-dashed border-[var(--color-borde)] bg-[var(--color-humo)]/50 p-5">
            <h3 className="text-sm font-bold">Subir fotos nuevas desde tu dispositivo / celular</h3>
            <p className="text-xs text-[var(--color-gris)]">
              Las fotos se comprimen automáticamente en tu navegador para subirse rápido sin perder
              calidad.
            </p>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <input
                type="file"
                id="input-fotos-nuevas"
                accept="image/jpeg,image/png,image/webp,image/avif"
                multiple
                onChange={alElegirFotosNuevas}
                className="text-xs file:mr-3 file:rounded-full file:border-0 file:bg-[var(--color-tinta)] file:px-4 file:py-2 file:text-xs file:font-semibold file:text-[var(--color-papel)] file:cursor-pointer hover:file:bg-[var(--color-tinta-suave)]"
              />

              {fotosNuevas.length > 0 && (
                <button
                  type="button"
                  onClick={alSubirFotosNuevas}
                  disabled={subiendoFotos}
                  className="rounded-full bg-[var(--color-acento)] px-5 py-2 text-xs font-bold text-[var(--color-tinta)] hover:bg-[var(--color-acento-oscuro)] disabled:opacity-50 cursor-pointer"
                >
                  {subiendoFotos ? "Subiendo..." : `Guardar ${fotosNuevas.length} foto(s)`}
                </button>
              )}
            </div>

            {errorFotos && <p className="mt-2 text-xs text-[var(--color-alerta)]">{errorFotos}</p>}
          </div>
        )}
      </section>

      {/* SECCIÓN 2: DATOS DEL PRODUCTO */}
      <form
        onSubmit={alGuardarDatos}
        className="rounded-2xl border border-[var(--color-borde)] bg-[var(--color-papel)] p-6 shadow-xs"
      >
        <h2 className="titular text-2xl border-b border-[var(--color-borde)] pb-4">
          Información general y precios
        </h2>

        <div className="mt-6 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <label htmlFor="brandSlug" className="block text-xs font-semibold uppercase text-[var(--color-gris)]">
              Marca *
            </label>
            <select
              id="brandSlug"
              name="brandSlug"
              defaultValue={producto.brandSlug}
              required
              className="mt-1.5 w-full rounded-lg border border-[var(--color-borde)] bg-[var(--color-papel)] px-3 py-2 text-sm"
            >
              {marcas.map((m) => (
                <option key={m.slug} value={m.slug}>
                  {m.nombre} {!m.activo ? "(marca inactiva)" : ""}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="modelo" className="block text-xs font-semibold uppercase text-[var(--color-gris)]">
              Modelo *
            </label>
            <input
              id="modelo"
              name="modelo"
              type="text"
              defaultValue={producto.modelo}
              required
              maxLength={80}
              className="mt-1.5 w-full rounded-lg border border-[var(--color-borde)] bg-[var(--color-papel)] px-3 py-2 text-sm font-semibold"
            />
          </div>

          <div>
            <label htmlFor="colorway" className="block text-xs font-semibold uppercase text-[var(--color-gris)]">
              Color / Colorway *
            </label>
            <input
              id="colorway"
              name="colorway"
              type="text"
              defaultValue={producto.colorway}
              required
              maxLength={80}
              className="mt-1.5 w-full rounded-lg border border-[var(--color-borde)] bg-[var(--color-papel)] px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label htmlFor="precio" className="block text-xs font-semibold uppercase text-[var(--color-gris)]">
              Precio de venta (S/) *
            </label>
            <input
              id="precio"
              name="precio"
              type="text"
              inputMode="decimal"
              value={precio}
              onChange={(e) => setPrecio(e.target.value)}
              required
              placeholder="289.00"
              className="cifra mt-1.5 w-full rounded-lg border border-[var(--color-borde)] bg-[var(--color-papel)] px-3 py-2 text-sm font-bold"
            />
          </div>

          <div>
            <label htmlFor="costo" className="block text-xs font-semibold uppercase text-[var(--color-gris)]">
              Costo de compra del par (S/) *
            </label>
            <input
              id="costo"
              name="costo"
              type="text"
              inputMode="decimal"
              value={costo}
              onChange={(e) => setCosto(e.target.value)}
              required
              placeholder="180.00"
              className="cifra mt-1.5 w-full rounded-lg border border-[var(--color-borde)] bg-[var(--color-papel)] px-3 py-2 text-sm font-medium"
            />
          </div>

          <div>
            <label htmlFor="precioTachado" className="block text-xs font-semibold uppercase text-[var(--color-gris)]">
              Precio tachado / Oferta (S/)
            </label>
            <input
              id="precioTachado"
              name="precioTachado"
              type="text"
              inputMode="decimal"
              value={precioTachado}
              onChange={(e) => setPrecioTachado(e.target.value)}
              placeholder="349.00"
              className="cifra mt-1.5 w-full rounded-lg border border-[var(--color-borde)] bg-[var(--color-papel)] px-3 py-2 text-sm"
            />
          </div>
        </div>

        {/* Indicador de Margen en Vivo */}
        <div className="mt-4 flex items-center justify-between rounded-lg bg-[var(--color-humo)] p-3 text-xs">
          <span>
            Ganancia estimada por par:{" "}
            <strong className="cifra text-sm text-[var(--color-exito)]">
              {margen.gananciaTexto}
            </strong>
          </span>
          <span>
            Margen:{" "}
            <strong className="cifra text-sm text-[var(--color-tinta)]">
              {margen.porcentajeTexto}
            </strong>
          </span>
        </div>

        <div className="mt-6 grid gap-6 sm:grid-cols-2">
          <div>
            <label htmlFor="condicion" className="block text-xs font-semibold uppercase text-[var(--color-gris)]">
              Condición
            </label>
            <select
              id="condicion"
              name="condicion"
              value={condicionSeleccionada}
              onChange={(e) => setCondicionSeleccionada(e.target.value as Condicion)}
              className="mt-1.5 w-full rounded-lg border border-[var(--color-borde)] bg-[var(--color-papel)] px-3 py-2 text-sm"
            >
              {CONDICIONES.map((c: Condicion) => (
                <option key={c} value={c}>
                  {ETIQUETA_CONDICION[c]}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-[var(--color-gris)]">
              {DESCRIPCION_CONDICION[condicionSeleccionada]}
            </p>
          </div>

          <div>
            <label htmlFor="silueta" className="block text-xs font-semibold uppercase text-[var(--color-gris)]">
              Silueta (ej: High Top, Low, Retro)
            </label>
            <input
              id="silueta"
              name="silueta"
              type="text"
              defaultValue={producto.silueta ?? ""}
              maxLength={60}
              className="mt-1.5 w-full rounded-lg border border-[var(--color-borde)] bg-[var(--color-papel)] px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div className="mt-6 space-y-4">
          <div>
            <label htmlFor="notaCalce" className="block text-xs font-semibold uppercase text-[var(--color-gris)]">
              Nota de calce (ej: "Viene medio número grande, recomendamos pedir media talla menos")
            </label>
            <input
              id="notaCalce"
              name="notaCalce"
              type="text"
              defaultValue={producto.notaCalce ?? ""}
              maxLength={200}
              className="mt-1.5 w-full rounded-lg border border-[var(--color-borde)] bg-[var(--color-papel)] px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label htmlFor="descripcion" className="block text-xs font-semibold uppercase text-[var(--color-gris)]">
              Descripción detallada
            </label>
            <textarea
              id="descripcion"
              name="descripcion"
              rows={3}
              defaultValue={producto.descripcion ?? ""}
              maxLength={1000}
              className="mt-1.5 w-full rounded-lg border border-[var(--color-borde)] bg-[var(--color-papel)] px-3 py-2 text-sm"
            />
          </div>
        </div>

        {/* Opciones de visibilidad */}
        <div className="mt-6 flex flex-wrap gap-6 border-t border-[var(--color-borde)] pt-6">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              name="activo"
              value="true"
              defaultChecked={producto.activo}
              className="h-4 w-4 rounded accent-[var(--color-tinta)]"
            />
            <span className="text-sm font-semibold">Mostrar en la tienda (Producto visible)</span>
          </label>

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              name="destacado"
              value="true"
              defaultChecked={producto.destacado}
              className="h-4 w-4 rounded accent-[var(--color-acento-oscuro)]"
            />
            <span className="text-sm font-semibold">Destacar en la portada principal</span>
          </label>
        </div>

        <div className="mt-8 flex justify-end">
          <button
            type="submit"
            disabled={guardando}
            className="rounded-full bg-[var(--color-tinta)] px-8 py-3 text-sm font-bold text-[var(--color-papel)] hover:bg-[var(--color-tinta-suave)] disabled:opacity-50 cursor-pointer"
          >
            {guardando ? "Guardando cambios..." : "Guardar cambios generales"}
          </button>
        </div>
      </form>

      {/* SECCIÓN 3: GESTIÓN DE TALLAS Y STOCK */}
      <section className="rounded-2xl border border-[var(--color-borde)] bg-[var(--color-papel)] p-6 shadow-xs">
        <h2 className="titular text-2xl border-b border-[var(--color-borde)] pb-4">
          Tallas y Stock disponible
        </h2>
        <p className="mt-2 text-sm text-[var(--color-gris)]">
          Modifica los números directamente para actualizar el inventario. El cambio se guarda al
          perder el foco o pulsar Enter.
        </p>

        <div className="mt-6 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--color-borde)] text-xs uppercase text-[var(--color-gris)]">
                <th className="py-2.5 px-3">Talla US</th>
                <th className="py-2.5 px-3">Equiv. EU / CM</th>
                <th className="py-2.5 px-3">SKU</th>
                <th className="py-2.5 px-3 w-32">Pares en Stock</th>
                <th className="py-2.5 px-3 text-right">Acción</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-borde)]">
              {producto.variantes.map((variante) => (
                <tr key={variante.id} className={!variante.activo ? "opacity-50" : ""}>
                  <td className="py-3 px-3 font-bold cifra">US {variante.sizeUs}</td>
                  <td className="py-3 px-3 cifra text-xs text-[var(--color-gris)]">
                    {variante.sizeEu ? `EU ${variante.sizeEu}` : "-"} ·{" "}
                    {variante.sizeCm ? `${variante.sizeCm} cm` : "-"}
                  </td>
                  <td className="py-3 px-3 text-xs font-mono text-[var(--color-gris)]">
                    {variante.sku}
                  </td>
                  <td className="py-3 px-3">
                    <CampoStockInline variante={variante} />
                  </td>
                  <td className="py-3 px-3 text-right">
                    <button
                      type="button"
                      onClick={() => alBorrarVariante(variante.id, variante.sizeUs)}
                      className="text-xs font-semibold text-[var(--color-alerta)] hover:underline"
                    >
                      Quitar talla
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Formulario para añadir nueva talla */}
        {tallasParaAgregar.length > 0 && (
          <form
            onSubmit={alAgregarNuevaTalla}
            className="mt-8 rounded-xl bg-[var(--color-humo)] p-4 flex flex-wrap items-end gap-3"
          >
            <div>
              <label htmlFor="nuevaTallaUs" className="block text-xs font-bold text-[var(--color-gris)]">
                Añadir talla US
              </label>
              <select
                id="nuevaTallaUs"
                value={nuevaTallaUs}
                onChange={(e) => setNuevaTallaUs(Number(e.target.value))}
                className="mt-1 rounded-lg border border-[var(--color-borde)] bg-[var(--color-papel)] px-3 py-1.5 text-sm"
              >
                {tallasParaAgregar.map((t) => (
                  <option key={t} value={t}>
                    US {t}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="nuevoStock" className="block text-xs font-bold text-[var(--color-gris)]">
                Stock inicial
              </label>
              <input
                id="nuevoStock"
                type="number"
                min="0"
                max="999"
                value={nuevoStock}
                onChange={(e) => setNuevoStock(e.target.value)}
                className="cifra mt-1 w-20 rounded-lg border border-[var(--color-borde)] bg-[var(--color-papel)] px-3 py-1.5 text-sm font-semibold"
              />
            </div>

            <div>
              <label htmlFor="nuevoSku" className="block text-xs font-bold text-[var(--color-gris)]">
                SKU (opcional)
              </label>
              <input
                id="nuevoSku"
                type="text"
                placeholder="Autogenerado"
                value={nuevoSku}
                onChange={(e) => setNuevoSku(e.target.value)}
                className="mt-1 w-32 rounded-lg border border-[var(--color-borde)] bg-[var(--color-papel)] px-3 py-1.5 text-xs font-mono"
              />
            </div>

            <button
              type="submit"
              disabled={agregandoTalla}
              className="rounded-lg bg-[var(--color-tinta)] px-4 py-1.5 text-xs font-bold text-[var(--color-papel)] hover:bg-[var(--color-tinta-suave)] disabled:opacity-50 cursor-pointer"
            >
              {agregandoTalla ? "Agregando..." : "+ Añadir talla"}
            </button>

            {errorTalla && <p className="w-full text-xs text-[var(--color-alerta)]">{errorTalla}</p>}
          </form>
        )}
      </section>

      {/* SECCIÓN 4: ZONA DE PELIGRO */}
      <section className="rounded-2xl border border-[var(--color-alerta)]/30 bg-[var(--color-alerta)]/5 p-6">
        <h2 className="titular text-xl text-[var(--color-alerta)]">Zona de peligro</h2>
        <p className="mt-1 text-sm text-[var(--color-gris)]">
          Si el producto ya tiene ventas históricas asociadas, se ocultará y desactivará del
          catálogo para preservar la contabilidad. Si no tiene ventas, se eliminará por completo.
        </p>

        <div className="mt-4">
          <button
            type="button"
            onClick={alEliminarProductoCompleto}
            disabled={eliminando}
            className="rounded-full bg-[var(--color-alerta)] px-6 py-2 text-xs font-bold text-white hover:bg-[var(--color-alerta)]/80 disabled:opacity-50 cursor-pointer"
          >
            {eliminando ? "Eliminando..." : "Eliminar / Desactivar producto"}
          </button>
        </div>
      </section>
    </div>
  );
}

function CampoStockInline({
  variante,
}: {
  variante: { id: string; stock: number; sizeUs: number };
}) {
  const router = useRouter();
  const [valor, setValor] = useState(String(variante.stock));
  const [guardando, setGuardando] = useState(false);

  async function guardar() {
    const num = Number(valor);
    if (!Number.isFinite(num) || num === variante.stock) {
      setValor(String(variante.stock));
      return;
    }
    setGuardando(true);
    await ajustarStock({ variantId: variante.id, stock: num });
    setGuardando(false);
    router.refresh();
  }

  return (
    <div className="flex items-center gap-2">
      <input
        type="number"
        min={0}
        max={999}
        value={valor}
        onChange={(e) => setValor(e.target.value)}
        onBlur={guardar}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
        className="cifra w-16 rounded-md border border-[var(--color-borde)] bg-[var(--color-papel)] px-2 py-1 text-sm font-bold text-center"
      />
      {guardando && <span className="text-[10px] text-[var(--color-gris)]">...</span>}
    </div>
  );
}

function calcularMargen(precioStr: string, costoStr: string) {
  const p = parseFloat(precioStr.replace(",", "."));
  const c = parseFloat(costoStr.replace(",", "."));
  if (Number.isNaN(p) || Number.isNaN(c) || p <= 0) {
    return { gananciaTexto: "S/ 0.00", porcentajeTexto: "0%" };
  }
  const ganancia = p - c;
  const pct = (ganancia / p) * 100;
  return {
    gananciaTexto: `S/ ${ganancia.toFixed(2)}`,
    porcentajeTexto: `${pct.toFixed(0)}%`,
  };
}
