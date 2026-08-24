"use client";

import { useState } from "react";
import { iniciarSesion } from "@/lib/admin/auth";

export function FormularioLogin({ volver }: { volver: string }) {
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function alEnviar(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setEnviando(true);
    setError(null);
    const datos = new FormData(event.currentTarget);
    datos.set("volver", volver);
    // En caso de éxito la Server Action redirige y esta promesa no resuelve, así
    // que solo se llega a la línea siguiente cuando hubo error.
    const resultado = await iniciarSesion(datos);
    setEnviando(false);
    if (resultado !== undefined) setError(resultado.error);
  }

  return (
    <form onSubmit={alEnviar} className="mt-8 space-y-4">
      <div>
        <label htmlFor="email" className="block text-sm font-semibold">
          Correo
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          className="mt-1 w-full rounded-lg border border-[var(--color-borde)] px-3 py-2.5 text-sm"
        />
      </div>

      <div>
        <label htmlFor="password" className="block text-sm font-semibold">
          Contraseña
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          autoComplete="current-password"
          className="mt-1 w-full rounded-lg border border-[var(--color-borde)] px-3 py-2.5 text-sm"
        />
      </div>

      {error !== null && (
        <p
          role="alert"
          className="rounded-lg border border-[var(--color-alerta)] bg-[var(--color-alerta)]/5 px-4 py-3 text-sm font-medium text-[var(--color-alerta)]"
        >
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={enviando}
        className="w-full rounded-full bg-[var(--color-tinta)] px-6 py-3 font-semibold text-[var(--color-papel)] disabled:opacity-50"
      >
        {enviando ? "Entrando..." : "Entrar"}
      </button>
    </form>
  );
}
