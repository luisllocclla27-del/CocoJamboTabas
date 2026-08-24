import { describe, expect, it } from "vitest";
import {
  construirMensaje,
  debeAbandonar,
  esperaReintentoMs,
  esTipoConocido,
  MAX_INTENTOS_OUTBOX,
  normalizarTelefono,
} from "./messages";

const TELEFONO = "987654321";
const REF = "COCO-7F3K2M";

describe("normalizarTelefono", () => {
  it("añade el prefijo país a un celular peruano", () => {
    expect(normalizarTelefono("987654321")).toBe("51987654321");
  });

  it("acepta las formas en que la gente lo escribe", () => {
    for (const valor of ["987 654 321", "987-654-321", "+51 987654321", "(987) 654321"]) {
      expect(normalizarTelefono(valor), valor).toBe("51987654321");
    }
  });

  it("no duplica el prefijo si ya viene", () => {
    expect(normalizarTelefono("51987654321")).toBe("51987654321");
  });

  it("devuelve null ante algo que no es un celular peruano", () => {
    // Un null explícito permite marcar el evento como fallido con motivo, en vez de
    // darlo por enviado a un número inexistente.
    for (const valor of ["12345", "887654321", "", "no-es-numero", null, undefined, 987654321]) {
      expect(normalizarTelefono(valor), String(valor)).toBeNull();
    }
  });
});

describe("esTipoConocido", () => {
  it("reconoce los tipos que se encolan", () => {
    for (const tipo of [
      "whatsapp_comprobante_recibido",
      "whatsapp_pago_aprobado",
      "whatsapp_pago_rechazado",
      "whatsapp_pedido_enviado",
      "restock_aviso",
    ]) {
      expect(esTipoConocido(tipo), tipo).toBe(true);
    }
  });

  it("no reconoce un tipo inventado", () => {
    expect(esTipoConocido("email_bienvenida")).toBe(false);
  });
});

describe("construirMensaje", () => {
  it("redacta la aprobación del pago con enlace de seguimiento", () => {
    const mensaje = construirMensaje("whatsapp_pago_aprobado", {
      telefono: TELEFONO,
      reference: REF,
    });
    expect(mensaje).not.toBeNull();
    expect(mensaje!.texto).toContain(REF);
    expect(mensaje!.texto).toMatch(/confirmamos tu pago/i);
    expect(mensaje!.telefono).toBe("51987654321");
    expect(mensaje!.enlace).toContain("wa.me/51987654321");
  });

  it("incluye el motivo en el rechazo", () => {
    // Un rechazo sin explicación genera un reclamo que cuesta más que escribirlo.
    const mensaje = construirMensaje("whatsapp_pago_rechazado", {
      telefono: TELEFONO,
      reference: REF,
      motivo: "El monto no coincide con el del pedido.",
    });
    expect(mensaje!.texto).toContain("El monto no coincide");
  });

  it("funciona sin motivo, sin dejar el texto a medias", () => {
    const mensaje = construirMensaje("whatsapp_pago_rechazado", {
      telefono: TELEFONO,
      reference: REF,
    });
    expect(mensaje!.texto).not.toContain("undefined");
    expect(mensaje!.texto).not.toContain("null");
  });

  it("el aviso de envío lleva guía, agencia y clave con su advertencia", () => {
    const mensaje = construirMensaje("whatsapp_pedido_enviado", {
      telefono: TELEFONO,
      reference: REF,
      guia: "80574902",
      clave_retiro: "2415",
      agencia: "Arequipa",
    });
    expect(mensaje!.texto).toContain("80574902");
    expect(mensaje!.texto).toContain("Arequipa");
    expect(mensaje!.texto).toContain("2415");
    // La advertencia es parte de la seguridad de la clave, no del estilo.
    expect(mensaje!.texto).toMatch(/no la compartas/i);
    expect(mensaje!.texto).toMatch(/DNI/);
  });

  it("el envío sin guía no se manda: es el dato central del mensaje", () => {
    expect(
      construirMensaje("whatsapp_pedido_enviado", { telefono: TELEFONO, reference: REF }),
    ).toBeNull();
  });

  it("el aviso de restock nombra modelo y talla", () => {
    const mensaje = construirMensaje("restock_aviso", {
      telefono: TELEFONO,
      reference: REF,
      modelo: "Chuck 70",
      size_us: 9.5,
      price_cents: 27900,
    });
    expect(mensaje!.texto).toContain("Chuck 70");
    expect(mensaje!.texto).toContain("US 9.5");
    expect(mensaje!.texto).toContain("S/ 279.00");
  });

  it("formatea las tallas enteras sin decimal de más", () => {
    const mensaje = construirMensaje("restock_aviso", {
      telefono: TELEFONO,
      reference: REF,
      modelo: "Old Skool",
      size_us: 9,
    });
    expect(mensaje!.texto).toContain("US 9.");
    expect(mensaje!.texto).not.toContain("US 9.0");
  });

  it("devuelve null sin teléfono o sin referencia", () => {
    expect(construirMensaje("whatsapp_pago_aprobado", { reference: REF })).toBeNull();
    expect(construirMensaje("whatsapp_pago_aprobado", { telefono: TELEFONO })).toBeNull();
  });

  it("devuelve null ante un tipo desconocido", () => {
    expect(
      construirMensaje("tipo_que_no_existe", { telefono: TELEFONO, reference: REF }),
    ).toBeNull();
  });

  it("ningún mensaje contiene marcadores sin resolver", () => {
    const casos: Array<[string, Record<string, unknown>]> = [
      ["whatsapp_comprobante_recibido", { telefono: TELEFONO, reference: REF }],
      ["whatsapp_pago_aprobado", { telefono: TELEFONO, reference: REF }],
      ["whatsapp_pago_rechazado", { telefono: TELEFONO, reference: REF, motivo: "x" }],
      [
        "whatsapp_pedido_enviado",
        { telefono: TELEFONO, reference: REF, guia: "1", clave_retiro: "2415", agencia: "Lima" },
      ],
      ["restock_aviso", { telefono: TELEFONO, reference: REF, modelo: "Samba", size_us: 10 }],
    ];
    for (const [tipo, payload] of casos) {
      const mensaje = construirMensaje(tipo, payload);
      expect(mensaje, tipo).not.toBeNull();
      expect(mensaje!.texto, tipo).not.toMatch(/undefined|null|NaN|\{\{/);
    }
  });

  it("el enlace de WhatsApp escapa el texto correctamente", () => {
    const mensaje = construirMensaje("whatsapp_pago_rechazado", {
      telefono: TELEFONO,
      reference: REF,
      motivo: "El monto & la fecha no coinciden ¿puedes revisarlo?",
    });
    // Sin escapar, el `&` cortaría el parámetro y el mensaje llegaría truncado.
    expect(mensaje!.enlace).not.toContain("& la fecha");
    expect(decodeURIComponent(mensaje!.enlace)).toContain("& la fecha");
  });
});

describe("reintentos", () => {
  it("crece exponencialmente desde un minuto", () => {
    expect(esperaReintentoMs(0)).toBe(60_000);
    expect(esperaReintentoMs(1)).toBe(120_000);
    expect(esperaReintentoMs(2)).toBe(240_000);
  });

  it("se topa en una hora", () => {
    // Sin tope, un evento con muchos fallos quedaría programado para dentro de días.
    expect(esperaReintentoMs(20)).toBe(60 * 60_000);
  });

  it("tolera un contador negativo", () => {
    expect(esperaReintentoMs(-3)).toBe(60_000);
  });

  it("abandona tras el máximo de intentos", () => {
    expect(debeAbandonar(MAX_INTENTOS_OUTBOX - 1)).toBe(false);
    expect(debeAbandonar(MAX_INTENTOS_OUTBOX)).toBe(true);
    expect(debeAbandonar(MAX_INTENTOS_OUTBOX + 5)).toBe(true);
  });
});
