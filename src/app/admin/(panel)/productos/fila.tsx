"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { formatSoles } from "@/lib/money";
import type { ProductoAdmin } from "@/lib/admin/queries";
import { ajustarStock, cambiarVisibilidad } from "@/lib/admin/inventory";
import { BotonCompartirRedes } from "./boton-compartir";

/**
 * Fila de producto con edición de stock por talla.
 *
 * El stock se guarda al perder el foco o al pulsar Enter, sin botón de guardar por
 * fila. Al reponer mercadería se tocan diez tallas seguidas, y un botón por cada
 * una convierte una tarea de un minuto en diez clics de más.
 *
 * Cada campo muestra su propio estado (guardando, guardado, error) para que un
 * fallo en una talla no deje duda sobre las demás.
 */
export function FilaProducto({
  producto,
  margenTexto,
}: {
  producto: ProductoAdmin;
  margenTexto: string;
}) {
  const router = useRouter();
  const [cambiando, setCambiando] = useState(false);

  async function alternarVisibilidad() {
    setCambiando(true);
    await cambiarVisibilidad({ productId: producto.id, activo: !producto.activo });
    setCambiando(false);
    router.refresh();
  }

  const totalPares = producto.variantes.reduce((s, v) => s + v.stock, 0);

  return (
    <article
      className={`rounded-xl border p-4 ${
        producto.activo ? "border-[var(--color-borde)]" : "border-dashed border-[var(--color-borde)] opacity-60"
      }`}
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-gris)]">
            {producto.marca}
          </p>
          <h2 className="font-bold">
            <Link href={`/producto/${producto.slug}`} className="hover:underline">
              {producto.modelo}
            </Link>
          </h2>
          <p className="text-sm text-[var(--color-gris)]">{producto.colorway}</p>
        </div>
        <div className="text-right text-sm">
          <p className="cifra font-bold">{formatSoles(producto.priceCents)}</p>
          <p className="cifra text-xs text-[var(--color-gris)]">
            costo {formatSoles(producto.costCents)}
          </p>
          <p className="cifra text-xs text-[var(--color-exito)]">margen {margenTexto}</p>
        </div>
      </header>

      <div className="mt-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-gris)]">
          Stock por talla US · {totalPares} {totalPares === 1 ? "par" : "pares"} en total
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {producto.variantes.map((variante) => (
            <CampoStock key={variante.id} variante={variante} />
          ))}
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--color-borde)] pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`/admin/productos/${producto.id}/editar`}
            className="inline-flex items-center gap-1 rounded-full bg-[var(--color-tinta)] px-4 py-1.5 text-xs font-bold text-[var(--color-papel)] hover:bg-[var(--color-tinta-suave)]"
          >
            ✏️ Editar datos y fotos
          </Link>
          <button
            type="button"
            onClick={alternarVisibilidad}
            disabled={cambiando}
            className="rounded-full border border-[var(--color-borde)] px-3 py-1.5 text-xs font-semibold hover:border-[var(--color-tinta)] disabled:opacity-50"
          >
            {producto.activo ? "Ocultar de tienda" : "Mostrar en tienda"}
          </button>
          {!producto.activo && (
            <span className="text-xs font-medium text-[var(--color-aviso)] bg-[var(--color-aviso)]/10 px-2 py-0.5 rounded">
              Oculto
            </span>
          )}
          {producto.destacado && (
            <span className="text-xs font-bold text-[var(--color-tinta)] bg-[var(--color-acento)] px-2 py-0.5 rounded">
              ★ Portada
            </span>
          )}
        </div>

        <BotonCompartirRedes
          producto={{
            marca: producto.marca,
            modelo: producto.modelo,
            colorway: producto.colorway,
            priceCents: producto.priceCents,
            tallas: producto.variantes.map((v) => ({ sizeUs: v.sizeUs, stock: v.stock })),
            slug: producto.slug,
          }}
        />
      </div>
    </article>
  );
}

type Estado = "quieto" | "guardando" | "guardado" | "error";

function CampoStock({
  variante,
}: {
  variante: { id: string; sizeUs: number; stock: number; sku: string };
}) {
  const router = useRouter();
  const [valor, setValor] = useState(String(variante.stock));
  const [estado, setEstado] = useState<Estado>("quieto");

  async function guardar() {
    const numero = Number(valor);
    // Sin cambios reales no se llama al servidor: al recorrer diez tallas con el
    // tabulador se dispararían diez escrituras inútiles.
    if (!Number.isFinite(numero) || numero === variante.stock) {
      setValor(String(variante.stock));
      setEstado("quieto");
      return;
    }
    setEstado("guardando");
    const resultado = await ajustarStock({ variantId: variante.id, stock: numero });
    if (!resultado.ok) {
      setEstado("error");
      setValor(String(variante.stock));
      return;
    }
    setEstado("guardado");
    router.refresh();
  }

  const idCampo = `stock-${variante.id}`;

  return (
    <div className="w-20">
      <label htmlFor={idCampo} className="cifra block text-center text-xs font-semibold">
        {formatearTalla(variante.sizeUs)}
      </label>
      <input
        id={idCampo}
        type="number"
        min={0}
        max={999}
        value={valor}
        onChange={(e) => {
          setValor(e.target.value);
          setEstado("quieto");
        }}
        onBlur={guardar}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
        // El SKU en el título ayuda a casar la talla con la etiqueta de la caja.
        title={variante.sku}
        aria-describedby={`${idCampo}-estado`}
        className={`cifra mt-1 w-full rounded-lg border px-2 py-1.5 text-center text-sm ${
          estado === "error"
            ? "border-[var(--color-alerta)]"
            : estado === "guardado"
              ? "border-[var(--color-exito)]"
              : variante.stock === 0
                ? "border-[var(--color-borde)] text-[var(--color-gris)]"
                : "border-[var(--color-borde)]"
        }`}
      />
      <p
        id={`${idCampo}-estado`}
        aria-live="polite"
        className="mt-0.5 text-center text-[10px] text-[var(--color-gris)]"
      >
        {estado === "guardando"
          ? "..."
          : estado === "guardado"
            ? "guardado"
            : estado === "error"
              ? "error"
              : "\u00a0"}
      </p>
    </div>
  );
}

function formatearTalla(valor: number): string {
  return Number.isInteger(valor) ? String(valor) : valor.toFixed(1);
}
