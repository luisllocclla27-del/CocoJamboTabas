"use client";
import Image from "next/image";
import { useState } from "react";

export function GaleriaInteractiva({
  imagenes,
  nombre,
}: {
  imagenes: Array<{ id: string; url: string; alt: string }>;
  nombre: string;
}) {
  const [activa, setActiva] = useState(0);

  if (imagenes.length === 0) {
    return (
      <div className="flex aspect-square items-center justify-center rounded-xl bg-[var(--color-humo)] text-[var(--color-gris)]">
        Sin fotos de {nombre}
      </div>
    );
  }

  const principal = imagenes[activa]!;

  return (
    <div>
      <div className="relative aspect-square overflow-hidden rounded-xl bg-[var(--color-humo)]">
        <Image
          src={principal.url}
          alt={principal.alt}
          fill
          priority
          sizes="(max-width: 1024px) 100vw, 50vw"
          className="object-cover transition-opacity duration-200"
        />
      </div>
      {imagenes.length > 1 && (
        <ul className="mt-3 grid grid-cols-4 gap-3" aria-label="Miniaturas">
          {imagenes.map((imagen, i) => (
            <li key={imagen.id}>
              <button
                onClick={() => setActiva(i)}
                aria-label={`Ver foto ${i + 1}: ${imagen.alt}`}
                aria-pressed={i === activa}
                className={`relative block aspect-square w-full overflow-hidden rounded-lg bg-[var(--color-humo)] transition ${
                  i === activa
                    ? "ring-2 ring-[var(--color-tinta)] ring-offset-1"
                    : "opacity-60 hover:opacity-100"
                }`}
              >
                <Image
                  src={imagen.url}
                  alt={imagen.alt}
                  fill
                  sizes="25vw"
                  className="object-cover"
                />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
