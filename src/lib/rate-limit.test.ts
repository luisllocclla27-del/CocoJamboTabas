import { beforeEach, describe, expect, it } from "vitest";
import {
  consumir,
  identificarPeticion,
  mensajeLimite,
  REGLAS,
  reiniciarLimites,
} from "./rate-limit";

beforeEach(() => {
  reiniciarLimites();
});

describe("consumir", () => {
  it("permite hasta el máximo y bloquea el siguiente", () => {
    const { maximo } = REGLAS.seguimiento;
    for (let i = 0; i < maximo; i++) {
      expect(consumir("seguimiento", "1.1.1.1").permitido, `intento ${i + 1}`).toBe(true);
    }
    expect(consumir("seguimiento", "1.1.1.1").permitido).toBe(false);
  });

  it("cuenta hacia atrás las peticiones restantes", () => {
    const { maximo } = REGLAS.crearPedido;
    expect(consumir("crearPedido", "1.1.1.1").restantes).toBe(maximo - 1);
    expect(consumir("crearPedido", "1.1.1.1").restantes).toBe(maximo - 2);
  });

  it("aísla el cupo por identificador", () => {
    // El límite de un visitante no puede afectar a otro.
    const { maximo } = REGLAS.crearPedido;
    for (let i = 0; i < maximo; i++) consumir("crearPedido", "1.1.1.1");
    expect(consumir("crearPedido", "1.1.1.1").permitido).toBe(false);
    expect(consumir("crearPedido", "2.2.2.2").permitido).toBe(true);
  });

  it("aísla el cupo por regla", () => {
    // Gastar el cupo de seguimiento no debe impedir comprar.
    for (let i = 0; i < REGLAS.seguimiento.maximo; i++) consumir("seguimiento", "1.1.1.1");
    expect(consumir("seguimiento", "1.1.1.1").permitido).toBe(false);
    expect(consumir("crearPedido", "1.1.1.1").permitido).toBe(true);
  });

  it("libera el cupo al salir de la ventana", () => {
    const base = 1_000_000;
    const { maximo, ventanaMs } = REGLAS.seguimiento;
    for (let i = 0; i < maximo; i++) consumir("seguimiento", "1.1.1.1", base);
    expect(consumir("seguimiento", "1.1.1.1", base).permitido).toBe(false);
    // Justo después de la ventana, vuelve a estar disponible.
    expect(consumir("seguimiento", "1.1.1.1", base + ventanaMs + 1).permitido).toBe(true);
  });

  it("es una ventana deslizante, no un contador por intervalo fijo", () => {
    // Con intervalos fijos se podría gastar el cupo al final de una ventana y otra
    // vez al principio de la siguiente, duplicando el límite real.
    const base = 1_000_000;
    const { maximo, ventanaMs } = REGLAS.seguimiento;

    // Gasta todo el cupo al final de la ventana.
    for (let i = 0; i < maximo; i++) consumir("seguimiento", "1.1.1.1", base + ventanaMs - 100);

    // Un instante después NO hay cupo nuevo: las peticiones siguen dentro de la
    // ventana deslizante.
    expect(consumir("seguimiento", "1.1.1.1", base + ventanaMs + 50).permitido).toBe(false);
  });

  it("un reintento bloqueado no renueva la ventana", () => {
    // Si cada intento fallido contara, un cliente insistente nunca saldría del
    // bloqueo.
    const base = 1_000_000;
    const { maximo, ventanaMs } = REGLAS.crearPedido;
    for (let i = 0; i < maximo; i++) consumir("crearPedido", "1.1.1.1", base);

    // Insiste durante toda la ventana.
    for (let t = 0; t < ventanaMs; t += 1000) {
      consumir("crearPedido", "1.1.1.1", base + t);
    }
    // Al vencer la ventana original, queda libre igualmente.
    expect(consumir("crearPedido", "1.1.1.1", base + ventanaMs + 1).permitido).toBe(true);
  });

  it("indica cuántos segundos hay que esperar", () => {
    const base = 1_000_000;
    const { maximo, ventanaMs } = REGLAS.crearPedido;
    for (let i = 0; i < maximo; i++) consumir("crearPedido", "1.1.1.1", base);

    const resultado = consumir("crearPedido", "1.1.1.1", base + 1000);
    expect(resultado.permitido).toBe(false);
    expect(resultado.esperaSegundos).toBeGreaterThan(0);
    expect(resultado.esperaSegundos).toBeLessThanOrEqual(ventanaMs / 1000);
  });

  it("la espera nunca es 0 cuando está bloqueado", () => {
    // Un 0 se leería como "reintenta ya" y produciría un bucle.
    const base = 1_000_000;
    const { maximo, ventanaMs } = REGLAS.seguimiento;
    for (let i = 0; i < maximo; i++) consumir("seguimiento", "1.1.1.1", base);
    const resultado = consumir("seguimiento", "1.1.1.1", base + ventanaMs - 1);
    expect(resultado.permitido).toBe(false);
    expect(resultado.esperaSegundos).toBeGreaterThanOrEqual(1);
  });
});

describe("protección de los céntimos identificadores", () => {
  it("un bot no puede crear 99 pedidos y agotar el espacio", () => {
    // Es la denegación de servicio más barata contra este diseño: ocupar los 99
    // céntimos identificadores deja el checkout inservible sin tumbar nada.
    let permitidos = 0;
    for (let i = 0; i < 99; i++) {
      if (consumir("crearPedido", "1.1.1.1").permitido) permitidos++;
    }
    expect(permitidos).toBe(REGLAS.crearPedido.maximo);
    expect(permitidos).toBeLessThan(99);
  });
});

describe("protección contra enumeración de pedidos", () => {
  it("el límite hace impracticable la fuerza bruta sobre las referencias", () => {
    // 28^6 combinaciones con 20 intentos por minuto: el argumento de seguridad de
    // `reference.ts` depende de este límite.
    let permitidos = 0;
    for (let i = 0; i < 500; i++) {
      if (consumir("seguimiento", "atacante").permitido) permitidos++;
    }
    expect(permitidos).toBe(REGLAS.seguimiento.maximo);
  });
});

describe("identificarPeticion", () => {
  it("toma la primera IP de x-forwarded-for", () => {
    // El resto de la cadena son proxies; la primera es el cliente.
    const headers = new Headers({ "x-forwarded-for": "203.0.113.5, 70.41.3.18, 150.172.238.178" });
    expect(identificarPeticion(headers)).toBe("203.0.113.5");
  });

  it("no permite fabricar identidades añadiendo valores a la cabecera", () => {
    // Usar la cabecera completa daría una identidad nueva en cada petición.
    const a = identificarPeticion(new Headers({ "x-forwarded-for": "203.0.113.5" }));
    const b = identificarPeticion(new Headers({ "x-forwarded-for": "203.0.113.5, 1.2.3.4" }));
    const c = identificarPeticion(new Headers({ "x-forwarded-for": "203.0.113.5, 9.9.9.9" }));
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("cae a x-real-ip cuando no hay forwarded", () => {
    expect(identificarPeticion(new Headers({ "x-real-ip": "198.51.100.7" }))).toBe("198.51.100.7");
  });

  it("devuelve 'local' sin cabeceras de proxy", () => {
    expect(identificarPeticion(new Headers())).toBe("local");
  });

  it("ignora cabeceras vacías", () => {
    expect(identificarPeticion(new Headers({ "x-forwarded-for": "   " }))).toBe("local");
  });
});

describe("mensajeLimite", () => {
  it("no menciona segundos exactos en esperas cortas", () => {
    expect(mensajeLimite(30)).toMatch(/unos segundos/);
  });

  it("da los minutos en esperas largas", () => {
    expect(mensajeLimite(600)).toMatch(/10 minutos/);
    expect(mensajeLimite(120)).toMatch(/2 minutos/);
  });

  it("usa el singular con un minuto", () => {
    expect(mensajeLimite(95)).toMatch(/2 minutos/);
    expect(mensajeLimite(91)).toContain("minutos");
  });

  it("nunca expone jerga técnica", () => {
    for (const segundos of [5, 60, 300, 900]) {
      const mensaje = mensajeLimite(segundos);
      expect(mensaje).not.toMatch(/rate|limit|429|throttl/i);
    }
  });
});
