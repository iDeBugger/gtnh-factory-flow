import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import prettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

/*
 * Every source file gets typescript-eslint's recommended rules and the React hooks rules. JavaScript files also get
 * ESLint's own recommended rules; TypeScript files do not, since `npm run typecheck` already catches what those
 * rules would. Formatting is Prettier's, so the rules it would fight are off.
 */
const eslintConfig = defineConfig([
  globalIgnores([
    // Build output and generated files.
    "dist/**",
    "dist-live/**",
    "dist-db/**",
    ".next/**",
    "public/**",
    // Local-only agent scratch (probes, captures, old harnesses).
    "scratch/**",
  ]),
  {
    files: ["**/*.{js,cjs,mjs,jsx}"],
    extends: [js.configs.recommended],
    // Warnings, not failures: the scripts hold empty blocks and needless escapes that do no harm.
    rules: {
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "no-useless-escape": "warn",
      // The typescript-eslint rule below reports these, in every file.
      "no-unused-vars": "off",
    },
  },
  tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser },
    },
    // Warnings, not failures: an unused name or a bare expression does no harm at run time.
    rules: {
      "@typescript-eslint/no-unused-vars": "warn",
      "@typescript-eslint/no-unused-expressions": "warn",
    },
  },
  prettier,
]);

export default eslintConfig;
