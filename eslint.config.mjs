/**
 * Configuración de ESLint en formato plano nativo.
 *
 * `create-next-app` genera una configuración basada en `FlatCompat`, que traduce el
 * formato antiguo (`extends: "next/core-web-vitals"`) al nuevo. Con
 * `eslint-config-next` 16 eso rompe: el paquete ya exporta configuración plana, y
 * pasarla por el traductor produce una referencia circular que revienta con
 * `TypeError: Converting circular structure to JSON`.
 *
 * Aquí se importan las configuraciones directamente, que es lo que el paquete
 * espera, y desaparece tanto el error como la dependencia de `@eslint/eslintrc`.
 */

import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

const eslintConfig = [
  ...coreWebVitals,
  ...typescript,
  {
    rules: {
      /**
       * Los parámetros que empiezan por `_` son intencionalmente sin usar.
       *
       * Aparecen al implementar una interfaz: `urlRastreo(_ref)` no necesita la
       * referencia, pero la firma la exige. Renombrarlos al prefijo `_` es la
       * convención para decir "esto sobra a propósito", y la regla por defecto no
       * la reconoce. Lo mismo con las variables descartadas al desestructurar.
       */
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
      // Migraciones SQL y semillas: ESLint no las entiende y no aportan nada aquí.
      "supabase/**",
    ],
  },
];

export default eslintConfig;
