import { describe, expect, it, vi } from "vitest";
import type { MensajeListo } from "./messages";
import type { Notificador, ResultadoEnvio } from "./worker";

/**
 * Tests del worker.
 *
 * El cliente de Supabase se sustituye con `vi.mock` para probar la lógica de
 * decisión sin base de datos: qué se marca como enviado, qué se reintenta y qué se
 * descarta. Lo que NO se prueba aquí es el reclamo atómico (`for update skip
 * locked`), porque eso solo se puede verificar contra Postgres de verdad; está en
 * `0005_outbox.sql` y pendiente de test de integración.
 */

type Evento = { id: string; tipo: string; payload: Record<string, unknown>; intentos: number };

/** Estado del doble de Supabase, accesible desde los tests. */
const estado: {
  eventos: Evento[];
  cierres: Array<{ id: string; ok: boolean; motivo: string | null; espera: number | null }>;
  errorAlReclamar: string | null;
  recuperados: number;
} = { eventos: [], cierres: [], errorAlReclamar: null, recuperados: 0 };

vi.mock("@/lib/supabase/client", () => ({
  createAdminClient: () => ({
    rpc: async (nombre: string, params: Record<string, unknown>) => {
      if (nombre === "claim_outbox_events") {
        if (estado.errorAlReclamar !== null) {
          return { data: null, error: { message: estado.errorAlReclamar } };
        }
        const limite = Number(params.p_limite ?? 20);
        const lote = estado.eventos.slice(0, limite);
        estado.eventos = estado.eventos.slice(limite);
        return { data: lote, error: null };
      }
      if (nombre === "release_outbox_event") {
        estado.cierres.push({
          id: String(params.p_id),
          ok: Boolean(params.p_ok),
          motivo: (params.p_error as string | null) ?? null,
          espera: (params.p_espera_segundos as number | null) ?? null,
        });
        return { data: null, error: null };
      }
      if (nombre === "recover_stuck_outbox_events") {
        return { data: estado.recuperados, error: null };
      }
      return { data: null, error: null };
    },
  }),
}));

const { procesarOutbox, recuperarAtascados, notificadorRegistro } = await import("./worker");

function reiniciar(eventos: Evento[]): void {
  estado.eventos = [...eventos];
  estado.cierres = [];
  estado.errorAlReclamar = null;
  estado.recuperados = 0;
}

function eventoValido(overrides: Partial<Evento> = {}): Evento {
  return {
    id: "evt-1",
    tipo: "whatsapp_pago_aprobado",
    payload: { telefono: "987654321", reference: "COCO-7F3K2M" },
    intentos: 0,
    ...overrides,
  };
}

/** Notificador que registra lo enviado y responde lo que se le indique. */
function notificadorFalso(respuesta: ResultadoEnvio | (() => ResultadoEnvio)): {
  notificador: Notificador;
  enviados: MensajeListo[];
} {
  const enviados: MensajeListo[] = [];
  return {
    enviados,
    notificador: {
      nombre: "falso",
      async enviar(mensaje) {
        enviados.push(mensaje);
        return typeof respuesta === "function" ? respuesta() : respuesta;
      },
    },
  };
}

describe("procesarOutbox", () => {
  it("marca como enviado lo que el notificador acepta", async () => {
    reiniciar([eventoValido()]);
    const { notificador, enviados } = notificadorFalso({ ok: true });

    const resumen = await procesarOutbox(notificador);

    expect(resumen.reclamados).toBe(1);
    expect(resumen.enviados).toBe(1);
    expect(enviados[0].telefono).toBe("51987654321");
    expect(estado.cierres[0]).toMatchObject({ id: "evt-1", ok: true, espera: null });
  });

  it("descarta sin reintentar un payload al que le falta lo esencial", async () => {
    // Reintentarlo daría el mismo resultado siempre: quedaría rebotando en la cola.
    reiniciar([eventoValido({ payload: { reference: "COCO-7F3K2M" } })]);
    const { notificador, enviados } = notificadorFalso({ ok: true });

    const resumen = await procesarOutbox(notificador);

    expect(resumen.descartados).toBe(1);
    expect(resumen.enviados).toBe(0);
    // No se intentó enviar nada.
    expect(enviados).toHaveLength(0);
    expect(estado.cierres[0]).toMatchObject({ ok: false, espera: null });
    expect(estado.cierres[0].motivo).toMatch(/payload insuficiente/);
  });

  it("descarta un tipo de evento desconocido", async () => {
    reiniciar([eventoValido({ tipo: "email_bienvenida" })]);
    const resumen = await procesarOutbox(notificadorFalso({ ok: true }).notificador);
    expect(resumen.descartados).toBe(1);
  });

  it("programa reintento con espera ante un fallo transitorio", async () => {
    reiniciar([eventoValido()]);
    const { notificador } = notificadorFalso({
      ok: false,
      motivo: "timeout del proveedor",
      transitorio: true,
    });

    const resumen = await procesarOutbox(notificador);

    expect(resumen.reintentar).toBe(1);
    expect(estado.cierres[0].ok).toBe(false);
    // La espera es positiva: el evento vuelve a 'pendiente' con retroceso.
    expect(estado.cierres[0].espera).toBeGreaterThan(0);
    expect(estado.cierres[0].motivo).toContain("timeout");
  });

  it("no reintenta un fallo permanente", async () => {
    // Un número inválido no se arregla esperando.
    reiniciar([eventoValido()]);
    const { notificador } = notificadorFalso({
      ok: false,
      motivo: "número inexistente",
      transitorio: false,
    });

    const resumen = await procesarOutbox(notificador);

    expect(resumen.fallidos).toBe(1);
    expect(resumen.reintentar).toBe(0);
    expect(estado.cierres[0].espera).toBeNull();
  });

  it("abandona tras agotar los intentos", async () => {
    // Con 6 intentos y este retroceso se cubren más de dos horas: pasado eso el
    // fallo no es transitorio y seguir reintentando solo esconde el problema.
    reiniciar([eventoValido({ intentos: 5 })]);
    const { notificador } = notificadorFalso({
      ok: false,
      motivo: "sigue fallando",
      transitorio: true,
    });

    const resumen = await procesarOutbox(notificador);

    expect(resumen.fallidos).toBe(1);
    expect(estado.cierres[0].espera).toBeNull();
  });

  it("la espera crece con cada intento", async () => {
    const esperas: Array<number | null> = [];
    for (const intentos of [0, 1, 2]) {
      reiniciar([eventoValido({ intentos })]);
      await procesarOutbox(
        notificadorFalso({ ok: false, motivo: "x", transitorio: true }).notificador,
      );
      esperas.push(estado.cierres[0].espera);
    }
    expect(esperas[0]!).toBeLessThan(esperas[1]!);
    expect(esperas[1]!).toBeLessThan(esperas[2]!);
  });

  it("una excepción del proveedor se trata como transitoria", async () => {
    // Casi siempre es red o timeout; dar el aviso por perdido sería tirar algo que
    // el cliente espera.
    reiniciar([eventoValido()]);
    const notificador: Notificador = {
      nombre: "explota",
      async enviar() {
        throw new Error("ECONNRESET");
      },
    };

    const resumen = await procesarOutbox(notificador);

    expect(resumen.reintentar).toBe(1);
    expect(estado.cierres[0].motivo).toContain("ECONNRESET");
  });

  it("un evento que falla no detiene los demás del lote", async () => {
    reiniciar([
      eventoValido({ id: "evt-1" }),
      eventoValido({ id: "evt-2", payload: {} }),
      eventoValido({ id: "evt-3" }),
    ]);
    const { notificador } = notificadorFalso({ ok: true });

    const resumen = await procesarOutbox(notificador);

    expect(resumen.reclamados).toBe(3);
    expect(resumen.enviados).toBe(2);
    expect(resumen.descartados).toBe(1);
    expect(estado.cierres).toHaveLength(3);
  });

  it("respeta el límite del lote", async () => {
    reiniciar(Array.from({ length: 10 }, (_, i) => eventoValido({ id: `evt-${i}` })));
    const resumen = await procesarOutbox(notificadorFalso({ ok: true }).notificador, 3);
    expect(resumen.reclamados).toBe(3);
  });

  it("no hace nada con la cola vacía", async () => {
    reiniciar([]);
    const { notificador, enviados } = notificadorFalso({ ok: true });
    const resumen = await procesarOutbox(notificador);
    expect(resumen).toMatchObject({ reclamados: 0, enviados: 0 });
    expect(enviados).toHaveLength(0);
  });

  it("propaga el error si no se puede reclamar", async () => {
    // Un fallo al reclamar es de configuración o de la base: el cron debe verlo.
    reiniciar([]);
    estado.errorAlReclamar = "permission denied for function claim_outbox_events";
    await expect(procesarOutbox(notificadorFalso({ ok: true }).notificador)).rejects.toThrow(
      /no se pudo reclamar/,
    );
  });
});

describe("notificadorRegistro", () => {
  it("da el evento por bueno sin fingir que envió nada", async () => {
    // Dejarlo en la cola reintentándose para siempre solo llenaría la tabla.
    const resultado = await notificadorRegistro.enviar({
      telefono: "51987654321",
      texto: "hola",
      enlace: "https://wa.me/51987654321?text=hola",
    });
    expect(resultado.ok).toBe(true);
  });

  it("no escribe el teléfono completo en el log", async () => {
    const registro = vi.spyOn(console, "info").mockImplementation(() => {});
    await notificadorRegistro.enviar({
      telefono: "51987654321",
      texto: "hola",
      enlace: "x",
    });
    const linea = String(registro.mock.calls[0]?.[0] ?? "");
    expect(linea).not.toContain("51987654321");
    registro.mockRestore();
  });
});

describe("recuperarAtascados", () => {
  it("devuelve cuántos eventos rescató", async () => {
    reiniciar([]);
    estado.recuperados = 4;
    expect(await recuperarAtascados()).toBe(4);
  });
});
