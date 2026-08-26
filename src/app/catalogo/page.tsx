import type { Metadata } from "next";
import Link from "next/link";
import { isSupabaseConfigured } from "@/lib/env";
import {
  listarCatalogo,
  listarMarcas,
  listarTallasDelCatalogo,
  type FiltrosCatalogo,
} from "@/lib/supabase/catalog";
import { TarjetaProductoCard } from "@/components/tarjeta-producto";

export const revalidate = 60;

export const metadata: Metadata = {
  title: "Catálogo",
  description:
    "Todas las zapatillas disponibles: Converse, Vans, New Balance y Adidas, con stock real por talla.",
};

/**
 * Catálogo con filtros.
 *
 * Los filtros viven en la URL (`?marca=vans&talla=9`) y no en estado de React.
 * Tres razones concretas: el cliente puede compartir por WhatsApp un enlace con
 * su talla ya filtrada, el botón de atrás del navegador funciona como espera, y
 * el filtrado ocurre en el servidor, donde está el dato de disponibilidad real.
 */
export default async function CatalogoPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!isSupabaseConfigured()) {
    return (
      <section className="mx-auto max-w-2xl px-4 py-20">
        <h1 className="titular text-3xl">Falta conectar Supabase</h1>
        <p className="mt-3 text-[var(--color-gris)]">
          Configura las variables de entorno para ver el catálogo.
        </p>
      </section>
    );
  }

  const params = await searchParams;
  const filtros = leerFiltros(params);

  const [productos, marcas, tallas] = await Promise.all([
    listarCatalogo(filtros),
    listarMarcas(),
    listarTallasDelCatalogo(),
  ]);

  return (
    <div className="mx-auto max-w-6xl px-4 py-10">
      <header>
        <h1 className="titular text-4xl sm:text-5xl">Catálogo</h1>
        <p className="mt-2 text-[var(--color-gris)]">
          {productos.length === 1
            ? "1 modelo disponible"
            : `${productos.length} modelos disponibles`}
          {filtros.talla !== undefined && ` en talla US ${formatearTalla(filtros.talla)}`}
        </p>
      </header>

      <Filtros filtros={filtros} marcas={marcas} tallas={tallas} />

      {productos.length === 0 ? (
        <SinResultados filtros={filtros} />
      ) : (
        <div className="mt-10 grid grid-cols-2 gap-x-4 gap-y-10 lg:grid-cols-4">
          {productos.map((producto) => (
            <TarjetaProductoCard key={producto.id} producto={producto} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Lee y sanea los filtros de la URL.
 *
 * Todo lo que viene de la query string es texto arbitrario que un visitante
 * controla. La talla se valida como número y el orden se acota a los valores
 * conocidos: sin eso, `?orden=drop table` llegaría a la capa de consulta.
 */
function leerFiltros(params: Record<string, string | string[] | undefined>): FiltrosCatalogo {
  const uno = (clave: string): string | undefined => {
    const valor = params[clave];
    return Array.isArray(valor) ? valor[0] : valor;
  };

  const tallaTexto = uno("talla");
  const talla = tallaTexto === undefined ? Number.NaN : Number(tallaTexto);
  const orden = uno("orden");

  return {
    ...(uno("marca") !== undefined ? { marca: uno("marca") } : {}),
    ...(Number.isFinite(talla) ? { talla } : {}),
    ...(uno("q") !== undefined ? { busqueda: uno("q") } : {}),
    orden:
      orden === "precio_asc" || orden === "precio_desc" || orden === "novedad" ? orden : "novedad",
  };
}

function Filtros({
  filtros,
  marcas,
  tallas,
}: {
  filtros: FiltrosCatalogo;
  marcas: Array<{ slug: string; nombre: string }>;
  tallas: number[];
}) {
  /** Construye una URL conservando los demás filtros activos. */
  const url = (cambios: Record<string, string | undefined>): string => {
    const base: Record<string, string | undefined> = {
      marca: filtros.marca,
      talla: filtros.talla === undefined ? undefined : String(filtros.talla),
      q: filtros.busqueda,
      orden: filtros.orden === "novedad" ? undefined : filtros.orden,
      ...cambios,
    };
    const query = new URLSearchParams();
    for (const [clave, valor] of Object.entries(base)) {
      if (valor !== undefined && valor !== "") query.set(clave, valor);
    }
    const qs = query.toString();
    return qs === "" ? "/catalogo" : `/catalogo?${qs}`;
  };

  const hayFiltros =
    filtros.marca !== undefined || filtros.talla !== undefined || filtros.busqueda !== undefined;

  return (
    <div className="mt-8 space-y-5 border-y border-[var(--color-borde)] py-5">
      {/* La búsqueda es un formulario GET: funciona sin JavaScript y deja el
          término en la URL, así que se puede compartir y recargar. */}
      <form action="/catalogo" method="get" role="search" className="flex gap-2">
        <label htmlFor="q" className="solo-lectores">
          Buscar por modelo o color
        </label>
        <input
          id="q"
          name="q"
          type="search"
          defaultValue={filtros.busqueda ?? ""}
          placeholder="Buscar: zapatillas, polera, casaca, Chuck 70, vintage..."
          className="w-full rounded-full border border-[var(--color-borde)] px-4 py-2 text-sm"
        />
        {/* Los filtros activos se conservan al buscar. */}
        {filtros.marca !== undefined && <input type="hidden" name="marca" value={filtros.marca} />}
        {filtros.talla !== undefined && (
          <input type="hidden" name="talla" value={String(filtros.talla)} />
        )}
        <button
          type="submit"
          className="shrink-0 rounded-full bg-[var(--color-tinta)] px-5 py-2 text-sm font-semibold text-[var(--color-papel)]"
        >
          Buscar
        </button>
      </form>

      <GrupoFiltro etiqueta="Marca">
        <Chip href={url({ marca: undefined })} activo={filtros.marca === undefined}>
          Todas
        </Chip>
        {marcas.map((marca) => (
          <Chip
            key={marca.slug}
            href={url({ marca: marca.slug })}
            activo={filtros.marca === marca.slug}
          >
            {marca.nombre}
          </Chip>
        ))}
      </GrupoFiltro>

      <GrupoFiltro etiqueta="Talla US">
        <Chip href={url({ talla: undefined })} activo={filtros.talla === undefined}>
          Todas
        </Chip>
        {tallas.map((talla) => (
          <Chip
            key={talla}
            href={url({ talla: String(talla) })}
            activo={filtros.talla === talla}
          >
            {formatearTalla(talla)}
          </Chip>
        ))}
      </GrupoFiltro>

      <GrupoFiltro etiqueta="Ordenar">
        <Chip href={url({ orden: undefined })} activo={filtros.orden === "novedad"}>
          Novedades
        </Chip>
        <Chip href={url({ orden: "precio_asc" })} activo={filtros.orden === "precio_asc"}>
          Menor precio
        </Chip>
        <Chip href={url({ orden: "precio_desc" })} activo={filtros.orden === "precio_desc"}>
          Mayor precio
        </Chip>
      </GrupoFiltro>

      {hayFiltros && (
        <Link href="/catalogo" className="inline-block text-sm underline underline-offset-4">
          Quitar todos los filtros
        </Link>
      )}
    </div>
  );
}

function GrupoFiltro({ etiqueta, children }: { etiqueta: string; children: React.ReactNode }) {
  return (
    <fieldset>
      {/* `legend` da al grupo un nombre accesible: el lector anuncia "Talla US" al
          entrar en la lista de opciones. */}
      <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-gris)]">
        {etiqueta}
      </legend>
      <div className="flex flex-wrap gap-2">{children}</div>
    </fieldset>
  );
}

function Chip({
  href,
  activo,
  children,
}: {
  href: string;
  activo: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      // `aria-current` comunica el filtro activo a los lectores de pantalla; el
      // color por sí solo no es información accesible.
      aria-current={activo ? "true" : undefined}
      className={`cifra rounded-full border px-3.5 py-1.5 text-sm transition ${
        activo
          ? "border-[var(--color-tinta)] bg-[var(--color-tinta)] font-semibold text-[var(--color-papel)]"
          : "border-[var(--color-borde)] hover:border-[var(--color-tinta)]"
      }`}
    >
      {children}
    </Link>
  );
}

function SinResultados({ filtros }: { filtros: FiltrosCatalogo }) {
  return (
    <div className="mt-16 text-center">
      <p className="titular text-2xl">Nada por acá</p>
      <p className="mx-auto mt-3 max-w-md text-[var(--color-gris)]">
        {filtros.talla !== undefined
          ? `No tenemos stock en talla US ${formatearTalla(filtros.talla)} con estos filtros. Prueba con otra talla o escríbenos: podemos avisarte cuando entre.`
          : "No encontramos productos con estos filtros."}
      </p>
      <Link
        href="/catalogo"
        className="mt-6 inline-block rounded-full bg-[var(--color-tinta)] px-6 py-3 font-semibold text-[var(--color-papel)]"
      >
        Ver todo el catálogo
      </Link>
    </div>
  );
}

function formatearTalla(valor: number): string {
  return Number.isInteger(valor) ? String(valor) : valor.toFixed(1);
}
