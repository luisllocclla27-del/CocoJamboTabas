import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { procesarOutbox, recuperarAtascados } from "@/lib/outbox/worker";

/**
 * Ruta del cron que procesa el outbox.
 *
 * AGENDA: `vercel.json` lo dispara una vez al día, porque el plan Hobby de Vercel no
 * admite más (rechaza el despliegue si el schedule pide otra cosa). Eso NO sirve como
 * vía principal: el cliente pagaría por la mañana y recibiría la confirmación al día
 * siguiente. La vía real es pg_cron + pg_net desde Supabase, que permite cada minuto
 * sin coste; está documentada en `supabase/migrations/0005_outbox.sql`. El cron de
 * Vercel queda como red de seguridad.
 *
 * AUTENTICACIÓN, y por qué existe: es un endpoint público que dispara trabajo. Sin
 * protección, cualquiera podría invocarlo en bucle y provocar tantas llamadas al
 * proveedor de mensajería como quisiera, o simplemente consumir la cuota de
 * ejecución del proyecto.
 *
 * Vercel Cron envía `Authorization: Bearer <CRON_SECRET>` cuando la variable existe.
 * Se acepta también `?token=` para poder dispararlo desde pg_cron o un cron externo,
 * que no siempre permiten cabeceras personalizadas.
 *
 * La comparación es en tiempo constante: un `===` filtraría, byte a byte, cuánto
 * prefijo del secreto se acertó.
 */
export const dynamic = "force-dynamic";

/** Sin secreto configurado la ruta se niega a funcionar en producción. */
function autorizado(request: NextRequest): boolean {
  const esperado = process.env.CRON_SECRET;

  if (esperado === undefined || esperado === "") {
    // En desarrollo se permite sin secreto para poder probarlo con el navegador.
    // En producción, negar es lo correcto: una ruta de cron sin proteger es peor
    // que una ruta de cron que no funciona, porque el fallo pasa desapercibido.
    return process.env.NODE_ENV !== "production";
  }

  /**
   * Se acepta el secreto de tres formas, por orden de preferencia:
   *
   * 1. `Authorization: Bearer <secreto>` — lo que envía Vercel Cron.
   * 2. `Authorization: <secreto>` sin el prefijo — es el error más fácil de cometer
   *    al escribir el job de `pg_cron` a mano, y rechazarlo solo produciría un 401
   *    silencioso en un cron que nadie mira. Ser tolerante aquí no debilita nada:
   *    el secreto tiene que coincidir igual.
   * 3. `?token=<secreto>` — para crones que no permiten cabeceras personalizadas.
   */
  const cabecera = (request.headers.get("authorization") ?? "").trim();
  const desdeCabecera = cabecera.toLowerCase().startsWith("bearer ")
    ? cabecera.slice(7).trim()
    : cabecera;
  const desdeQuery = request.nextUrl.searchParams.get("token") ?? "";
  const recibido = desdeCabecera !== "" ? desdeCabecera : desdeQuery;

  const a = Buffer.from(esperado, "utf8");
  const b = Buffer.from(recibido, "utf8");
  // `timingSafeEqual` lanza si las longitudes difieren: se comprueban antes.
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(request: NextRequest) {
  if (!autorizado(request)) {
    // 401 sin detalle: no se confirma si el secreto existe ni cuál es el formato.
    return NextResponse.json({ error: "no autorizado" }, { status: 401 });
  }

  try {
    // El rescate va primero: si un worker murió a mitad, sus eventos vuelven a la
    // cola antes de reclamar el lote de esta ejecución.
    const recuperados = await recuperarAtascados();
    const resumen = await procesarOutbox();

    // Limpieza de reservas vencidas: unifica las dos tareas de fondo en una sola ruta
    // para que cualquier llamada (Vercel cron, Supabase pg_cron o webhook externo)
    // mantenga el inventario libre de carritos abandonados sin coste extra.
    let reservasExpiradas = 0;
    try {
      const { createAdminClient } = await import("@/lib/supabase/client");
      const supabase = createAdminClient();
      const { data, error } = await supabase.rpc("expire_stale_reservations");
      if (error === null && typeof data === "number") {
        reservasExpiradas = data;
      }
    } catch (e) {
      console.warn("[cron/outbox] no se pudieron expirar reservas:", e);
    }

    return NextResponse.json({
      ok: true,
      recuperados,
      reservasExpiradas,
      ...resumen,
    });
  } catch (error) {
    // 500 con motivo, sin traza: el cron necesita saber que falló para reintentar,
    // pero el detalle interno se queda en el log del servidor.
    console.error("[cron/outbox] fallo al procesar:", error);
    return NextResponse.json(
      { ok: false, error: "no se pudo procesar el outbox" },
      { status: 500 },
    );
  }
}
