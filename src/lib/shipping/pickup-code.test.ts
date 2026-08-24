import { describe, expect, it } from "vitest";
import {
  generatePickupCode,
  instruccionesRetiro,
  isValidPickupCode,
  LONGITUD_CLAVE_RETIRO,
  type RandomBytes,
} from "./pickup-code";

describe("isValidPickupCode", () => {
  it("acepta una clave normal", () => {
    expect(isValidPickupCode("2415").valido).toBe(true);
    expect(isValidPickupCode("9072").valido).toBe(true);
    expect(isValidPickupCode("0483").valido).toBe(true);
  });

  it("exige exactamente 4 dígitos", () => {
    expect(isValidPickupCode("241").valido).toBe(false);
    expect(isValidPickupCode("24155").valido).toBe(false);
    expect(isValidPickupCode("").valido).toBe(false);
    expect(isValidPickupCode("241").motivo).toMatch(/4 dígitos/);
  });

  it("rechaza lo que parece numérico pero no lo es", () => {
    // `" 12"` y `"1e3"` pasarían una conversión numérica y llegarían mal a Shalom.
    expect(isValidPickupCode(" 123").valido).toBe(false);
    expect(isValidPickupCode("1e35").valido).toBe(false);
    expect(isValidPickupCode("12.4").valido).toBe(false);
    expect(isValidPickupCode("-123").valido).toBe(false);
    expect(isValidPickupCode("abcd").valido).toBe(false);
  });

  it("rechaza los cuatro dígitos iguales, que Shalom no acepta", () => {
    for (let d = 0; d <= 9; d++) {
      const code = String(d).repeat(4);
      expect(isValidPickupCode(code).valido, code).toBe(false);
      expect(isValidPickupCode(code).motivo).toMatch(/iguales/);
    }
  });

  it("rechaza secuencias consecutivas ascendentes", () => {
    for (const code of ["0123", "1234", "3456", "6789"]) {
      expect(isValidPickupCode(code).valido, code).toBe(false);
      expect(isValidPickupCode(code).motivo).toMatch(/consecutivos/);
    }
  });

  it("rechaza secuencias consecutivas descendentes", () => {
    for (const code of ["9876", "4321", "3210", "6543"]) {
      expect(isValidPickupCode(code).valido, code).toBe(false);
    }
  });

  it("acepta el envolvente 9012, que Shalom no rechaza", () => {
    // Excluirlo reduciría el espacio de claves sin ganar seguridad.
    expect(isValidPickupCode("9012").valido).toBe(true);
    expect(isValidPickupCode("0987").valido).toBe(true);
  });

  it("acepta casi-secuencias que no son consecutivas de verdad", () => {
    expect(isValidPickupCode("1235").valido).toBe(true);
    expect(isValidPickupCode("1243").valido).toBe(true);
    expect(isValidPickupCode("1224").valido).toBe(true);
    expect(isValidPickupCode("2468").valido).toBe(true);
  });

  it("hay exactamente 24 claves inválidas de las 10 000 posibles", () => {
    // 10 repetidas + 7 ascendentes + 7 descendentes.
    let invalidas = 0;
    for (let n = 0; n < 10_000; n++) {
      if (!isValidPickupCode(String(n).padStart(4, "0")).valido) invalidas++;
    }
    expect(invalidas).toBe(24);
  });
});

describe("generatePickupCode", () => {
  it("genera 10 000 claves y ninguna es repetida ni consecutiva", () => {
    for (let i = 0; i < 10_000; i++) {
      const code = generatePickupCode();
      const validacion = isValidPickupCode(code);
      expect(validacion.valido, `${code}: ${validacion.motivo ?? ""}`).toBe(true);
    }
  });

  it("siempre devuelve la longitud que exige Shalom", () => {
    for (let i = 0; i < 500; i++) {
      expect(generatePickupCode()).toHaveLength(LONGITUD_CLAVE_RETIRO);
    }
  });

  it("no es predecible: 2 000 claves cubren buena parte del espacio", () => {
    // Si fuera derivada del pedido o secuencial, la variedad sería mucho menor.
    const vistas = new Set<string>();
    for (let i = 0; i < 2_000; i++) vistas.add(generatePickupCode());
    expect(vistas.size).toBeGreaterThan(1_500);
  });

  it("reparte los dígitos sin sesgo de módulo apreciable", () => {
    // `byte % 10` sesgaría: 0..5 saldrían con probabilidad 26/256 y 6..9 con
    // 25/256. Con rechazo por muestreo el reparto es uniforme.
    const conteo = new Array<number>(10).fill(0);
    for (let i = 0; i < 5_000; i++) {
      for (const ch of generatePickupCode()) conteo[Number(ch)]++;
    }
    const esperado = 20_000 / 10;
    for (let d = 0; d <= 9; d++) {
      // Margen amplio: el test comprueba ausencia de sesgo estructural, no la
      // aleatoriedad exacta de la plataforma.
      expect(conteo[d], `dígito ${d}`).toBeGreaterThan(esperado * 0.85);
      expect(conteo[d], `dígito ${d}`).toBeLessThan(esperado * 1.15);
    }
  });

  it("falla ruidosamente si la fuente de aleatoriedad está rota", () => {
    // Un `random` que siempre devuelve lo mismo produciría "0000" para siempre.
    // Es mejor un error que colgar el proceso o emitir una clave que Shalom
    // rechazará con un 422 tras 150 s.
    const siempreCero: RandomBytes = (buffer) => buffer.fill(0);
    expect(() => generatePickupCode(siempreCero)).toThrow(/no es aleatoria/);
  });

  it("descarta el candidato inválido y sigue con el siguiente", () => {
    // Primero fuerza "1234" (consecutiva, debe rechazarse) y luego "7777"... y
    // finalmente una válida. Verifica que el bucle reintenta en vez de rendirse.
    const secuencia = [1, 2, 3, 4, 2, 4, 1, 5];
    let i = 0;
    const guionizado: RandomBytes = (buffer) => {
      buffer[0] = secuencia[i % secuencia.length];
      i++;
    };
    expect(generatePickupCode(guionizado)).toBe("2415");
  });
});

describe("instruccionesRetiro", () => {
  it("incluye la clave, la agencia y el aviso de no compartirla", () => {
    const texto = instruccionesRetiro("2415", "Arequipa");
    expect(texto).toContain("2415");
    expect(texto).toContain("Arequipa");
    expect(texto).toContain("DNI");
    // El aviso es parte de la seguridad de la clave, no de la redacción.
    expect(texto).toMatch(/no la compartas/i);
  });
});
