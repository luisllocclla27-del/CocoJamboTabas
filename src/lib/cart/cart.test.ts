import { describe, expect, it } from "vitest";
import {
  agregarItem,
  CARRITO_VACIO,
  deserializarCarrito,
  estaVacio,
  fijarCantidad,
  MAX_LINEAS,
  MAX_POR_VARIANTE,
  quitarItem,
  serializarCarrito,
  totalUnidades,
  type Carrito,
} from "./cart";

// La firma deriva de esta variable; se fija para que los tests sean deterministas.
process.env.SUPABASE_SERVICE_ROLE_KEY = "clave-de-servicio-para-tests-1234567890";

const V1 = "11111111-1111-4111-8111-111111111111";
const V2 = "22222222-2222-4222-8222-222222222222";

describe("serialización de la cookie", () => {
  it("ida y vuelta conserva el carrito", () => {
    const carrito: Carrito = {
      items: [
        { variantId: V1, cantidad: 2 },
        { variantId: V2, cantidad: 1 },
      ],
    };
    expect(deserializarCarrito(serializarCarrito(carrito))).toEqual(carrito);
  });

  it("un carrito manipulado se descarta por la firma", () => {
    // Sin firma, alguien podría inyectar cantidades absurdas o ids inventados.
    const cookie = serializarCarrito({ items: [{ variantId: V1, cantidad: 1 }] });
    const [payload, firma] = cookie.split(".");
    const falsificado = Buffer.from(
      JSON.stringify({ items: [{ variantId: V1, cantidad: 9999 }] }),
      "utf8",
    ).toString("base64url");

    expect(deserializarCarrito(`${falsificado}.${firma}`)).toEqual(CARRITO_VACIO);
    expect(payload).not.toBe(falsificado);
  });

  it("una firma de otra longitud no lanza, solo vacía el carrito", () => {
    // `timingSafeEqual` lanza si los buffers difieren en longitud.
    const cookie = serializarCarrito({ items: [{ variantId: V1, cantidad: 1 }] });
    const payload = cookie.split(".")[0];
    expect(() => deserializarCarrito(`${payload}.abc`)).not.toThrow();
    expect(deserializarCarrito(`${payload}.abc`)).toEqual(CARRITO_VACIO);
  });

  it("una cookie corrupta vacía el carrito en vez de romper la tienda", () => {
    // Un 500 en la home para cualquiera con una cookie vieja sería mucho peor.
    for (const valor of ["", "basura", "sin-punto", "a.b", "...."]) {
      expect(deserializarCarrito(valor), valor).toEqual(CARRITO_VACIO);
    }
    expect(deserializarCarrito(undefined)).toEqual(CARRITO_VACIO);
  });

  it("rechaza un payload que no cumple el esquema", () => {
    // Formato viejo o datos inventados: se descarta sin lanzar.
    const payload = Buffer.from(JSON.stringify({ productos: ["x"] }), "utf8").toString("base64url");
    const cookie = serializarCarrito(CARRITO_VACIO);
    const firmaValidaDeOtroPayload = cookie.split(".")[1];
    expect(deserializarCarrito(`${payload}.${firmaValidaDeOtroPayload}`)).toEqual(CARRITO_VACIO);
  });

  it("rechaza un variantId que no es uuid", () => {
    const carrito = { items: [{ variantId: "no-es-uuid", cantidad: 1 }] } as Carrito;
    expect(deserializarCarrito(serializarCarrito(carrito))).toEqual(CARRITO_VACIO);
  });

  it("no guarda precios en la cookie", () => {
    // El precio se lee siempre de la base: es la defensa contra manipularlo desde
    // el navegador.
    const cookie = serializarCarrito({ items: [{ variantId: V1, cantidad: 1 }] });
    const json = Buffer.from(cookie.split(".")[0], "base64url").toString("utf8");
    expect(json).not.toMatch(/precio|price|cents|total/i);
  });
});

describe("agregarItem", () => {
  it("añade una línea nueva", () => {
    const carrito = agregarItem(CARRITO_VACIO, { variantId: V1, cantidad: 1 });
    expect(carrito.items).toEqual([{ variantId: V1, cantidad: 1 }]);
  });

  it("incrementa la línea existente en vez de duplicarla", () => {
    let carrito = agregarItem(CARRITO_VACIO, { variantId: V1, cantidad: 1 });
    carrito = agregarItem(carrito, { variantId: V1, cantidad: 2 });
    expect(carrito.items).toHaveLength(1);
    expect(carrito.items[0].cantidad).toBe(3);
  });

  it("acota al tope por variante en vez de rechazar", () => {
    // Sumar 3 a un carrito que ya tiene 4 deja 5, no falla: rechazar obligaría a
    // explicar un límite que al cliente no le interesa.
    let carrito = agregarItem(CARRITO_VACIO, { variantId: V1, cantidad: 4 });
    carrito = agregarItem(carrito, { variantId: V1, cantidad: 3 });
    expect(carrito.items[0].cantidad).toBe(MAX_POR_VARIANTE);
  });

  it("no supera el máximo de líneas", () => {
    // Acota el tamaño de la cookie.
    let carrito = CARRITO_VACIO;
    for (let i = 0; i < MAX_LINEAS + 5; i++) {
      carrito = agregarItem(carrito, {
        variantId: `${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`,
        cantidad: 1,
      });
    }
    expect(carrito.items).toHaveLength(MAX_LINEAS);
  });

  it("es puro: no muta el carrito de entrada", () => {
    const original: Carrito = { items: [{ variantId: V1, cantidad: 1 }] };
    agregarItem(original, { variantId: V2, cantidad: 1 });
    expect(original.items).toHaveLength(1);
  });
});

describe("quitarItem y fijarCantidad", () => {
  const carrito: Carrito = {
    items: [
      { variantId: V1, cantidad: 2 },
      { variantId: V2, cantidad: 1 },
    ],
  };

  it("quita solo la línea indicada", () => {
    expect(quitarItem(carrito, V1).items).toEqual([{ variantId: V2, cantidad: 1 }]);
  });

  it("quitar algo que no está no cambia nada", () => {
    expect(quitarItem(carrito, "otro-id").items).toHaveLength(2);
  });

  it("fija la cantidad exacta", () => {
    expect(fijarCantidad(carrito, V1, 3).items[0].cantidad).toBe(3);
  });

  it("fijar en 0 o negativo elimina la línea", () => {
    expect(fijarCantidad(carrito, V1, 0).items).toHaveLength(1);
    expect(fijarCantidad(carrito, V1, -5).items).toHaveLength(1);
  });

  it("acota al tope y trunca decimales", () => {
    expect(fijarCantidad(carrito, V1, 99).items[0].cantidad).toBe(MAX_POR_VARIANTE);
    expect(fijarCantidad(carrito, V1, 2.9).items[0].cantidad).toBe(2);
  });
});

describe("totales", () => {
  it("suma las unidades de todas las líneas", () => {
    expect(
      totalUnidades({
        items: [
          { variantId: V1, cantidad: 2 },
          { variantId: V2, cantidad: 3 },
        ],
      }),
    ).toBe(5);
  });

  it("un carrito vacío tiene 0 unidades", () => {
    expect(totalUnidades(CARRITO_VACIO)).toBe(0);
    expect(estaVacio(CARRITO_VACIO)).toBe(true);
  });

  it("estaVacio distingue con y sin líneas", () => {
    expect(estaVacio({ items: [{ variantId: V1, cantidad: 1 }] })).toBe(false);
  });
});
