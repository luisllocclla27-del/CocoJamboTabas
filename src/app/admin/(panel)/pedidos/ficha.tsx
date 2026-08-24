"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatSoles } from "@/lib/money";
import { ETIQUETA_ADMIN, nextStatuses, type OrderStatus } from "@/lib/order-status";
import { generatePickupCode } from "@/lib/shipping/pickup-code";
import type { PedidoAdmin } from "@/lib/admin/queries";
import { cambiarEstadoPedido, registrarEnvio } from "@/lib/admin/orders";

/**
 * Ficha de pedido en el panel.
 *
 * Los botones de transición se derivan de `nextStatuses`, la misma máquina de
 * estados que valida Postgres. Así el admin solo ve acciones posibles, en lugar de
 * pulsar un botón y recibir un error de la base.
 */
export function FichaPedido({ pedido }: { pedido: PedidoAdmin }) {
  const router = useRouter();
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [registrando, setRegistrando] = useState(false);
  const [abierto, setAbierto] = useState(false);

  const siguientes = nextStatuses(pedido.status);

  async function transicionar(destino: OrderStatus) {
    setEnviando(true);
    setError(null);
    const resultado = await cambiarEstadoPedido({ orderId: pedido.id, destino });
    setEnviando(false);
    if (!resultado.ok) {
      setError(resultado.error);
      return;
    }
    router.refresh();
  }

  async function alRegistrarEnvio(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setEnviando(true);
    setError(null);
    const datos = new FormData(event.currentTarget);
    const resultado = await registrarEnvio({
      orderId: pedido.id,
      guia: String(datos.get("guia") ?? ""),
      codigo: String(datos.get("codigo") ?? ""),
      claveRetiro: String(datos.get("claveRetiro") ?? ""),
      agencia: String(datos.get("agencia") ?? ""),
    });
    setEnviando(false);
    if (!resultado.ok) {
      setError(resultado.error);
      return;
    }
    setRegistrando(false);
    router.refresh();
  }

  const puedeRegistrarEnvio =
    pedido.status === "preparando" || pedido.status === "verificado";

  return (
    <article className="rounded-xl border border-[var(--color-borde)] p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="cifra font-bold">{pedido.reference}</p>
          <p className="text-sm text-[var(--color-gris)]">
            {pedido.nombreCliente} ·{" "}
            <a
              href={`https://wa.me/51${pedido.telefono}`}
              target="_blank"
              rel="noopener noreferrer"
              className="cifra underline underline-offset-2"
            >
              {pedido.telefono}
            </a>
          </p>
          <p className="text-xs text-[var(--color-gris)]">
            {new Date(pedido.creadoEn).toLocaleString("es-PE")}
          </p>
        </div>
        <div className="text-right">
          <EtiquetaEstado status={pedido.status} />
          <p className="cifra mt-1 font-bold">{formatSoles(pedido.totalCents)}</p>
          <p className="cifra text-xs text-[var(--color-exito)]">
            +{formatSoles(pedido.gananciaCents)} ganancia
          </p>
        </div>
      </header>

      <button
        type="button"
        onClick={() => setAbierto(!abierto)}
        aria-expanded={abierto}
        className="mt-3 text-sm underline underline-offset-4"
      >
        {abierto ? "Ocultar detalle" : "Ver detalle"}
      </button>

      {abierto && (
        <div className="mt-3 grid gap-4 border-t border-[var(--color-borde)] pt-3 text-sm sm:grid-cols-2">
          <div>
            <p className="font-semibold">Productos</p>
            <ul className="mt-1 text-[var(--color-gris)]">
              {pedido.items.map((item, i) => (
                <li key={i} className="cifra">
                  {item.cantidad}× {item.modelo} · {item.colorway} · US{" "}
                  {formatearTalla(item.sizeUs)}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="font-semibold">Entrega</p>
            <div className="mt-1 text-[var(--color-gris)]">
              {pedido.modoEnvio === "lima_domicilio" && (
                <>
                  <p>{pedido.direccion}</p>
                  <p>{pedido.distrito}</p>
                </>
              )}
              {pedido.modoEnvio === "provincia_agencia" && (
                <>
                  <p>
                    {pedido.provincia}, {pedido.departamento}
                  </p>
                  <p>Agencia: {pedido.agenciaDestino ?? "por definir"}</p>
                  {pedido.dni !== null && <p className="cifra">DNI: {pedido.dni}</p>}
                </>
              )}
              {pedido.modoEnvio === "recojo_tienda" && <p>Recojo en tienda</p>}
              {pedido.notas !== null && <p className="mt-1 italic">&quot;{pedido.notas}&quot;</p>}
            </div>

            {pedido.envio !== null && pedido.envio.guia !== null && (
              <div className="mt-3">
                <p className="font-semibold">Envío registrado</p>
                <p className="cifra text-[var(--color-gris)]">
                  Guía {pedido.envio.guia} · Código {pedido.envio.codigo} · Clave{" "}
                  {pedido.envio.claveRetiro}
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {error !== null && (
        <p
          role="alert"
          className="mt-3 rounded-lg border border-[var(--color-alerta)] bg-[var(--color-alerta)]/5 px-3 py-2 text-sm font-medium text-[var(--color-alerta)]"
        >
          {error}
        </p>
      )}

      {registrando ? (
        <form onSubmit={alRegistrarEnvio} className="mt-4 rounded-lg bg-[var(--color-humo)] p-4">
          <p className="text-sm font-semibold">Datos de la guía emitida en la agencia</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <CampoEnvio id="guia" etiqueta="Número de guía" />
            <CampoEnvio id="codigo" etiqueta="Código de rastreo" />
            <CampoEnvio
              id="claveRetiro"
              etiqueta="Clave de retiro"
              // Sugerir una clave válida evita que el admin elija "1234", que
              // Shalom rechaza con un 422 tras una llamada de hasta 150 s.
              defecto={generatePickupCode()}
              ayuda="4 dígitos, ni repetidos ni consecutivos."
            />
            <CampoEnvio id="agencia" etiqueta="Agencia de destino" defecto={pedido.agenciaDestino ?? ""} />
          </div>
          <div className="mt-3 flex gap-2">
            <button
              type="submit"
              disabled={enviando}
              className="rounded-full bg-[var(--color-acento)] px-5 py-2 text-sm font-bold text-[var(--color-tinta)] disabled:opacity-50"
            >
              {enviando ? "Guardando..." : "Guardar y marcar enviado"}
            </button>
            <button
              type="button"
              onClick={() => setRegistrando(false)}
              className="rounded-full border border-[var(--color-borde)] px-5 py-2 text-sm"
            >
              Cancelar
            </button>
          </div>
        </form>
      ) : (
        <div className="mt-4 flex flex-wrap gap-2">
          {puedeRegistrarEnvio && (
            <button
              type="button"
              onClick={() => setRegistrando(true)}
              className="rounded-full bg-[var(--color-tinta)] px-5 py-2 text-sm font-semibold text-[var(--color-papel)]"
            >
              Registrar envío
            </button>
          )}
          {siguientes
            // "enviado" se hace con el formulario de guía, no con un botón suelto:
            // marcar enviado sin datos de rastreo deja al cliente sin nada que
            // consultar.
            .filter((s) => s !== "enviado")
            .map((destino) => (
              <button
                key={destino}
                type="button"
                onClick={() => transicionar(destino)}
                disabled={enviando}
                className="rounded-full border border-[var(--color-borde)] px-5 py-2 text-sm font-medium hover:border-[var(--color-tinta)] disabled:opacity-50"
              >
                {ETIQUETA_ADMIN[destino]}
              </button>
            ))}
          {siguientes.length === 0 && (
            <p className="text-sm text-[var(--color-gris)]">Este pedido ya cerró su ciclo.</p>
          )}
        </div>
      )}
    </article>
  );
}

function CampoEnvio({
  id,
  etiqueta,
  defecto,
  ayuda,
}: {
  id: string;
  etiqueta: string;
  defecto?: string;
  ayuda?: string;
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-semibold">
        {etiqueta}
      </label>
      <input
        id={id}
        name={id}
        required
        defaultValue={defecto}
        aria-describedby={ayuda === undefined ? undefined : `${id}-ayuda`}
        className="cifra mt-1 w-full rounded-lg border border-[var(--color-borde)] bg-[var(--color-papel)] px-3 py-2 text-sm"
      />
      {ayuda !== undefined && (
        <p id={`${id}-ayuda`} className="mt-0.5 text-xs text-[var(--color-gris)]">
          {ayuda}
        </p>
      )}
    </div>
  );
}

function EtiquetaEstado({ status }: { status: OrderStatus }) {
  const estilos: Record<OrderStatus, string> = {
    pendiente_pago: "bg-[var(--color-humo)] text-[var(--color-gris)]",
    comprobante_enviado: "bg-[var(--color-acento)] text-[var(--color-tinta)]",
    verificado: "bg-[var(--color-exito)] text-white",
    rechazado: "bg-[var(--color-alerta)] text-white",
    preparando: "bg-[var(--color-tinta)] text-white",
    enviado: "bg-[var(--color-tinta)] text-white",
    entregado: "bg-[var(--color-exito)] text-white",
    cancelado: "bg-[var(--color-humo)] text-[var(--color-gris)]",
    expirado: "bg-[var(--color-humo)] text-[var(--color-gris)]",
  };
  return (
    <span
      className={`inline-block rounded-full px-3 py-1 text-xs font-bold uppercase ${estilos[status]}`}
    >
      {ETIQUETA_ADMIN[status]}
    </span>
  );
}

function formatearTalla(valor: number): string {
  return Number.isInteger(valor) ? String(valor) : valor.toFixed(1);
}
