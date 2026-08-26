"use client";

import Link from "next/link";
import { useState } from "react";

export function Encabezado() {
  const [menuAbierto, setMenuAbierto] = useState(false);

  const cerrarMenu = () => setMenuAbierto(false);

  return (
    <header className="sticky top-0 z-40 border-b border-[var(--color-borde)] bg-[var(--color-papel)]/95 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4">
        <Link href="/" onClick={cerrarMenu} className="titular text-2xl tracking-tight">
          COCO<span className="text-[var(--color-acento-oscuro)]">JAMBO</span>
        </Link>

        {/* Navegación Desktop */}
        <nav aria-label="Navegación principal" className="hidden gap-6 text-sm font-medium sm:flex">
          <Link href="/catalogo" className="hover:text-[var(--color-gris)] transition-colors">
            Catálogo
          </Link>
          <Link href="/catalogo?q=zapatillas" className="hover:text-[var(--color-gris)] transition-colors">
            Zapatillas
          </Link>
          <Link href="/catalogo?q=ropa" className="hover:text-[var(--color-gris)] transition-colors">
            Ropa
          </Link>
          <Link href="/seguimiento" className="hover:text-[var(--color-gris)] transition-colors">
            Seguir pedido
          </Link>
        </nav>

        <div className="flex items-center gap-2.5">
          <Link
            href="/carrito"
            onClick={cerrarMenu}
            className="rounded-full bg-[var(--color-tinta)] px-4 py-2 text-sm font-semibold text-[var(--color-papel)] transition hover:bg-[var(--color-tinta-suave)]"
          >
            Carrito
          </Link>

          {/* Botón menú mobile */}
          <button
            type="button"
            onClick={() => setMenuAbierto(!menuAbierto)}
            aria-expanded={menuAbierto}
            aria-label={menuAbierto ? "Cerrar menú" : "Abrir menú de navegación"}
            className="flex h-10 w-10 items-center justify-center rounded-lg border border-[var(--color-borde)] sm:hidden hover:bg-[var(--color-humo)] cursor-pointer"
          >
            {menuAbierto ? (
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            ) : (
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {/* Menú Mobile desplegable */}
      {menuAbierto && (
        <div className="border-b border-[var(--color-borde)] bg-[var(--color-papel)] px-4 py-6 sm:hidden animate-in fade-in slide-in-from-top-2 duration-150">
          <nav className="flex flex-col gap-4 text-base font-semibold">
            <Link
              href="/catalogo"
              onClick={cerrarMenu}
              className="flex items-center justify-between py-1 hover:text-[var(--color-acento-oscuro)]"
            >
              <span>Ver todo el catálogo</span>
              <span>→</span>
            </Link>
            <Link
              href="/catalogo?q=zapatillas"
              onClick={cerrarMenu}
              className="flex items-center justify-between py-1 hover:text-[var(--color-acento-oscuro)]"
            >
              <span>👟 Zapatillas</span>
              <span>→</span>
            </Link>
            <Link
              href="/catalogo?q=ropa"
              onClick={cerrarMenu}
              className="flex items-center justify-between py-1 hover:text-[var(--color-acento-oscuro)]"
            >
              <span>👕 Ropa second hand</span>
              <span>→</span>
            </Link>
            <Link
              href="/seguimiento"
              onClick={cerrarMenu}
              className="flex items-center justify-between py-1 hover:text-[var(--color-acento-oscuro)]"
            >
              <span>📦 Seguir mi pedido</span>
              <span>→</span>
            </Link>
            <Link
              href="/guia-de-tallas"
              onClick={cerrarMenu}
              className="flex items-center justify-between py-1 text-sm text-[var(--color-gris)]"
            >
              <span>Guía de tallas</span>
            </Link>

            <div className="pt-4 border-t border-[var(--color-borde)] flex flex-col gap-2">
              <a
                href="https://wa.me/51935502420?text=Hola%20Coco%20Jambo%2C%20quiero%20consultar%20sobre%20un%20producto"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 rounded-full bg-[#25D366] py-2.5 font-bold text-white text-sm"
              >
                <span>WhatsApp directo (935 502 420)</span>
              </a>
              <a
                href="https://chat.whatsapp.com/ESkzHNItHLzIHzl07psBWj"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 rounded-full border border-[var(--color-tinta)] py-2 font-bold text-[var(--color-tinta)] text-xs"
              >
                <span>Unirme al grupo de WhatsApp</span>
              </a>
            </div>
          </nav>
        </div>
      )}
    </header>
  );
}
