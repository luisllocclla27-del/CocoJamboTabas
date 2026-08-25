"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { crearProducto } from "@/lib/admin/products";
import {
  CONDICIONES,
  ETIQUETA_CONDICION,
  MAX_FOTOS,
  TALLAS_DISPONIBLES,
} from "@/lib/admin/products-config";

/**
 * Formulario de alta de producto.
 *
 * CIERRA LA ÚLTIMA TAREA QUE EXIGÍA EL SQL EDITOR. Dar de alta un modelo nuevo era
 * lo más frecuente del negocio ("llegó mercadería") y lo único que el comerciante no
 * podía hacer solo.
 *
 * TRES DECISIONES DE INTERFAZ:
 *
 * 1. **Las tallas se eligen con una rejilla de casillas, no con un selector.** Al
 *    recibir mercadería se cargan seis o siete tallas del mismo modelo; un selector
 *    con "añadir talla" convierte eso en veinte clics. La rejilla muestra las 17
 *    tallas de la tabla de referencia y solo pide el stock de las marcadas.
 *
 * 2. **El margen se calcula mientras se escribe.** Es la cifra que decide el precio,
 *    y verla después de guardar es verla tarde.
 *
 * 3. **El producto nace oculto y el formulario lo dice antes de enviar.** Así el
 *    "no aparece en la tienda" no es una sorpresa, sino el comportamiento anunciado:
 *    se publica desde la lista cuando el admin confirma que las fotos quedaron bien.
 */

type Marca = { slug: string; nombre: string; activo: boolean };

type Talla = { sizeUs: number; stock: string; marcada: boolean };

export function FormularioAlta({ marcas }: { marcas: Marca[] }) {
  const router = useRouter();
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<{ slug: string; fotos: number } | null>(null);

  const [precio, setPrecio] = useState("");
  const [costo, setCosto] = useState("");
  const [fotos, setFotos] = useState<File[]>([]);
  const [tallas, setTallas] = useState<Talla[]>(
    TALLAS_DISPONIBLES.map((sizeUs) => ({ sizeUs, stock: "1", marcada: false })),
  );

  const margen = useMemo(() => calcularMargen(precio, costo), [precio, costo]);
  const marcadas = tallas.filter((t) => t.marcada);
  const paresTotales = marcadas.reduce((suma, t) => suma + (Number(t.stock) || 0), 0);

  // Las URL de vista previa se crean una vez por selección y se revocan al
  // cambiarla: generarlas dentro del render fugaba un blob por cada repintado, y
  // cargar seis fotos de 8 MB hace muchos repintados.
  const previas = useMemo(() => fotos.map((foto) => URL.createObjectURL(foto)), [fotos]);
  useEffect(() => {
    return () => {
      for (const url of previas) URL.revokeObjectURL(url);
    };
  }, [previas]);

  function alternarTalla(sizeUs: number) {
    setTallas((previas) =>
      previas.map((t) => (t.sizeUs === sizeUs ? { ...t, marcada: !t.marcada } : t)),
    );
  }

  function cambiarStock(sizeUs: number, valor: string) {
    setTallas((previas) =>
      previas.map((t) => (t.sizeUs === sizeUs ? { ...t, stock: valor } : t)),
    );
  }

  function alElegirFotos(event: React.ChangeEvent<HTMLInputElement>) {
    const elegidas = Array.from(event.target.files ?? []);
    setError(null);
    if (elegidas.length > MAX_FOTOS) {
      setError(`Máximo ${MAX_FOTOS} fotos por producto.`);
      setFotos(elegidas.slice(0, MAX_FOTOS));
      return;
    }
    setFotos(elegidas);
  }

  async function alEnviar(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (marcadas.length === 0) {
      setError("Marca al menos una talla y ponle su stock.");
      return;
    }

    const datos = new FormData(event.currentTarget);
    // Las variantes viajan como JSON en un solo campo: reconstruir un array desde
    // `variantes[0].sizeUs` obliga a adivinar índices y un hueco produce un
    // `undefined` en medio que Zod reporta con un mensaje incomprensible.
    datos.set(
      "variantes",
      JSON.stringify(
        marcadas.map((t) => ({ sizeUs: t.sizeUs, stock: Number(t.stock) || 0 })),
      ),
    );
    // El input de archivos ya va en el FormData por su `name`; los alt se añaden en
    // el mismo orden para que el servidor los empareje por índice.
    for (const foto of fotos) datos.append("fotosAlt", nombreLegible(foto.name));

    setEnviando(true);
    const resultado = await crearProducto(datos);
    setEnviando(false);

    if (!resultado.ok) {
      setError(resultado.error);
      return;
    }
    setOk({ slug: resultado.slug, fotos: resultado.fotosSubidas });
    router.refresh();
  }

  if (ok !== null) {
    return (
      <section
        role="status"
        className="rounded-2xl border-2 border-[var(--color-exito)] bg-[var(--color-exito)]/5 p-6"
      >
        <h2 className="titular text-2xl">Producto creado</h2>
        <p className="mt-2 text-sm">
          Se guardó como <code className="cifra">{ok.slug}</code> con {ok.fotos}{" "}
          {ok.fotos === 1 ? "foto" : "fotos"}. Está <strong>oculto</strong>: revisa que las fotos y
          las tallas estén bien y publícalo desde la lista de productos.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Link
            href="/admin/productos"
            className="rounded-full bg-[var(--color-tinta)] px-5 py-2.5 text-sm font-semibold text-[var(--color-papel)]"
          >
            Ir a la lista y publicarlo
          </Link>
          <button
            type="button"
            onClick={() => {
              setOk(null);
              setPrecio("");
              setCosto("");
              setFotos([]);
              setTallas(
                TALLAS_DISPONIBLES.map((sizeUs) => ({ sizeUs, stock: "1", marcada: false })),
              );
            }}
            className="rounded-full border border-[var(--color-borde)] px-5 py-2.5 text-sm font-semibold"
          >
            Cargar otro producto
          </button>
        </div>
      </section>
    );
  }

  return (
    <form onSubmit={alEnviar} className="space-y-8">
      <fieldset>
        <legend className="titular text-2xl">Qué es</legend>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="brandSlug" className="block text-sm font-semibold">
              Marca <Obligatorio />
            </label>
            <select
              id="brandSlug"
              name="brandSlug"
              required
              defaultValue=""
              className="mt-1 w-full rounded-lg border border-[var(--color-borde)] bg-[var(--color-papel)] px-3 py-2.5 text-sm"
            >
              <option value="" disabled>
                Elige una marca
              </option>
              {marcas.map((marca) => (
                <option key={marca.slug} value={marca.slug}>
                  {marca.nombre}
                  {marca.activo ? "" : " (oculta en la tienda)"}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="condicion" className="block text-sm font-semibold">
              Condición
            </label>
            <select
              id="condicion"
              name="condicion"
              defaultValue="nuevo_en_caja"
              className="mt-1 w-full rounded-lg border border-[var(--color-borde)] bg-[var(--color-papel)] px-3 py-2.5 text-sm"
            >
              {CONDICIONES.map((c) => (
                <option key={c} value={c}>
                  {ETIQUETA_CONDICION[c]}
                </option>
              ))}
            </select>
          </div>
          <Campo id="modelo" etiqueta="Modelo" requerido placeholder="Chuck 70 High" />
          <Campo id="colorway" etiqueta="Color" requerido placeholder="Negro / blanco" />
          <Campo id="silueta" etiqueta="Silueta (opcional)" placeholder="High top" />
          <Campo
            id="notaCalce"
            etiqueta="Nota de calce (opcional)"
            placeholder="Calza medio número grande"
            ayuda="Solo tú puedes decirlo: tienes el par en la mano. No se inventa."
          />
        </div>

        <div className="mt-4">
          <label htmlFor="descripcion" className="block text-sm font-semibold">
            Descripción (opcional)
          </label>
          <textarea
            id="descripcion"
            name="descripcion"
            rows={3}
            maxLength={1000}
            className="mt-1 w-full rounded-lg border border-[var(--color-borde)] px-3 py-2 text-sm"
            placeholder="Lo que le dirías a un cliente que pregunta por WhatsApp."
          />
        </div>
      </fieldset>

      <fieldset>
        <legend className="titular text-2xl">Cuánto cuesta</legend>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <Campo
            id="costo"
            etiqueta="Tu costo"
            requerido
            placeholder="149.90"
            valor={costo}
            onChange={setCosto}
            ayuda="Lo que pagaste por el par."
          />
          <Campo
            id="precio"
            etiqueta="Precio de venta"
            requerido
            placeholder="249.90"
            valor={precio}
            onChange={setPrecio}
          />
          <Campo
            id="precioTachado"
            etiqueta="Precio tachado (opcional)"
            placeholder="299.90"
            ayuda="Debe ser mayor que el de venta."
          />
        </div>

        <p
          aria-live="polite"
          className={`mt-3 rounded-lg px-4 py-2.5 text-sm ${
            margen === null
              ? "bg-[var(--color-humo)] text-[var(--color-gris)]"
              : margen.gananciaCents <= 0
                ? "bg-[var(--color-alerta)]/10 font-semibold text-[var(--color-alerta)]"
                : "bg-[var(--color-humo)]"
          }`}
        >
          {margen === null
            ? "Escribe costo y precio para ver tu margen."
            : margen.gananciaCents <= 0
              ? "Con esos números no ganas nada: el precio debe ser mayor que el costo."
              : `Ganas S/ ${(margen.gananciaCents / 100).toFixed(2)} por par (${margen.porcentaje.toFixed(0)}% del precio).`}
        </p>

        <label className="mt-4 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="destacado"
            value="true"
            className="h-4 w-4 accent-[var(--color-tinta)]"
          />
          Mostrarlo en la portada
        </label>
      </fieldset>

      <fieldset>
        <legend className="titular text-2xl">Tallas y stock</legend>
        <p className="mt-1 text-sm text-[var(--color-gris)]">
          Marca las tallas que tienes y pon cuántos pares de cada una. El SKU se genera solo; se
          puede corregir después.
        </p>

        <div className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-6">
          {tallas.map((talla) => (
            <div
              key={talla.sizeUs}
              className={`rounded-lg border p-2 ${
                talla.marcada
                  ? "border-[var(--color-tinta)] bg-[var(--color-humo)]"
                  : "border-[var(--color-borde)]"
              }`}
            >
              <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold">
                <input
                  type="checkbox"
                  checked={talla.marcada}
                  onChange={() => alternarTalla(talla.sizeUs)}
                  className="h-4 w-4 accent-[var(--color-tinta)]"
                />
                <span className="cifra">US {formatearTalla(talla.sizeUs)}</span>
              </label>
              {talla.marcada && (
                <>
                  <label
                    htmlFor={`stock-${talla.sizeUs}`}
                    className="mt-1.5 block text-[10px] uppercase tracking-wide text-[var(--color-gris)]"
                  >
                    Pares
                  </label>
                  <input
                    id={`stock-${talla.sizeUs}`}
                    type="number"
                    min={0}
                    max={999}
                    value={talla.stock}
                    onChange={(e) => cambiarStock(talla.sizeUs, e.target.value)}
                    className="cifra mt-0.5 w-full rounded border border-[var(--color-borde)] px-2 py-1 text-center text-sm"
                  />
                </>
              )}
            </div>
          ))}
        </div>

        <p aria-live="polite" className="mt-3 text-sm text-[var(--color-gris)]">
          {marcadas.length === 0
            ? "Ninguna talla marcada todavía."
            : `${marcadas.length} ${marcadas.length === 1 ? "talla" : "tallas"} · ${paresTotales} ${paresTotales === 1 ? "par" : "pares"} en total.`}
        </p>
      </fieldset>

      <fieldset>
        <legend className="titular text-2xl">Fotos</legend>
        <p className="mt-1 text-sm text-[var(--color-gris)]">
          La primera es la que se ve en el catálogo. Máximo {MAX_FOTOS}, hasta 8 MB cada una.
        </p>
        <input
          id="fotos"
          name="fotos"
          type="file"
          multiple
          accept="image/jpeg,image/png,image/webp,image/avif"
          onChange={alElegirFotos}
          className="mt-3 w-full rounded-lg border border-[var(--color-borde)] px-3 py-2.5 text-sm file:mr-3 file:rounded-full file:border-0 file:bg-[var(--color-tinta)] file:px-4 file:py-1.5 file:text-sm file:font-semibold file:text-[var(--color-papel)]"
        />

        {fotos.length > 0 && (
          <ul className="mt-4 flex flex-wrap gap-3">
            {fotos.map((foto, indice) => (
              <li key={`${foto.name}-${indice}`} className="w-28">
                {/* Blob local del navegador: `next/image` no aplica, no hay nada
                    que optimizar en el servidor. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={previas[indice]}
                  alt={`Vista previa ${indice + 1}: ${foto.name}`}
                  className="h-28 w-28 rounded-lg border border-[var(--color-borde)] object-cover"
                />
                <p className="mt-1 text-center text-[10px] text-[var(--color-gris)]">
                  {indice === 0 ? "Principal" : `Foto ${indice + 1}`}
                </p>
              </li>
            ))}
          </ul>
        )}
      </fieldset>

      {error !== null && (
        <p
          role="alert"
          className="rounded-lg border border-[var(--color-alerta)] bg-[var(--color-alerta)]/5 px-4 py-3 text-sm font-medium text-[var(--color-alerta)]"
        >
          {error}
        </p>
      )}

      <div className="rounded-xl bg-[var(--color-humo)] p-4 text-sm text-[var(--color-gris)]">
        Se guarda <strong>oculto</strong> de la tienda. Lo revisas en la lista y lo publicas cuando
        las fotos y las tallas estén como quieres.
      </div>

      <button
        type="submit"
        disabled={enviando}
        className="w-full rounded-full bg-[var(--color-acento)] px-6 py-4 font-bold text-[var(--color-tinta)] transition hover:bg-[var(--color-acento-oscuro)] disabled:opacity-50"
      >
        {enviando ? "Guardando producto..." : "Guardar producto"}
      </button>
    </form>
  );
}

/**
 * Margen para mostrar mientras se escribe.
 *
 * Acepta coma decimal igual que el esquema del servidor: en Perú se escribe
 * `249,90` tanto como `249.90`, y una previsualización que se apaga por una coma
 * parece un fallo.
 */
function calcularMargen(
  precio: string,
  costo: string,
): { gananciaCents: number; porcentaje: number } | null {
  const aCents = (valor: string): number | null => {
    const limpio = valor.trim().replace(",", ".");
    if (!/^\d{1,5}(\.\d{1,2})?$/.test(limpio)) return null;
    return Math.round(Number(Number(limpio).toFixed(2)) * 100);
  };

  const precioCents = aCents(precio);
  const costoCents = aCents(costo);
  if (precioCents === null || costoCents === null || precioCents === 0) return null;

  const gananciaCents = precioCents - costoCents;
  return { gananciaCents, porcentaje: (gananciaCents / precioCents) * 100 };
}

/** Alt por defecto a partir del nombre del archivo. El servidor compone uno mejor si queda vacío. */
function nombreLegible(nombre: string): string {
  return nombre.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim();
}

function Obligatorio() {
  return (
    <>
      <span aria-hidden="true" className="text-[var(--color-alerta)]">
        {" "}
        *
      </span>
      <span className="solo-lectores"> (obligatorio)</span>
    </>
  );
}

function Campo({
  id,
  etiqueta,
  requerido = false,
  placeholder,
  ayuda,
  valor,
  onChange,
}: {
  id: string;
  etiqueta: string;
  requerido?: boolean;
  placeholder?: string;
  ayuda?: string;
  valor?: string;
  onChange?: (v: string) => void;
}) {
  const idAyuda = `${id}-ayuda`;
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-semibold">
        {etiqueta}
        {requerido && <Obligatorio />}
      </label>
      <input
        id={id}
        name={id}
        type="text"
        required={requerido}
        placeholder={placeholder}
        autoComplete="off"
        aria-describedby={ayuda === undefined ? undefined : idAyuda}
        {...(valor !== undefined ? { value: valor } : {})}
        {...(onChange !== undefined ? { onChange: (e) => onChange(e.target.value) } : {})}
        className="mt-1 w-full rounded-lg border border-[var(--color-borde)] px-3 py-2.5 text-sm"
      />
      {ayuda !== undefined && (
        <p id={idAyuda} className="mt-1 text-xs text-[var(--color-gris)]">
          {ayuda}
        </p>
      )}
    </div>
  );
}

function formatearTalla(valor: number): string {
  return Number.isInteger(valor) ? String(valor) : valor.toFixed(1);
}
