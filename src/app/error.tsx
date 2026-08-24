"use client";

import Link from "next/link";
import { useEffect } from "react";

/**
 * Pantalla de error.
 *
 * Lo que NO hace: mostrar `error.message`. Un error de la capa de datos puede
 * contener nombres de tablas, fragmentos de consulta o detalles de configuración, y
 * eso no debe llegar a un visitante. Se muestra el `digest`, que es el
 * identificador que Next asigna al error y permite localizarlo en los logs del
 * servidor sin filtrar nada.
 *
 * `reset()` reintenta el render. Sirve de verdad en este proyecto: buena parte de
 * los fallos posibles son transitorios (la base de datos no respondió a tiempo), y
 * un reintento los resuelve sin que el cliente pierda lo que estaba haciendo.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // En producción esto iría a un servicio de observabilidad. En desarrollo, la
    // consola del servidor ya tiene el error completo con su traza.
    console.error("Error en la aplicación:", error);
  }, [error]);

  return (
    <div className="mx-auto max-w-lg px-4 py-24 text-center">
      <h1 className="titular text-3xl">Algo se rompió de nuestro lado</h1>
      <p className="mt-3 text-[var(--color-gris)]">
        No es culpa tuya. Puede ser algo pasajero: prueba a reintentar.
      </p>

      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <button
          type="button"
          onClick={reset}
          className="rounded-full bg-[var(--color-acento)] px-6 py-3 font-bold text-[var(--color-tinta)]"
        >
          Reintentar
        </button>
        <Link
          href="/"
          className="rounded-full border border-[var(--color-borde)] px-6 py-3 font-semibold"
        >
          Ir al inicio
        </Link>
      </div>

      <p className="mt-8 text-sm text-[var(--color-gris)]">
        Si estabas pagando un pedido, no lo intentes de nuevo desde cero: escríbenos por WhatsApp y
        lo revisamos. Tu pedido puede haberse creado igual.
      </p>

      {error.digest !== undefined && (
        <p className="cifra mt-4 text-xs text-[var(--color-gris)]">
          Código del error: {error.digest}
        </p>
      )}
    </div>
  );
}
