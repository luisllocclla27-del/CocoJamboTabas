/**
 * Comprueba que .env.local tiene lo que la aplicación necesita.
 *
 * Solo informa de PRESENCIA y longitud, nunca del valor: un script que imprime
 * claves acaba con esas claves en el historial de la terminal, en una captura o en
 * un log de CI.
 *
 * Uso: npm run check:env
 */

import { readFileSync, existsSync } from "node:fs";

const ARCHIVO = ".env.local";

/** `obligatoria` marca lo que impide vender si falta. */
const VARIABLES = [
  { nombre: "NEXT_PUBLIC_SUPABASE_URL", obligatoria: true, prefijo: "https://" },
  { nombre: "NEXT_PUBLIC_SUPABASE_ANON_KEY", obligatoria: true, minimo: 20 },
  { nombre: "SUPABASE_SERVICE_ROLE_KEY", obligatoria: true, minimo: 20 },
  { nombre: "NEXT_PUBLIC_SITE_URL", obligatoria: false, prefijo: "http" },
  { nombre: "YAPE_NUMERO", obligatoria: true, patron: /^9\d{8}$/ },
  { nombre: "YAPE_TITULAR", obligatoria: true, minimo: 3 },
  { nombre: "CRON_SECRET", obligatoria: false, minimo: 32 },
];

if (!existsSync(ARCHIVO)) {
  console.error(`\n✗ No existe ${ARCHIVO}.`);
  console.error(`  Créalo copiando .env.example y rellena los valores.\n`);
  process.exit(1);
}

const valores = new Map();
for (const linea of readFileSync(ARCHIVO, "utf8").split(/\r?\n/)) {
  if (linea.trim().startsWith("#")) continue;
  const separador = linea.indexOf("=");
  if (separador === -1) continue;
  const clave = linea.slice(0, separador).trim();
  // Se quitan las comillas: pegar el valor entrecomillado es un error habitual y
  // Next lo interpretaría como parte del valor.
  const valor = linea
    .slice(separador + 1)
    .trim()
    .replace(/^["']|["']$/g, "");
  if (clave !== "") valores.set(clave, valor);
}

let errores = 0;
let avisos = 0;

console.log(`\nRevisando ${ARCHIVO}\n`);

for (const variable of VARIABLES) {
  const valor = valores.get(variable.nombre);
  const marca = variable.obligatoria ? "✗" : "!";
  const etiqueta = variable.nombre.padEnd(32);

  if (valor === undefined || valor === "") {
    console.log(`${marca} ${etiqueta} ${valor === undefined ? "ausente" : "vacía"}`);
    if (variable.obligatoria) errores++;
    else avisos++;
    continue;
  }

  const problemas = [];
  if (variable.prefijo !== undefined && !valor.startsWith(variable.prefijo)) {
    problemas.push(`debería empezar por ${variable.prefijo}`);
  }
  if (variable.minimo !== undefined && valor.length < variable.minimo) {
    problemas.push(`parece truncada (${valor.length} caracteres)`);
  }
  if (variable.patron !== undefined && !variable.patron.test(valor)) {
    problemas.push("el formato no cuadra");
  }

  if (problemas.length > 0) {
    console.log(`${marca} ${etiqueta} ${problemas.join("; ")}`);
    if (variable.obligatoria) errores++;
    else avisos++;
  } else {
    console.log(`✓ ${etiqueta} ok (${valor.length} caracteres)`);
  }
}

// Comprobaciones cruzadas: errores que no se ven mirando una variable sola.
const url = valores.get("NEXT_PUBLIC_SUPABASE_URL") ?? "";
const anon = valores.get("NEXT_PUBLIC_SUPABASE_ANON_KEY") ?? "";
const secret = valores.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

console.log("");

if (url.includes("/rest/v1")) {
  console.log("! La URL incluye /rest/v1: la app la recorta sola, pero es más claro dejar solo el dominio.");
}
if (anon !== "" && secret !== "" && anon === secret) {
  console.log("✗ La clave publishable y la secret son iguales: revisa cuál copiaste en cada una.");
  errores++;
}
if (secret.startsWith("sb_publishable_")) {
  console.log("✗ SUPABASE_SERVICE_ROLE_KEY tiene una clave publishable. Debe ser la secret (sb_secret_...).");
  errores++;
}
if (anon.startsWith("sb_secret_")) {
  console.log("✗ NEXT_PUBLIC_SUPABASE_ANON_KEY tiene la clave SECRETA, y esa variable viaja al navegador.");
  console.log("  Rótala en Supabase ahora mismo: omite la RLS y quedaría expuesta a cualquiera.");
  errores++;
}

console.log("");
if (errores > 0) {
  console.error(
    `${errores} ${errores === 1 ? "problema" : "problemas"} que impiden que la tienda funcione.\n`,
  );
  process.exit(1);
}
if (avisos > 0) {
  console.log(`Listo, con ${avisos} ${avisos === 1 ? "aviso" : "avisos"}. Arranca con: npm run dev\n`);
} else {
  console.log("Todo correcto. Arranca con: npm run dev\n");
}
