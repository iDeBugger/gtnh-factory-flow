import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import prettier from "eslint-config-prettier";
import globals from "globals";

/*
 * The JavaScript files only, with ESLint's own recommended rules. TypeScript and TSX need the typescript-eslint
 * parser and the React hooks rules, which arrive with their own packages; until then they are not linted here
 * (`npm run typecheck` still checks them).
 */
const eslintConfig = defineConfig([
  globalIgnores([
    "**/*.ts",
    "**/*.tsx",
    "**/*.mts",
    // Build output and generated files.
    "dist/**",
    "dist-live/**",
    "dist-db/**",
    ".next/**",
    "public/**",
    // Local-only agent scratch (probes, captures, old harnesses).
    "scratch/**",
  ]),
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser },
    },
    // Warnings, not failures: the scripts hold unused names and empty blocks that do no harm.
    rules: {
      "no-unused-vars": "warn",
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "no-useless-escape": "warn",
    },
  },
  prettier,
]);

export default eslintConfig;
