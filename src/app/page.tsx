import Link from "next/link";
import { isSupabaseConfigured } from "@/lib/env";
import { listarDestacados, listarMarcas } from "@/lib/supabase/catalog";
import { TarjetaProductoCard } from "@/components/tarjeta-producto";

/**
 * Home.
 *
 * Se renderiza en el servidor con revalidación periódica en vez de ser estática:
 * el stock por talla cambia con cada venta, y una home cacheada indefinidamente
 * anunciaría tallas que ya no existen. 60 segundos es el equilibrio entre eso y
 * no consultar la base en cada visita.
 */
export const revalidate = 60;

export default async function Home() {
  // Sin Supabase configurado la app no debe explotar: quien clona el repo tiene
  // que poder arrancar y ver algo antes de crear un proyecto.
  if (!isSupabaseConfigured()) return <SinConfigurar />;

  const [destacados, marcas] = await Promise.all([listarDestacados(4), listarMarcas()]);

  return (
    <>
      <Portada />
      <Garantias />

      <section className="mx-auto max-w-6xl px-4 py-12">
        <div className="flex items-end justify-between gap-4">
          <h2 className="titular text-3xl sm:text-4xl">Lo más pedido</h2>
          <Link
            href="/catalogo"
            className="shrink-0 text-sm font-semibold underline decoration-2 underline-offset-4 hover:text-[var(--color-gris)]"
          >
            Ver todo
          </Link>
        </div>

        {destacados.length === 0 ? (
          <p className="mt-6 text-[var(--color-gris)]">
            Todavía no hay productos cargados. Ejecuta <code>supabase/seed.sql</code> para ver el
            catálogo de ejemplo.
          </p>
        ) : (
          <div className="mt-8 grid grid-cols-2 gap-x-4 gap-y-8 lg:grid-cols-4">
            {destacados.map((producto) => (
              <TarjetaProductoCard key={producto.id} producto={producto} />
            ))}
          </div>
        )}
      </section>

      {marcas.length > 0 && <Marcas marcas={marcas} />}
      <ComoComprar />
    </>
  );
}

function Portada() {
  return (
    <section className="border-b border-[var(--color-borde)] bg-[var(--color-tinta)] text-[var(--color-papel)]">
      <div className="mx-auto max-w-6xl px-4 py-16 sm:py-24">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--color-acento)]">
          Originales garantizadas
        </p>
        <h1 className="titular mt-4 text-5xl sm:text-7xl lg:text-8xl">
          Zapatillas
          <br />
          urbanas
          <br />
          <span className="text-[var(--color-acento)]">de verdad</span>
        </h1>
        <p className="mt-6 max-w-xl text-lg text-white/80">
          Converse, Vans, New Balance y Adidas. Stock real por talla, pago con Yape y envíos a todo
          el Perú.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link
            href="/catalogo"
            className="rounded-full bg-[var(--color-acento)] px-6 py-3 font-bold text-[var(--color-tinta)] transition hover:bg-[var(--color-acento-oscuro)]"
          >
            Ver catálogo
          </Link>
          <Link
            href="/seguimiento"
            className="rounded-full border border-white/30 px-6 py-3 font-semibold transition hover:bg-white/10"
          >
            Seguir mi pedido
          </Link>
        </div>
      </div>
    </section>
  );
}

/**
 * Las tres objeciones que frenan una compra en Perú, respondidas arriba:
 * autenticidad, cobertura de envío y forma de pago.
 */
function Garantias() {
  const items = [
    { titulo: "100% originales", texto: "Fotos reales del par y su caja. Nada de réplicas." },
    { titulo: "Envíos a todo el Perú", texto: "Lima a domicilio y provincia por agencia Shalom." },
    { titulo: "Paga con Yape", texto: "Validamos tu comprobante y te confirmamos por WhatsApp." },
  ];
  return (
    <section aria-label="Garantías" className="border-b border-[var(--color-borde)]">
      <ul className="mx-auto grid max-w-6xl gap-6 px-4 py-8 sm:grid-cols-3">
        {items.map((item) => (
          <li key={item.titulo}>
            <h2 className="font-bold">{item.titulo}</h2>
            <p className="mt-1 text-sm text-[var(--color-gris)]">{item.texto}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Marcas({ marcas }: { marcas: Array<{ slug: string; nombre: string }> }) {
  return (
    <section className="border-y border-[var(--color-borde)] bg-[var(--color-humo)]">
      <div className="mx-auto max-w-6xl px-4 py-10">
        <h2 className="titular text-2xl">Por marca</h2>
        <ul className="mt-4 flex flex-wrap gap-3">
          {marcas.map((marca) => (
            <li key={marca.slug}>
              <Link
                href={`/catalogo?marca=${marca.slug}`}
                className="inline-block rounded-full border border-[var(--color-borde)] bg-[var(--color-papel)] px-5 py-2 font-semibold transition hover:border-[var(--color-tinta)]"
              >
                {marca.nombre}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function ComoComprar() {
  const pasos = [
    { n: 1, titulo: "Elige tu talla", texto: "Verás solo las tallas con stock disponible." },
    {
      n: 2,
      titulo: "Yapea el monto exacto",
      texto: "El monto incluye céntimos únicos que identifican tu pedido.",
    },
    {
      n: 3,
      titulo: "Sube tu comprobante",
      texto: "Validamos el pago y te avisamos por WhatsApp.",
    },
    { n: 4, titulo: "Recíbelo", texto: "A domicilio en Lima o en tu agencia si eres de provincia." },
  ];
  return (
    <section className="mx-auto max-w-6xl px-4 py-14">
      <h2 className="titular text-3xl">Cómo comprar</h2>
      <ol className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
        {pasos.map((paso) => (
          <li key={paso.n} className="border-t-2 border-[var(--color-tinta)] pt-4">
            <span className="cifra titular text-4xl text-[var(--color-acento-oscuro)]">
              {paso.n}
            </span>
            <h3 className="mt-2 font-bold">{paso.titulo}</h3>
            <p className="mt-1 text-sm text-[var(--color-gris)]">{paso.texto}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Pantalla de arranque cuando falta la configuración, con los pasos concretos. */
function SinConfigurar() {
  return (
    <section className="mx-auto max-w-2xl px-4 py-20">
      <h1 className="titular text-4xl">Falta conectar Supabase</h1>
      <p className="mt-4 text-[var(--color-gris)]">
        La tienda está lista, pero no encuentra las variables de entorno. Crea{" "}
        <code className="rounded bg-[var(--color-humo)] px-1">.env.local</code> a partir de{" "}
        <code className="rounded bg-[var(--color-humo)] px-1">.env.example</code> con:
      </p>
      <pre className="mt-4 overflow-x-auto rounded-lg bg-[var(--color-tinta)] p-4 text-sm text-[var(--color-papel)]">
        {`NEXT_PUBLIC_SUPABASE_URL=https://xxxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...`}
      </pre>
      <p className="mt-4 text-sm text-[var(--color-gris)]">
        Después aplica las migraciones de <code>supabase/migrations/</code> en orden y{" "}
        <code>supabase/seed.sql</code>.
      </p>
    </section>
  );
}
