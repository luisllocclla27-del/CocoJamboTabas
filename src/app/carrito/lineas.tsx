"use client";

import Image from "next/image";
import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { formatSoles } from "@/lib/money";
import { cambiarCantidad, quitarDelCarrito } from "@/lib/cart/actions";
import type { LineaCarrito } from "@/lib/cart/resolve";

/**
 * Líneas del carrito.
 *
 * Es un componente de cliente porque necesita `useTransition` para deshabilitar
 * los controles mientras la Server Action está en vuelo. Sin eso, pulsar dos
 * veces el "+" dispara dos mutaciones concurrentes de la misma cookie y la
 * segunda pisa a la primera.
 */
export function LineasCarrito({ lineas }: { lineas: LineaCarrito[] }) {
  return (
    <ul className="divide-y divide-[var(--color-borde)]">
      {lineas.map((linea) => (
        <Linea key={linea.variantId} linea={linea} />
      ))}
    </ul>
  );
}

function Linea({ linea }: { linea: LineaCarrito }) {
  const router = useRouter();
  const [pendiente, iniciar] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function actualizar(cantidad: number) {
    setError(null);
    iniciar(async () => {
      const resultado = await cambiarCantidad(linea.variantId, cantidad);
      if (!resultado.ok) setError(resultado.error);
      // Refresca siempre: si el stock cambió, los datos en pantalla ya no son
      // válidos aunque la acción haya salido bien.
      router.refresh();
    });
  }

  function quitar() {
    setError(null);
    iniciar(async () => {
      await quitarDelCarrito(linea.variantId);
      router.refresh();
    });
  }

  return (
    <li className={`flex gap-4 py-5 ${pendiente ? "opacity-60" : ""}`}>
      <Link
        href={`/producto/${linea.productoSlug}`}
        className="relative h-24 w-24 shrink-0 overflow-hidden rounded-lg bg-[var(--color-humo)]"
      >
        {linea.imagen !== null && (
          <Image
            src={linea.imagen.url}
            alt={linea.imagen.alt}
            fill
            sizes="96px"
            className="object-cover"
          />
        )}
      </Link>

      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-gris)]">
          {linea.marca}
        </p>
        <Link href={`/producto/${linea.productoSlug}`} className="font-semibold hover:underline">
          {linea.modelo}
        </Link>
        <p className="text-sm text-[var(--color-gris)]">{linea.colorway}</p>
        <p className="cifra mt-1 text-sm">
          Talla US {formatearTalla(linea.sizeUs)} · {formatSoles(linea.unitPriceCents)} c/u
        </p>

        {linea.problema && (
          <p role="alert" className="mt-2 text-sm font-medium text-[var(--color-alerta)]">
            {linea.disponible === 0
              ? "Se agotó esta talla. Quítala para continuar."
              : `Solo quedan ${linea.disponible}. Ajusta la cantidad.`}
          </p>
        )}
        {error !== null && (
          <p role="alert" className="mt-2 text-sm font-medium text-[var(--color-alerta)]">
            {error}
          </p>
        )}

        <div className="mt-3 flex items-center gap-3">
          <div className="flex items-center rounded-full border border-[var(--color-borde)]">
            <button
              type="button"
              onClick={() => actualizar(linea.cantidad - 1)}
              disabled={pendiente}
              // El nombre accesible incluye el producto: con varias líneas, un
              // "Quitar uno" a secas no dice de cuál.
              aria-label={`Quitar un par de ${linea.modelo} talla ${formatearTalla(linea.sizeUs)}`}
              className="px-3 py-1.5 text-lg leading-none disabled:opacity-40"
            >
              −
            </button>
            <span className="cifra min-w-8 text-center text-sm font-semibold" aria-live="polite">
              {linea.cantidad}
            </span>
            <button
              type="button"
              onClick={() => actualizar(linea.cantidad + 1)}
              disabled={pendiente || linea.cantidad >= linea.disponible}
              aria-label={`Agregar un par de ${linea.modelo} talla ${formatearTalla(linea.sizeUs)}`}
              className="px-3 py-1.5 text-lg leading-none disabled:opacity-40"
            >
              +
            </button>
          </div>

          <button
            type="button"
            onClick={quitar}
            disabled={pendiente}
            className="text-sm text-[var(--color-gris)] underline underline-offset-4 hover:text-[var(--color-alerta)] disabled:opacity-40"
          >
            Quitar
          </button>
        </div>
      </div>

      <p className="cifra shrink-0 font-bold">{formatSoles(linea.subtotalCents)}</p>
    </li>
  );
}

function formatearTalla(valor: number): string {
  return Number.isInteger(valor) ? String(valor) : valor.toFixed(1);
}
