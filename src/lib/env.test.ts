import { describe, expect, it } from "vitest";
import { getPublicEnv, hasServiceRole, isSupabaseConfigured } from "./env";

/**
 * Los módulos de entorno cachean su resultado, así que estos tests trabajan sobre
 * `process.env` antes de la primera lectura y comprueban lo que se puede comprobar
 * sin recargar el módulo: la normalización de la URL y los helpers de presencia.
 */

const URL_BASE = "https://wynenslfkwurmwtvyndk.supabase.co";

describe("normalización de NEXT_PUBLIC_SUPABASE_URL", () => {
  it("recorta el endpoint REST al origen", () => {
    // El panel de Supabase muestra el endpoint completo en varios sitios y es
    // natural copiar ese. Sin recortarlo, el cliente pediría `/rest/v1//rest/v1/...`
    // y devolvería 404 con un mensaje que no apunta a la causa.
    process.env.NEXT_PUBLIC_SUPABASE_URL = `${URL_BASE}/rest/v1/`;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "sb_publishable_clave_de_prueba_1234567890";
    process.env.NEXT_PUBLIC_SITE_URL = "http://localhost:3000";

    expect(getPublicEnv().NEXT_PUBLIC_SUPABASE_URL).toBe(URL_BASE);
  });
});

describe("isSupabaseConfigured", () => {
  it("es true con url y clave presentes", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = URL_BASE;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "sb_publishable_clave_de_prueba_1234567890";
    expect(isSupabaseConfigured()).toBe(true);
  });

  it("es false si falta alguna", () => {
    // Permite que la app arranque y muestre instrucciones en vez de explotar: un
    // README que exige diez variables antes de ver algo es un README que nadie
    // sigue hasta el final.
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    expect(isSupabaseConfigured()).toBe(false);
    process.env.NEXT_PUBLIC_SUPABASE_URL = url;
  });
});

describe("hasServiceRole", () => {
  it("detecta la clave de servicio", () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_clave_de_prueba_1234567890";
    expect(hasServiceRole()).toBe(true);
  });

  it("es false sin la clave", () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(hasServiceRole()).toBe(false);
  });
});
