import type { Metadata } from "next";
import Link from "next/link";
import { createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/client";

export const metadata: Metadata = {
  title: "Diagnóstico",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * Página de diagnóstico.
 *
 * Existe porque el código nunca se había ejecutado contra la base real, y sin esto
 * cada fallo cuesta un despliegue completo para descubrir una sola cosa. Esta página
 * comprueba todo de una vez y dice exactamente qué falta.
 *
 * QUÉ NO MUESTRA, y por qué: nunca el valor de una variable de entorno (solo si está
 * presente), y nunca el mensaje crudo de un error de Postgres. Los mensajes de error
 * de la base pueden revelar nombres de tablas, columnas y detalles del esquema. En su
 * lugar se muestra el CÓDIGO del error, que es lo que de verdad identifica el
 * problema, con una explicación escrita aquí:
 *
 *   42P01  la tabla no existe        → falta aplicar una migración
 *   42501  permiso denegado          → falta un GRANT
 *   42883  la función no existe      → falta aplicar 0003 o 0005
 *   PGRST202  función no encontrada  → lo mismo, visto desde la API REST
 *   PGRST301  sin autorización       → la clave no es la que se espera
 *
 * Eso la hace segura de dejar accesible mientras se depura. Aun así conviene
 * borrarla cuando la tienda esté en marcha: no aporta nada a un cliente.
 */
export default async function DiagnosticoPage() {
  const resultados = await ejecutarComprobaciones();
  const fallos = resultados.filter((r) => r.estado === "error");
  const avisos = resultados.filter((r) => r.estado === "aviso");

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="titular text-4xl">Diagnóstico</h1>
      <p className="mt-2 text-[var(--color-gris)]">
        Comprueba que la aplicación puede hablar con la base de datos y que todas las migraciones
        están aplicadas.
      </p>

      <div
        className={`mt-6 rounded-xl border-2 p-5 ${
          fallos.length > 0
            ? "border-[var(--color-alerta)] bg-[var(--color-alerta)]/5"
            : avisos.length > 0
              ? "border-[var(--color-aviso)] bg-[var(--color-aviso)]/5"
              : "border-[var(--color-exito)] bg-[var(--color-exito)]/5"
        }`}
      >
        <p className="titular text-2xl">
          {fallos.length > 0
            ? `${fallos.length} ${fallos.length === 1 ? "problema" : "problemas"} que impiden vender`
            : avisos.length > 0
              ? "Funciona, con avisos"
              : "Todo en orden"}
        </p>
        <p className="mt-1 text-sm">
          {fallos.length > 0
            ? "Resuelve lo marcado en rojo y recarga esta página."
            : avisos.length > 0
              ? "La tienda puede vender. Los avisos son mejoras pendientes."
              : "La tienda está lista para recibir pedidos."}
        </p>
      </div>

      <ul className="mt-8 space-y-3">
        {resultados.map((resultado) => (
          <li
            key={resultado.nombre}
            className="rounded-lg border border-[var(--color-borde)] p-4"
          >
            <div className="flex items-start gap-3">
              <span aria-hidden="true" className="text-lg leading-none">
                {resultado.estado === "ok" ? "🟢" : resultado.estado === "aviso" ? "🟡" : "🔴"}
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-semibold">
                  {resultado.nombre}
                  <span className="solo-lectores">
                    {resultado.estado === "ok"
                      ? " (correcto)"
                      : resultado.estado === "aviso"
                        ? " (aviso)"
                        : " (error)"}
                  </span>
                </p>
                <p className="mt-0.5 text-sm text-[var(--color-gris)]">{resultado.detalle}</p>
                {resultado.solucion !== undefined && (
                  <p className="mt-2 rounded bg-[var(--color-humo)] px-3 py-2 text-sm">
                    <span className="font-semibold">Cómo se arregla: </span>
                    {resultado.solucion}
                  </p>
                )}
                {resultado.codigo !== undefined && (
                  <p className="cifra mt-1 text-xs text-[var(--color-gris)]">
                    Código: {resultado.codigo}
                  </p>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>

      <div className="mt-10 flex flex-wrap gap-3">
        <Link
          href="/catalogo"
          className="rounded-full bg-[var(--color-tinta)] px-6 py-3 font-semibold text-[var(--color-papel)]"
        >
          Ir al catálogo
        </Link>
        <Link
          href="/admin"
          className="rounded-full border border-[var(--color-borde)] px-6 py-3 font-semibold"
        >
          Ir al panel
        </Link>
      </div>
    </div>
  );
}

type Estado = "ok" | "aviso" | "error";

type Resultado = {
  nombre: string;
  estado: Estado;
  detalle: string;
  solucion?: string;
  codigo?: string;
};

/** Traduce un código de Postgres o PostgREST a una causa concreta. */
function explicar(codigo: string | undefined): string | null {
  switch (codigo) {
    case "42P01":
      return "la tabla no existe: falta aplicar una migración";
    case "42501":
      return "permiso denegado: falta un GRANT para ese rol";
    case "42883":
    case "PGRST202":
      return "la función no existe o su firma no coincide";
    case "PGRST301":
    case "PGRST302":
      return "la clave de API no autoriza esta operación";
    case "PGRST116":
      return "la consulta no devolvió filas";
    case "PGRST200":
      return "la relación entre tablas del select anidado no existe";
    default:
      return null;
  }
}

async function ejecutarComprobaciones(): Promise<Resultado[]> {
  const resultados: Resultado[] = [];

  // ── Variables de entorno ────────────────────────────────────────────────
  // Solo presencia, nunca el valor.
  const variables: Array<[string, boolean, boolean]> = [
    ["NEXT_PUBLIC_SUPABASE_URL", !!process.env.NEXT_PUBLIC_SUPABASE_URL, true],
    ["NEXT_PUBLIC_SUPABASE_ANON_KEY", !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, true],
    ["SUPABASE_SERVICE_ROLE_KEY", !!process.env.SUPABASE_SERVICE_ROLE_KEY, true],
    ["NEXT_PUBLIC_SITE_URL", !!process.env.NEXT_PUBLIC_SITE_URL, false],
    ["YAPE_NUMERO", !!process.env.YAPE_NUMERO, false],
    ["YAPE_TITULAR", !!process.env.YAPE_TITULAR, false],
    ["CRON_SECRET", !!process.env.CRON_SECRET, false],
  ];

  const faltanObligatorias = variables.filter(([, presente, obligatoria]) => obligatoria && !presente);
  const faltanOpcionales = variables.filter(([, presente, obligatoria]) => !obligatoria && !presente);

  resultados.push(
    faltanObligatorias.length > 0
      ? {
          nombre: "Variables de entorno obligatorias",
          estado: "error",
          detalle: `Faltan: ${faltanObligatorias.map(([n]) => n).join(", ")}.`,
          solucion:
            "Añádelas en Vercel → Project Settings → Environment Variables, marcando Production, Preview y Development, y vuelve a desplegar.",
        }
      : {
          nombre: "Variables de entorno obligatorias",
          estado: "ok",
          detalle: "Las tres claves de Supabase están presentes.",
        },
  );

  if (faltanOpcionales.length > 0) {
    const sinYape = faltanOpcionales.some(([n]) => n.startsWith("YAPE"));
    resultados.push({
      nombre: "Variables de entorno opcionales",
      estado: sinYape ? "error" : "aviso",
      detalle: `Faltan: ${faltanOpcionales.map(([n]) => n).join(", ")}.`,
      solucion: sinYape
        ? "Sin YAPE_NUMERO y YAPE_TITULAR la pantalla de pago no puede decirle al cliente a dónde yapear: la venta se corta ahí."
        : "NEXT_PUBLIC_SITE_URL afecta a los enlaces que se mandan por WhatsApp. CRON_SECRET protege el procesado de avisos.",
    });
  }

  // Sin las claves obligatorias no tiene sentido seguir: todo lo demás fallaría
  // por la misma causa y llenaría la pantalla de rojo sin información nueva.
  if (faltanObligatorias.length > 0) return resultados;

  // ── Lectura pública del catálogo ────────────────────────────────────────
  // Es la consulta que hace la home. Prueba el GRANT y la política RLS de lectura.
  try {
    const supabase = await createServerClient();
    const { data, error } = await supabase.from("brands").select("slug").eq("activo", true);

    if (error !== null) {
      resultados.push({
        nombre: "Lectura pública de marcas",
        estado: "error",
        detalle: explicar(error.code) ?? "la consulta falló",
        codigo: error.code,
        solucion:
          error.code === "42P01"
            ? "Ejecuta supabase/migrations/0001_schema.sql en el SQL Editor de Supabase."
            : "Ejecuta supabase/migrations/0002_rls.sql: concede el SELECT público sobre el catálogo.",
      });
    } else {
      resultados.push({
        nombre: "Lectura pública de marcas",
        estado: (data?.length ?? 0) > 0 ? "ok" : "aviso",
        detalle: `${data?.length ?? 0} marcas activas.`,
        ...((data?.length ?? 0) === 0
          ? { solucion: "Ejecuta supabase/seed.sql para cargar el catálogo de ejemplo." }
          : {}),
      });
    }
  } catch (error) {
    resultados.push({
      nombre: "Lectura pública de marcas",
      estado: "error",
      detalle: "no se pudo conectar con Supabase",
      solucion:
        "Revisa que NEXT_PUBLIC_SUPABASE_URL sea el dominio del proyecto (https://xxxx.supabase.co) y que la clave publishable corresponda a ese proyecto.",
      codigo: error instanceof Error ? error.name : undefined,
    });
  }

  // ── El select anidado del catálogo ──────────────────────────────────────
  // Lo que puede romperse aquí no es el permiso sino la FORMA del join: si una
  // relación no existe con el nombre esperado, PostgREST responde PGRST200 y la
  // home saldría vacía sin decir por qué.
  try {
    const supabase = await createServerClient();
    const { data, error } = await supabase
      .from("products")
      .select("slug, brands!inner(slug), product_images(url), variants(size_us, stock)")
      .eq("activo", true)
      .limit(3);

    resultados.push(
      error !== null
        ? {
            nombre: "Catálogo con marcas, fotos y tallas",
            estado: "error",
            detalle: explicar(error.code) ?? "el select anidado falló",
            codigo: error.code,
            solucion:
              "Las claves foráneas entre products, brands, product_images y variants deben existir. Reaplica supabase/migrations/0001_schema.sql.",
          }
        : {
            nombre: "Catálogo con marcas, fotos y tallas",
            estado: (data?.length ?? 0) > 0 ? "ok" : "aviso",
            detalle:
              (data?.length ?? 0) > 0
                ? `Consulta correcta. ${data?.length} productos leídos con sus relaciones.`
                : "La consulta funciona pero no hay productos activos.",
            ...((data?.length ?? 0) === 0
              ? { solucion: "Ejecuta supabase/seed.sql." }
              : {}),
          },
    );
  } catch {
    resultados.push({
      nombre: "Catálogo con marcas, fotos y tallas",
      estado: "error",
      detalle: "la consulta lanzó una excepción",
    });
  }

  // ── La service role omite la RLS ────────────────────────────────────────
  // Es lo que permite que un visitante anónimo cree un pedido. Si falla, el
  // checkout no funciona aunque el catálogo se vea perfecto.
  try {
    const admin = createAdminClient();
    const { error } = await admin.from("orders").select("id", { count: "exact", head: true });

    resultados.push(
      error !== null
        ? {
            nombre: "La clave de servicio omite la RLS",
            estado: "error",
            detalle: explicar(error.code) ?? "no pudo leer la tabla de pedidos",
            codigo: error.code,
            solucion:
              "SUPABASE_SERVICE_ROLE_KEY debe ser la secret key del proyecto (sb_secret_... o la service_role antigua), no la publishable. Sin ella el checkout no puede crear pedidos.",
          }
        : {
            nombre: "La clave de servicio omite la RLS",
            estado: "ok",
            detalle: "Puede leer pedidos, así que el checkout podrá crearlos.",
          },
    );
  } catch {
    resultados.push({
      nombre: "La clave de servicio omite la RLS",
      estado: "error",
      detalle: "no se pudo crear el cliente con la clave de servicio",
      solucion: "Comprueba que SUPABASE_SERVICE_ROLE_KEY esté definida y sea del proyecto correcto.",
    });
  }

  // ── Funciones de la migración 0003 ──────────────────────────────────────
  // Se llaman las dos que NO tienen efectos secundarios. Si existen, las demás del
  // mismo archivo también, incluida create_order_with_reservations, que no se puede
  // probar aquí porque crearía un pedido real.
  try {
    const admin = createAdminClient();
    const { error } = await admin.rpc("available_stock", {
      p_variant_id: "00000000-0000-4000-8000-000000000000",
    });

    resultados.push(
      error !== null
        ? {
            nombre: "Funciones de stock y reservas (0003)",
            estado: "error",
            detalle: explicar(error.code) ?? "available_stock no respondió",
            codigo: error.code,
            solucion:
              "Ejecuta supabase/migrations/0003_functions.sql. Es la que crea create_order_with_reservations, sin la cual no se puede comprar.",
          }
        : {
            nombre: "Funciones de stock y reservas (0003)",
            estado: "ok",
            detalle:
              "available_stock responde. create_order_with_reservations no se prueba aquí porque crearía un pedido real.",
          },
    );
  } catch {
    resultados.push({
      nombre: "Funciones de stock y reservas (0003)",
      estado: "error",
      detalle: "la llamada lanzó una excepción",
    });
  }

  // ── Seguimiento público ─────────────────────────────────────────────────
  try {
    const admin = createAdminClient();
    const { error } = await admin.rpc("public_order_tracking", { p_reference: "COCO-ZZZZZZ" });

    resultados.push(
      error !== null
        ? {
            nombre: "Seguimiento público de pedidos",
            estado: "error",
            detalle: explicar(error.code) ?? "public_order_tracking no respondió",
            codigo: error.code,
            solucion: "Ejecuta supabase/migrations/0003_functions.sql.",
          }
        : {
            nombre: "Seguimiento público de pedidos",
            estado: "ok",
            detalle: "La función responde con una referencia inexistente, como debe.",
          },
    );
  } catch {
    resultados.push({
      nombre: "Seguimiento público de pedidos",
      estado: "error",
      detalle: "la llamada lanzó una excepción",
    });
  }

  // ── Bucket de comprobantes ──────────────────────────────────────────────
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.storage.getBucket("vouchers");

    if (error !== null || data === null) {
      resultados.push({
        nombre: "Bucket privado de comprobantes",
        estado: "error",
        detalle: "el bucket 'vouchers' no existe",
        solucion:
          "Ejecuta supabase/migrations/0004_storage.sql. Sin el bucket, el cliente no puede subir su captura de Yape.",
      });
    } else {
      resultados.push({
        nombre: "Bucket privado de comprobantes",
        estado: data.public ? "error" : "ok",
        detalle: data.public
          ? "El bucket existe pero es PÚBLICO: cualquiera podría leer los comprobantes."
          : "Existe y es privado. Los comprobantes solo se sirven por URL firmada.",
        ...(data.public
          ? {
              solucion:
                "En Storage → vouchers → Settings, desmarca 'Public bucket'. Los vouchers llevan datos personales del pagador.",
            }
          : {}),
      });
    }
  } catch {
    resultados.push({
      nombre: "Bucket privado de comprobantes",
      estado: "error",
      detalle: "no se pudo consultar Storage",
    });
  }

  // ── Migración del outbox ────────────────────────────────────────────────
  // No se llama claim_outbox_events porque marcaría eventos como 'procesando'. Se
  // usa el rescate, que es idempotente y no tiene efectos indeseados.
  try {
    const admin = createAdminClient();
    const { error } = await admin.rpc("recover_stuck_outbox_events", { p_minutos: 15 });

    resultados.push(
      error !== null
        ? {
            nombre: "Avisos por WhatsApp (0005)",
            estado: "aviso",
            detalle: explicar(error.code) ?? "las funciones del outbox no responden",
            codigo: error.code,
            solucion:
              "Ejecuta supabase/migrations/0005_outbox.sql. Se puede vender sin esto: los avisos quedan en la cola y el panel los muestra igual.",
          }
        : {
            nombre: "Avisos por WhatsApp (0005)",
            estado: "ok",
            detalle: "Las funciones del outbox están aplicadas.",
          },
    );
  } catch {
    resultados.push({
      nombre: "Avisos por WhatsApp (0005)",
      estado: "aviso",
      detalle: "la llamada lanzó una excepción",
    });
  }

  // ── Administradores ─────────────────────────────────────────────────────
  try {
    const admin = createAdminClient();
    const { count, error } = await admin
      .from("admin_users")
      .select("id", { count: "exact", head: true });

    resultados.push(
      error !== null
        ? {
            nombre: "Usuarios administradores",
            estado: "error",
            detalle: explicar(error.code) ?? "no se pudo leer admin_users",
            codigo: error.code,
            solucion: "Ejecuta supabase/migrations/0001_schema.sql.",
          }
        : {
            nombre: "Usuarios administradores",
            estado: (count ?? 0) > 0 ? "ok" : "error",
            detalle:
              (count ?? 0) > 0
                ? `${count} ${count === 1 ? "administrador" : "administradores"} autorizados.`
                : "No hay ningún administrador: el panel no se puede usar.",
            ...((count ?? 0) === 0
              ? {
                  solucion:
                    "Crea el usuario en Authentication → Users y luego, en el SQL Editor: insert into admin_users (id, rol) select id, 'admin' from auth.users where email = 'tu-email';",
                }
              : {}),
          },
    );
  } catch {
    resultados.push({
      nombre: "Usuarios administradores",
      estado: "error",
      detalle: "no se pudo consultar admin_users",
    });
  }

  // ── Un envío por pedido (0006) ──────────────────────────────────────
  // La restricción única sobre shipments.order_id es lo que permite el upsert al
  // registrar la guía. Sin ella el panel falla con 42P10 justo cuando el admin va a
  // despachar, que es el peor momento.
  try {
    const admin = createAdminClient();
    const { error } = await admin
      .from("shipments")
      .upsert(
        // `order_id` nulo es inválido, así que la fila nunca se crea: si el
        // `on conflict` no encontrara el índice, el error 42P10 llegaría ANTES que
        // la violación del not-null. Es una comprobación de esquema sin efectos.
        { order_id: null as unknown as string, provider: "manual" },
        { onConflict: "order_id" },
      );

    resultados.push(
      error?.code === "42P10"
        ? {
            nombre: "Un envío por pedido (0006)",
            estado: "error",
            detalle: "falta la restricción única sobre shipments.order_id",
            codigo: error.code,
            solucion:
              "Ejecuta supabase/migrations/0006_shipments_unique.sql. Sin ella, el panel no puede guardar la guía de envío.",
          }
        : {
            nombre: "Un envío por pedido (0006)",
            estado: "ok",
            detalle: "La restricción existe: el panel puede registrar y corregir guías.",
          },
    );
  } catch {
    resultados.push({
      nombre: "Un envío por pedido (0006)",
      estado: "aviso",
      detalle: "no se pudo comprobar la restricción",
    });
  }

  // ── Alta de productos desde el panel (0007) ─────────────────────────────
  // Dos cosas distintas que vienen en el mismo archivo: el bucket público de fotos
  // y adjust_stock(). Si falta el bucket, el formulario de alta crea el producto sin
  // fotos; si falta la función, no se puede ni reponer stock.
  try {
    const admin = createAdminClient();
    const [bucket, funcion] = await Promise.all([
      admin.storage.getBucket("productos"),
      // Un uuid inexistente: la función lanza "la variante no existe", que ya
      // demuestra que está aplicada, sin tocar ningún stock real.
      admin.rpc("adjust_stock", {
        p_variant_id: "00000000-0000-4000-8000-000000000000",
        p_stock_nuevo: 0,
        p_motivo: "ajuste_manual",
        p_nota: null,
        p_actor: "diagnostico",
      }),
    ]);

    const faltaBucket = bucket.error !== null || bucket.data === null;
    const faltaFuncion =
      funcion.error !== null &&
      (funcion.error.code === "PGRST202" || funcion.error.code === "42883");

    resultados.push(
      faltaBucket || faltaFuncion
        ? {
            nombre: "Alta de productos y stock (0007)",
            estado: "error",
            detalle: faltaFuncion
              ? "adjust_stock() no existe: no se puede ajustar stock ni cargar productos"
              : "el bucket 'productos' no existe: las fotos no se pueden subir",
            ...(faltaFuncion && funcion.error?.code !== undefined
              ? { codigo: funcion.error.code }
              : {}),
            solucion:
              "Ejecuta supabase/migrations/0007_product_media.sql. Crea el bucket de fotos, el historial de inventario y adjust_stock().",
          }
        : {
            nombre: "Alta de productos y stock (0007)",
            estado: bucket.data?.public === false ? "aviso" : "ok",
            detalle:
              bucket.data?.public === false
                ? "La función existe, pero el bucket 'productos' es privado: las fotos del catálogo no cargarían."
                : "El bucket de fotos y adjust_stock() están aplicados: se pueden cargar productos desde el panel.",
            ...(bucket.data?.public === false
              ? {
                  solucion:
                    "En Storage → productos → Settings, marca 'Public bucket'. Una foto de producto es material de marketing: se sirve desde el CDN.",
                }
              : {}),
          },
    );
  } catch {
    resultados.push({
      nombre: "Alta de productos y stock (0007)",
      estado: "error",
      detalle: "no se pudo comprobar el bucket ni la función",
    });
  }

  // ── Expiración de reservas agendada ─────────────────────────────────────
  // No se puede leer `cron.job` por la API REST, así que en vez de un recordatorio
  // ciego se mide el SÍNTOMA: reservas todavía 'activa' con la fecha ya pasada. Si
  // hay alguna, el cron no está corriendo y esas tallas están bloqueadas sin que
  // ningún pedido las respalde.
  try {
    const admin = createAdminClient();
    const { count, error } = await admin
      .from("reservations")
      .select("id", { count: "exact", head: true })
      .eq("status", "activa")
      .lt("expires_at", new Date().toISOString());

    const vencidas = count ?? 0;

    resultados.push(
      error !== null
        ? {
            nombre: "Expiración de reservas",
            estado: "error",
            detalle: explicar(error.code) ?? "no se pudo leer la tabla de reservas",
            codigo: error.code,
            solucion: "Ejecuta supabase/migrations/0001_schema.sql.",
          }
        : vencidas > 0
          ? {
              nombre: "Expiración de reservas",
              estado: "error",
              detalle: `${vencidas} ${vencidas === 1 ? "reserva vencida sigue" : "reservas vencidas siguen"} bloqueando stock: el cron no está corriendo.`,
              solucion:
                "Activa pg_cron en Database → Extensions y ejecuta: select cron.schedule('expirar-reservas', '*/5 * * * *', $$select expire_stale_reservations()$$); Para liberar las de ahora: select expire_stale_reservations();",
            }
          : {
              nombre: "Expiración de reservas",
              estado: "aviso",
              detalle:
                "No hay reservas vencidas sin liberar. Eso es buena señal, pero no prueba que el cron esté agendado: también ocurre si nadie abandonó un checkout todavía.",
              solucion:
                "Confírmalo en el SQL Editor con: select jobname, schedule from cron.job; Si no aparece 'expirar-reservas', agéndalo: select cron.schedule('expirar-reservas', '*/5 * * * *', $$select expire_stale_reservations()$$);",
            },
    );
  } catch {
    resultados.push({
      nombre: "Expiración de reservas",
      estado: "aviso",
      detalle: "no se pudo comprobar el estado de las reservas",
    });
  }

  return resultados;
}
