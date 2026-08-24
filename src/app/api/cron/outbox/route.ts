import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { procesarOutbox, recuperarAtascados } from "@/lib/outbox/worker";

/**
 * Ruta del cron que procesa el outbox.
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

  const cabecera = request.headers.get("authorization") ?? "";
  const desdeCabecera = cabecera.startsWith("Bearer ") ? cabecera.slice(7) : "";
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

    return NextResponse.json({ ok: true, recuperados, ...resumen });
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
