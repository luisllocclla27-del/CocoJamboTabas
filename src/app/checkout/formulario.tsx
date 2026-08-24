"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { formatSoles, type Cents } from "@/lib/money";
import { crearPedido } from "@/lib/orders/create";

/**
 * Formulario de checkout.
 *
 * El costo de envío se calcula en el cliente MIENTRAS el usuario escribe, para que
 * vea el total antes de confirmar. Pero el importe que se cobra lo recalcula el
 * servidor con la misma configuración: si difirieran, manda el servidor. Este
 * cálculo es para mostrar, no para cobrar.
 *
 * Los campos que el formulario pide cambian según la modalidad de entrega, y eso
 * está deliberado: pedir el DNI a quien recoge en tienda es fricción sin motivo,
 * pero es obligatorio para quien recibe por agencia, porque Shalom lo exige.
 */

type ZonaUI = {
  nombre: string;
  costoCents: Cents;
  plazo: string;
  distritos: string[];
};

export type ConfigEnvioUI = {
  zonasLima: ZonaUI[];
  limaFallbackCents: Cents;
  provinciaCents: Cents;
  umbralEnvioGratisCents: Cents | null;
  envioGratisAplicaProvincia: boolean;
};

type Modo = "lima_domicilio" | "provincia_agencia" | "recojo_tienda";

export function FormularioCheckout({
  subtotalCents,
  descuentoCents,
  config,
}: {
  subtotalCents: Cents;
  descuentoCents: Cents;
  config: ConfigEnvioUI;
}) {
  const router = useRouter();
  const [modo, setModo] = useState<Modo>("lima_domicilio");
  const [distrito, setDistrito] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const envio = useMemo(
    () => calcularEnvioUI({ modo, distrito, subtotalCents, config }),
    [modo, distrito, subtotalCents, config],
  );

  const totalCents = subtotalCents - descuentoCents + envio.costoCents;

  async function alEnviar(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setEnviando(true);
    setError(null);

    const datos = new FormData(event.currentTarget);
    const texto = (clave: string): string => String(datos.get(clave) ?? "").trim();

    const entrega =
      modo === "lima_domicilio"
        ? { modo, distrito: texto("distrito"), direccion: texto("direccion") }
        : modo === "provincia_agencia"
          ? {
              modo,
              departamento: texto("departamento"),
              provincia: texto("provincia"),
              agencia: texto("agencia"),
            }
          : { modo };

    const resultado = await crearPedido({
      cliente: {
        nombre: texto("nombre"),
        apellidos: texto("apellidos"),
        telefono: texto("telefono"),
        email: texto("email"),
        dni: texto("dni"),
      },
      entrega,
      metodoPago: "yape_manual",
      notas: texto("notas"),
    });

    setEnviando(false);

    if (!resultado.ok) {
      setError(resultado.error);
      // Los errores de stock exigen volver al carrito: quedarse aquí no permite
      // corregirlos.
      if (resultado.error.includes("carrito")) router.push("/carrito");
      return;
    }
    router.push(`/pago/${resultado.reference}`);
  }

  return (
    <form onSubmit={alEnviar} className="space-y-8">
      <fieldset>
        <legend className="titular text-2xl">Tus datos</legend>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Campo id="nombre" etiqueta="Nombre" autoComplete="given-name" requerido />
          <Campo id="apellidos" etiqueta="Apellidos" autoComplete="family-name" requerido />
          <Campo
            id="telefono"
            etiqueta="WhatsApp"
            tipo="tel"
            autoComplete="tel"
            requerido
            ayuda="Por acá te confirmamos el pago y el envío."
            placeholder="9XXXXXXXX"
          />
          <Campo
            id="email"
            etiqueta="Correo (opcional)"
            tipo="email"
            autoComplete="email"
          />
          <Campo
            id="dni"
            etiqueta={modo === "provincia_agencia" ? "DNI" : "DNI (opcional)"}
            autoComplete="off"
            requerido={modo === "provincia_agencia"}
            // Shalom exige el documento del destinatario para emitir la guía.
            ayuda={
              modo === "provincia_agencia"
                ? "La agencia lo pide para entregarte el paquete."
                : undefined
            }
            placeholder="12345678"
          />
        </div>
      </fieldset>

      <fieldset>
        <legend className="titular text-2xl">¿Cómo lo recibes?</legend>
        <div className="mt-4 space-y-3">
          <OpcionEntrega
            valor="lima_domicilio"
            actual={modo}
            onChange={setModo}
            titulo="A domicilio en Lima"
            detalle="Motorizado en 24 a 48 horas."
          />
          <OpcionEntrega
            valor="provincia_agencia"
            actual={modo}
            onChange={setModo}
            titulo="A provincia por agencia Shalom"
            detalle="Recoges en tu agencia con DNI y clave de retiro."
          />
          <OpcionEntrega
            valor="recojo_tienda"
            actual={modo}
            onChange={setModo}
            titulo="Recojo en tienda"
            detalle="Sin costo de envío. Coordinamos por WhatsApp."
          />
        </div>

        {modo === "lima_domicilio" && (
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <Campo
              id="distrito"
              etiqueta="Distrito"
              requerido
              autoComplete="address-level3"
              valor={distrito}
              onChange={setDistrito}
              lista={config.zonasLima.flatMap((z) => z.distritos)}
            />
            <Campo
              id="direccion"
              etiqueta="Dirección"
              requerido
              autoComplete="street-address"
              placeholder="Av. Ejemplo 123, dpto 401"
            />
          </div>
        )}

        {modo === "provincia_agencia" && (
          <div className="mt-5 grid gap-4 sm:grid-cols-3">
            <Campo id="departamento" etiqueta="Departamento" requerido />
            <Campo id="provincia" etiqueta="Provincia" requerido />
            <Campo
              id="agencia"
              etiqueta="Agencia Shalom"
              requerido
              ayuda="La agencia donde lo recogerás."
            />
          </div>
        )}
      </fieldset>

      <fieldset>
        <legend className="titular text-2xl">Cómo pagas</legend>
        {/* Solo Yape manual por ahora. Se muestra como opción única y explicada, en
            vez de ocultar que no hay alternativas. */}
        <div className="mt-4 rounded-xl border-2 border-[var(--color-tinta)] p-4">
          <p className="font-bold">Yape</p>
          <p className="mt-1 text-sm text-[var(--color-gris)]">
            En el siguiente paso te mostramos el número y el monto exacto. Subes tu captura y
            validamos el pago.
          </p>
          <p className="mt-2 text-sm font-semibold text-[var(--color-exito)]">
            Ya incluye tu descuento de {formatSoles(descuentoCents)}.
          </p>
        </div>
      </fieldset>

      <div>
        <label htmlFor="notas" className="block text-sm font-semibold">
          Alguna indicación (opcional)
        </label>
        <textarea
          id="notas"
          name="notas"
          rows={2}
          maxLength={300}
          className="mt-1 w-full rounded-lg border border-[var(--color-borde)] px-3 py-2 text-sm"
          placeholder="Referencias de la dirección, horario preferido..."
        />
      </div>

      <div className="rounded-xl bg-[var(--color-humo)] p-5">
        <dl className="space-y-2 text-sm">
          <div className="flex justify-between">
            <dt>Productos</dt>
            <dd className="cifra">{formatSoles(subtotalCents)}</dd>
          </div>
          <div className="flex justify-between text-[var(--color-exito)]">
            <dt>Descuento por Yape</dt>
            <dd className="cifra">−{formatSoles(descuentoCents)}</dd>
          </div>
          <div className="flex justify-between">
            <dt>
              Envío
              {envio.detalle !== null && (
                <span className="block text-xs text-[var(--color-gris)]">{envio.detalle}</span>
              )}
            </dt>
            <dd className="cifra">
              {envio.costoCents === 0 ? (
                <span className="font-semibold text-[var(--color-exito)]">Gratis</span>
              ) : (
                formatSoles(envio.costoCents)
              )}
            </dd>
          </div>
        </dl>

        <div
          className="mt-3 flex items-baseline justify-between border-t border-[var(--color-borde)] pt-3"
          aria-live="polite"
        >
          <span className="font-bold">Total</span>
          <span className="cifra text-xl font-bold">{formatSoles(totalCents)}</span>
        </div>
        <p className="mt-1 text-xs text-[var(--color-gris)]">
          El monto final incluirá unos céntimos únicos que identifican tu pago.
        </p>
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
        className="w-full rounded-full bg-[var(--color-acento)] px-6 py-4 font-bold text-[var(--color-tinta)] transition hover:bg-[var(--color-acento-oscuro)] disabled:opacity-50"
      >
        {enviando ? "Creando tu pedido..." : "Confirmar y pagar con Yape"}
      </button>
    </form>
  );
}

/**
 * Cálculo de envío para mostrar.
 *
 * Replica la lógica de `quote.ts` con la configuración que llega del servidor.
 * No se importa `calcularCotizacion` directamente porque arrastraría al bundle del
 * cliente tipos y tablas del módulo de envíos; aquí solo hace falta el número.
 */
function calcularEnvioUI({
  modo,
  distrito,
  subtotalCents,
  config,
}: {
  modo: Modo;
  distrito: string;
  subtotalCents: Cents;
  config: ConfigEnvioUI;
}): { costoCents: Cents; detalle: string | null } {
  if (modo === "recojo_tienda") {
    return { costoCents: 0, detalle: "Recojo en tienda" };
  }

  const umbral = config.umbralEnvioGratisCents;
  const alcanzaGratis = umbral !== null && subtotalCents >= umbral;

  if (modo === "provincia_agencia") {
    if (alcanzaGratis && config.envioGratisAplicaProvincia) {
      return { costoCents: 0, detalle: "Envío gratis" };
    }
    return { costoCents: config.provinciaCents, detalle: "Estimado, lo confirma la agencia" };
  }

  if (alcanzaGratis) return { costoCents: 0, detalle: "Envío gratis por el monto" };

  const normalizado = normalizar(distrito);
  if (normalizado === "") return { costoCents: config.limaFallbackCents, detalle: null };

  const zona = config.zonasLima.find((z) => z.distritos.some((d) => normalizar(d) === normalizado));
  return zona === undefined
    ? { costoCents: config.limaFallbackCents, detalle: "Lo confirmamos por WhatsApp" }
    : { costoCents: zona.costoCents, detalle: `${zona.nombre} · ${zona.plazo}` };
}

function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function Campo({
  id,
  etiqueta,
  tipo = "text",
  requerido = false,
  ayuda,
  placeholder,
  autoComplete,
  valor,
  onChange,
  lista,
}: {
  id: string;
  etiqueta: string;
  tipo?: string;
  requerido?: boolean;
  ayuda?: string;
  placeholder?: string;
  autoComplete?: string;
  valor?: string;
  onChange?: (v: string) => void;
  lista?: string[];
}) {
  const idAyuda = `${id}-ayuda`;
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-semibold">
        {etiqueta}
        {requerido && (
          <>
            <span aria-hidden="true" className="text-[var(--color-alerta)]">
              {" "}
              *
            </span>
            <span className="solo-lectores"> (obligatorio)</span>
          </>
        )}
      </label>
      <input
        id={id}
        name={id}
        type={tipo}
        required={requerido}
        placeholder={placeholder}
        autoComplete={autoComplete}
        // Vincula la ayuda al campo para que el lector de pantalla la lea al
        // enfocarlo, en vez de dejarla como texto suelto.
        aria-describedby={ayuda === undefined ? undefined : idAyuda}
        {...(lista !== undefined ? { list: `${id}-lista` } : {})}
        {...(valor !== undefined ? { value: valor } : {})}
        {...(onChange !== undefined ? { onChange: (e) => onChange(e.target.value) } : {})}
        className="mt-1 w-full rounded-lg border border-[var(--color-borde)] px-3 py-2.5 text-sm"
      />
      {lista !== undefined && (
        <datalist id={`${id}-lista`}>
          {[...new Set(lista)].map((opcion) => (
            <option key={opcion} value={capitalizar(opcion)} />
          ))}
        </datalist>
      )}
      {ayuda !== undefined && (
        <p id={idAyuda} className="mt-1 text-xs text-[var(--color-gris)]">
          {ayuda}
        </p>
      )}
    </div>
  );
}

function OpcionEntrega({
  valor,
  actual,
  onChange,
  titulo,
  detalle,
}: {
  valor: Modo;
  actual: Modo;
  onChange: (m: Modo) => void;
  titulo: string;
  detalle: string;
}) {
  const activa = actual === valor;
  return (
    <label
      className={`flex cursor-pointer gap-3 rounded-xl border-2 p-4 transition ${
        activa ? "border-[var(--color-tinta)] bg-[var(--color-humo)]" : "border-[var(--color-borde)]"
      }`}
    >
      <input
        type="radio"
        name="modo_entrega"
        value={valor}
        checked={activa}
        onChange={() => onChange(valor)}
        className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-tinta)]"
      />
      <span>
        <span className="block font-semibold">{titulo}</span>
        <span className="block text-sm text-[var(--color-gris)]">{detalle}</span>
      </span>
    </label>
  );
}

function capitalizar(texto: string): string {
  return texto.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}
