import { describe, expect, it } from "vitest";
import {
  DESCRIPCION_HITO,
  formatearFechaPeru,
  fusionarTracking,
  normalizarStatus,
  normalizarTimeline,
  parsearFechaHoraPeru,
  parsearFechaPeru,
  PERU_UTC_OFFSET_MINUTOS,
  trackingVacio,
  type ShalomStatus,
  type ShalomTimelineEntry,
} from "./tracking-normalizer";

/**
 * `status` de un envío entregado, tal como lo devuelve `GET /v1/tracking`.
 * Los hitos que no ocurrieron llegan en `null`: es el caso normal, no un error.
 */
const STATUS_ENTREGADO: ShalomStatus = {
  registrado: { fecha: "2026-04-15 09:12:30" },
  origen: { fecha: "2026-04-15 09:12:30" },
  transito: {
    fecha: "2026-04-15 14:08:21",
    completo: true,
    cargueros: ["964724", "966345"],
    carguero: "966345",
  },
  demora: null,
  destino: { fecha: "2026-04-16 01:01:03", completo: true },
  entregado: { fecha: "2026-04-16 11:40:45" },
  reparto: null,
};

describe("parsearFechaPeru", () => {
  it("interpreta la fecha como hora de Perú y no como UTC", () => {
    // El bug que este módulo existe para evitar: leerla como UTC mostraría el
    // evento a las 06:40 de Perú, cinco horas antes de que ocurriera.
    const fecha = parsearFechaPeru("2026-04-16 11:40:45");
    expect(fecha).not.toBeNull();
    expect(fecha!.toISOString()).toBe("2026-04-16T16:40:45.000Z");
  });

  it("el offset de Perú es -300 minutos y no cambia por horario de verano", () => {
    expect(PERU_UTC_OFFSET_MINUTOS).toBe(-300);
    // Enero y julio dan el mismo desplazamiento: Perú no aplica DST.
    const enero = parsearFechaPeru("2026-01-15 12:00:00")!;
    const julio = parsearFechaPeru("2026-07-15 12:00:00")!;
    expect(enero.getUTCHours()).toBe(17);
    expect(julio.getUTCHours()).toBe(17);
  });

  it("acepta el separador T además del espacio", () => {
    expect(parsearFechaPeru("2026-04-16T11:40:45")!.toISOString()).toBe(
      "2026-04-16T16:40:45.000Z",
    );
  });

  it("tolera segundos ausentes", () => {
    expect(parsearFechaPeru("2026-04-16 11:40")!.toISOString()).toBe(
      "2026-04-16T16:40:00.000Z",
    );
  });

  it("devuelve null en vez de una fecha inválida que envenene el ordenamiento", () => {
    expect(parsearFechaPeru("")).toBeNull();
    expect(parsearFechaPeru("no es una fecha")).toBeNull();
    expect(parsearFechaPeru("2026-04-16")).toBeNull();
    expect(parsearFechaPeru("16/04/2026 11:40:45")).toBeNull();
  });

  it("rechaza fechas imposibles que Date.UTC normalizaría en silencio", () => {
    // Sin la comprobación de ida y vuelta, el 30 de febrero se convertiría en
    // el 2 de marzo y el hito aparecería en un día que no ocurrió.
    expect(parsearFechaPeru("2026-02-30 10:00:00")).toBeNull();
    expect(parsearFechaPeru("2026-04-31 10:00:00")).toBeNull();
    expect(parsearFechaPeru("2026-13-01 10:00:00")).toBeNull();
    expect(parsearFechaPeru("2026-04-16 25:00:00")).toBeNull();
  });

  it("acepta el 29 de febrero de un año bisiesto", () => {
    expect(parsearFechaPeru("2028-02-29 10:00:00")).not.toBeNull();
  });
});

describe("parsearFechaHoraPeru", () => {
  it("combina los campos separados que manda el webhook", () => {
    expect(parsearFechaHoraPeru("2026-07-30", "10:05")!.toISOString()).toBe(
      "2026-07-30T15:05:00.000Z",
    );
  });

  it("asume medianoche de Perú cuando falta la hora", () => {
    // Pierde precisión horaria pero ordena el evento en el día correcto.
    expect(parsearFechaHoraPeru("2026-07-30", null)!.toISOString()).toBe(
      "2026-07-30T05:00:00.000Z",
    );
    expect(parsearFechaHoraPeru("2026-07-30")!.toISOString()).toBe(
      "2026-07-30T05:00:00.000Z",
    );
    expect(parsearFechaHoraPeru("2026-07-30", "  ")!.toISOString()).toBe(
      "2026-07-30T05:00:00.000Z",
    );
  });

  it("acepta una fecha ya completa en el campo fecha", () => {
    expect(parsearFechaHoraPeru("2026-07-30 10:05:00")!.toISOString()).toBe(
      "2026-07-30T15:05:00.000Z",
    );
  });

  it("devuelve null si la hora está malformada", () => {
    expect(parsearFechaHoraPeru("2026-07-30", "10h05")).toBeNull();
  });
});

describe("formatearFechaPeru", () => {
  it("devuelve el instante a hora de Perú, revirtiendo el parseo", () => {
    const fecha = parsearFechaPeru("2026-04-16 11:40:45")!;
    expect(formatearFechaPeru(fecha)).toBe("2026-04-16 11:40");
  });

  it("no depende de la zona horaria del servidor", () => {
    // Se construye el instante desde UTC explícito: el resultado debe ser hora
    // de Perú aunque el proceso corra en cualquier TZ.
    expect(formatearFechaPeru(new Date("2026-04-16T16:40:45.000Z"))).toBe("2026-04-16 11:40");
  });

  it("cruza el cambio de día hacia atrás correctamente", () => {
    // 02:00 UTC son las 21:00 del día anterior en Perú.
    expect(formatearFechaPeru(new Date("2026-04-16T02:00:00.000Z"))).toBe("2026-04-15 21:00");
  });
});

describe("normalizarStatus", () => {
  it("omite los hitos en null, que son el caso mayoritario", () => {
    const estado = normalizarStatus(STATUS_ENTREGADO);
    // 7 hitos, 2 en null: quedan 5.
    expect(estado.eventos).toHaveLength(5);
    expect(estado.eventos.map((e) => e.milestone)).not.toContain("demora");
    expect(estado.eventos.map((e) => e.milestone)).not.toContain("reparto");
  });

  it("no falla con un envío recién registrado, con 6 de 7 hitos en null", () => {
    const estado = normalizarStatus({
      registrado: { fecha: "2026-04-15 09:12:30" },
      origen: null,
      transito: null,
      demora: null,
      destino: null,
      entregado: null,
      reparto: null,
    });
    expect(estado.eventos).toHaveLength(1);
    expect(estado.ultimoHito).toBe("registrado");
    expect(estado.entregado).toBe(false);
  });

  it("devuelve un estado vacío si status es null o undefined", () => {
    expect(normalizarStatus(null).eventos).toHaveLength(0);
    expect(normalizarStatus(undefined).ultimoHito).toBeNull();
  });

  it("ordena cronológicamente ascendente", () => {
    const estado = normalizarStatus(STATUS_ENTREGADO);
    const tiempos = estado.eventos.map((e) => e.fecha.getTime());
    expect(tiempos).toEqual([...tiempos].sort((a, b) => a - b));
  });

  it("desempata por el orden canónico del flujo cuando dos hitos comparten fecha", () => {
    // `registrado` y `origen` caen en el mismo segundo en el caso real. Sin
    // desempate, el orden dependería del orden de claves del JSON y la línea de
    // tiempo podría mostrar "recibido en origen" antes de "registrado".
    const estado = normalizarStatus({
      origen: { fecha: "2026-04-15 09:12:30" },
      registrado: { fecha: "2026-04-15 09:12:30" },
    });
    expect(estado.eventos.map((e) => e.milestone)).toEqual(["registrado", "origen"]);
  });

  it("descarta hitos con fecha impareseable sin romper el resto", () => {
    const estado = normalizarStatus({
      registrado: { fecha: "2026-04-15 09:12:30" },
      origen: { fecha: "basura" },
      transito: { fecha: "" },
      destino: { fecha: "   " },
    });
    expect(estado.eventos.map((e) => e.milestone)).toEqual(["registrado"]);
  });

  it("añade el carguero a la descripción de tránsito", () => {
    // Es el dato que más preguntan por WhatsApp: con qué empresa va el paquete.
    const transito = normalizarStatus(STATUS_ENTREGADO).eventos.find(
      (e) => e.milestone === "transito",
    );
    expect(transito!.descripcion).toContain("966345");
  });

  it("cae a la lista de cargueros cuando no viene el último", () => {
    const estado = normalizarStatus({
      transito: { fecha: "2026-04-15 14:08:21", cargueros: ["964724", "966345"] },
    });
    expect(estado.eventos[0].descripcion).toContain("964724, 966345");
  });

  it("usa la descripción base cuando no hay carguero", () => {
    const estado = normalizarStatus({ transito: { fecha: "2026-04-15 14:08:21" } });
    expect(estado.eventos[0].descripcion).toBe(DESCRIPCION_HITO.transito);
  });

  it("asume completo cuando Shalom no lo reporta", () => {
    // El hito llegó con fecha, así que ocurrió. Asumir `false` pintaría la línea
    // de tiempo a medias sin evidencia de que lo esté.
    const estado = normalizarStatus({ registrado: { fecha: "2026-04-15 09:12:30" } });
    expect(estado.eventos[0].completo).toBe(true);
  });

  it("respeta completo cuando sí viene", () => {
    const estado = normalizarStatus({
      transito: { fecha: "2026-04-15 14:08:21", completo: false },
    });
    expect(estado.eventos[0].completo).toBe(false);
  });
});

describe("estado derivado", () => {
  it("marca entregado cuando existe el hito", () => {
    const estado = normalizarStatus(STATUS_ENTREGADO);
    expect(estado.entregado).toBe(true);
    expect(estado.ultimoHito).toBe("entregado");
  });

  it("ultimoHito es el más avanzado del flujo, no el más reciente por fecha", () => {
    // Shalom a veces registra `destino` con fecha POSTERIOR a `entregado` porque
    // la agencia cierra los registros al final del día. Retroceder de "entregado"
    // a "en agencia de destino" confundiría al cliente.
    const estado = normalizarStatus({
      entregado: { fecha: "2026-04-16 11:40:45" },
      destino: { fecha: "2026-04-16 23:59:00" },
    });
    expect(estado.eventos[estado.eventos.length - 1].milestone).toBe("destino");
    expect(estado.ultimoHito).toBe("entregado");
    expect(estado.entregado).toBe(true);
  });

  it("enReparto es true solo mientras no se haya entregado", () => {
    const enCamino = normalizarStatus({
      destino: { fecha: "2026-04-16 01:01:03" },
      reparto: { fecha: "2026-04-16 09:00:00" },
    });
    expect(enCamino.enReparto).toBe(true);

    // Los hitos son acumulativos en Shalom: `reparto` sigue presente tras la
    // entrega, pero el paquete ya no está en reparto.
    const entregado = normalizarStatus({
      reparto: { fecha: "2026-04-16 09:00:00" },
      entregado: { fecha: "2026-04-16 11:40:45" },
    });
    expect(entregado.enReparto).toBe(false);
  });

  it("conDemora se considera resuelta al llegar a destino o entregarse", () => {
    const activa = normalizarStatus({
      transito: { fecha: "2026-04-15 14:08:21" },
      demora: { fecha: "2026-04-15 18:00:00" },
    });
    expect(activa.conDemora).toBe(true);

    // Mantener la alerta alarmaría al cliente sobre un problema ya pasado.
    const resuelta = normalizarStatus({
      demora: { fecha: "2026-04-15 18:00:00" },
      destino: { fecha: "2026-04-16 01:01:03" },
    });
    expect(resuelta.conDemora).toBe(false);
  });

  it("un estado vacío no está entregado ni tiene último hito", () => {
    const vacio = trackingVacio();
    expect(vacio.entregado).toBe(false);
    expect(vacio.enReparto).toBe(false);
    expect(vacio.conDemora).toBe(false);
    expect(vacio.ultimoHito).toBeNull();
    expect(vacio.eventos).toHaveLength(0);
  });
});

describe("normalizarTimeline", () => {
  const TIMELINE: readonly ShalomTimelineEntry[] = [
    {
      milestone: "registrado",
      fecha: "2026-07-28",
      hora: "09:12",
      descripcion: "Registrado en agencia origen",
      completo: true,
    },
    {
      milestone: "transito",
      fecha: "2026-07-29",
      hora: "14:30",
      descripcion: "En tránsito",
      completo: true,
    },
    {
      milestone: "destino",
      fecha: "2026-07-30",
      hora: "10:05",
      descripcion: "En agencia destino",
      completo: false,
    },
  ];

  it("produce el mismo tipo de estado que normalizarStatus", () => {
    const estado = normalizarTimeline(TIMELINE);
    expect(estado.eventos.map((e) => e.milestone)).toEqual([
      "registrado",
      "transito",
      "destino",
    ]);
    expect(estado.ultimoHito).toBe("destino");
    expect(estado.entregado).toBe(false);
  });

  it("interpreta fecha y hora separadas como hora de Perú", () => {
    const estado = normalizarTimeline(TIMELINE);
    expect(estado.eventos[2].fecha.toISOString()).toBe("2026-07-30T15:05:00.000Z");
  });

  it("conserva la descripción de Shalom cuando la manda", () => {
    expect(normalizarTimeline(TIMELINE).eventos[0].descripcion).toBe(
      "Registrado en agencia origen",
    );
  });

  it("cae a la descripción propia cuando llega vacía", () => {
    const estado = normalizarTimeline([
      { milestone: "entregado", fecha: "2026-07-30", hora: "11:40", descripcion: "  " },
    ]);
    expect(estado.eventos[0].descripcion).toBe(DESCRIPCION_HITO.entregado);
  });

  it("descarta hitos desconocidos en vez de fallar", () => {
    // Si Shalom añade un octavo hito, devolver un 500 haría que el wrapper
    // reintentara para siempre y la suscripción expirara a los 21 días.
    const estado = normalizarTimeline([
      { milestone: "registrado", fecha: "2026-07-28", hora: "09:12" },
      { milestone: "hito_nuevo_de_shalom", fecha: "2026-07-29", hora: "10:00" },
    ]);
    expect(estado.eventos.map((e) => e.milestone)).toEqual(["registrado"]);
  });

  it("deduplica el mismo hito conservando la aparición más reciente", () => {
    // El webhook reenvía el timeline completo en cada evento; al fusionar es fácil
    // acabar con `transito` repetido.
    const estado = normalizarTimeline([
      { milestone: "transito", fecha: "2026-07-29", hora: "10:00", completo: false },
      { milestone: "transito", fecha: "2026-07-29", hora: "18:00", completo: true },
    ]);
    expect(estado.eventos).toHaveLength(1);
    expect(estado.eventos[0].completo).toBe(true);
    expect(estado.eventos[0].fecha.toISOString()).toBe("2026-07-29T23:00:00.000Z");
  });

  it("acepta null, undefined y un array vacío", () => {
    expect(normalizarTimeline(null).eventos).toHaveLength(0);
    expect(normalizarTimeline(undefined).eventos).toHaveLength(0);
    expect(normalizarTimeline([]).eventos).toHaveLength(0);
  });
});

describe("fusionarTracking", () => {
  it("no pierde hitos: la línea de tiempo del cliente nunca da marcha atrás", () => {
    // El webhook trajo hasta tránsito; un GET posterior trae la entrega. Si al
    // refrescar se perdieran hitos, el cliente vería su pedido "retroceder".
    const delWebhook = normalizarTimeline([
      { milestone: "registrado", fecha: "2026-07-28", hora: "09:12" },
      { milestone: "transito", fecha: "2026-07-29", hora: "14:30" },
    ]);
    const delGet = normalizarStatus({
      transito: { fecha: "2026-07-29 14:30:00" },
      destino: { fecha: "2026-07-30 01:01:03" },
      entregado: { fecha: "2026-07-30 11:40:45" },
    });

    const fusionado = fusionarTracking(delWebhook, delGet);
    expect(fusionado.eventos.map((e) => e.milestone)).toEqual([
      "registrado",
      "transito",
      "destino",
      "entregado",
    ]);
    expect(fusionado.entregado).toBe(true);
  });

  it("es conmutativa en cuanto al conjunto de hitos resultante", () => {
    const a = normalizarStatus({ registrado: { fecha: "2026-07-28 09:12:00" } });
    const b = normalizarStatus({ entregado: { fecha: "2026-07-30 11:40:45" } });
    expect(fusionarTracking(a, b).eventos.map((e) => e.milestone)).toEqual(
      fusionarTracking(b, a).eventos.map((e) => e.milestone),
    );
  });

  it("fusionar con un estado vacío no cambia nada", () => {
    const estado = normalizarStatus(STATUS_ENTREGADO);
    const fusionado = fusionarTracking(estado, trackingVacio());
    expect(fusionado.eventos).toHaveLength(estado.eventos.length);
    expect(fusionado.entregado).toBe(true);
  });

  it("fusionar consigo mismo es idempotente", () => {
    const estado = normalizarStatus(STATUS_ENTREGADO);
    expect(fusionarTracking(estado, estado).eventos).toHaveLength(estado.eventos.length);
  });
});
