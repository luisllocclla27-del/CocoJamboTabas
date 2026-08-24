import type { Metadata } from "next";
import Link from "next/link";
import { TABLA_TALLAS } from "@/lib/sizes";

export const metadata: Metadata = {
  title: "Guía de tallas",
  description:
    "Cómo medir tu pie en centímetros y equivalencias US, EU y CM para zapatillas urbanas.",
};

/**
 * Guía de tallas.
 *
 * Deliberadamente enseña a medir el pie en centímetros antes de mostrar la tabla.
 * El CM es el dato menos ambiguo de los tres: US y EU varían entre marcas y hasta
 * entre modelos de la misma marca, mientras que la longitud del pie es una medida
 * física que no depende de nadie.
 *
 * Aquí NO se afirma cómo calza cada modelo. Esa nota vive por producto en
 * `products.nota_calce` y la escribe el comerciante con el par en la mano. Un dato
 * de calce inventado genera devoluciones reales.
 */
export default function GuiaDeTallasPage() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="titular text-4xl">Guía de tallas</h1>
      <p className="mt-3 text-[var(--color-gris)]">
        La forma más segura de acertar es medir tu pie en centímetros. Las tallas US y EU cambian
        entre marcas; los centímetros, no.
      </p>

      <section className="mt-10">
        <h2 className="titular text-2xl">Cómo medir tu pie</h2>
        <ol className="mt-4 space-y-4">
          {[
            {
              titulo: "Pega una hoja a la pared",
              texto: "En el piso, con el borde corto contra la pared.",
            },
            {
              titulo: "Párate encima con el talón en la pared",
              texto:
                "De pie y con tu peso repartido: el pie se alarga al apoyarlo, y así se mide como cuando caminas.",
            },
            {
              titulo: "Marca la punta de tu dedo más largo",
              texto: "No siempre es el dedo gordo.",
            },
            {
              titulo: "Mide del borde de la hoja hasta la marca",
              texto: "En centímetros. Mide los dos pies y usa el más grande.",
            },
          ].map((paso, i) => (
            <li key={paso.titulo} className="flex gap-4">
              <span className="cifra titular shrink-0 text-3xl text-[var(--color-acento-oscuro)]">
                {i + 1}
              </span>
              <span>
                <span className="block font-bold">{paso.titulo}</span>
                <span className="block text-sm text-[var(--color-gris)]">{paso.texto}</span>
              </span>
            </li>
          ))}
        </ol>

        <p className="mt-6 rounded-lg bg-[var(--color-humo)] px-4 py-3 text-sm">
          <span className="font-semibold">Mídelo al final del día.</span> El pie se hincha unos
          milímetros con las horas, y una zapatilla que entra justo por la mañana aprieta por la
          tarde.
        </p>
      </section>

      <section className="mt-12">
        <h2 className="titular text-2xl">Equivalencias</h2>
        <p className="mt-2 text-sm text-[var(--color-gris)]">
          Si tu medida cae entre dos filas, elige la mayor: un par holgado se resuelve con medias
          más gruesas, uno que aprieta se devuelve.
        </p>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <caption className="solo-lectores">
              Equivalencias entre tallas US, EU y longitud del pie en centímetros
            </caption>
            <thead>
              <tr className="border-b-2 border-[var(--color-tinta)] text-left">
                {/* `scope="col"` permite al lector de pantalla anunciar la columna
                    al leer cada celda; sin ello, una tabla de números es ruido. */}
                <th scope="col" className="py-2 pr-4 font-bold">
                  US
                </th>
                <th scope="col" className="py-2 pr-4 font-bold">
                  EU
                </th>
                <th scope="col" className="py-2 font-bold">
                  Pie (cm)
                </th>
              </tr>
            </thead>
            <tbody>
              {TABLA_TALLAS.map((fila) => (
                <tr key={fila.us} className="border-b border-[var(--color-borde)]">
                  <th scope="row" className="cifra py-2 pr-4 text-left font-semibold">
                    {formatear(fila.us)}
                  </th>
                  <td className="cifra py-2 pr-4">{formatear(fila.eu)}</td>
                  <td className="cifra py-2">{formatear(fila.cm)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="mt-4 text-xs text-[var(--color-gris)]">
          Esta tabla es una referencia de uso común para calzado urbano unisex. No existe una
          conversión universal: cada marca escala a su manera. En cada producto publicamos la
          equivalencia exacta de sus tallas y, cuando la hay, una nota sobre cómo calza ese modelo
          en concreto.
        </p>
      </section>

      <section className="mt-12">
        <h2 className="titular text-2xl">¿Sigues con dudas?</h2>
        <p className="mt-2 text-[var(--color-gris)]">
          Escríbenos por WhatsApp con tu medida en centímetros y el modelo que quieres, y te
          decimos qué talla pedir. Preferimos resolverlo antes que gestionar un cambio.
        </p>
        <Link
          href="/catalogo"
          className="mt-6 inline-block rounded-full bg-[var(--color-tinta)] px-6 py-3 font-semibold text-[var(--color-papel)]"
        >
          Ver catálogo
        </Link>
      </section>
    </div>
  );
}

function formatear(valor: number): string {
  return Number.isInteger(valor) ? String(valor) : valor.toFixed(1);
}
