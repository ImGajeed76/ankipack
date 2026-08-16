import js from "@eslint/js";
import ts from "typescript-eslint";
import globals from "globals";

export default ts.config(
  js.configs.recommended,
  ...ts.configs.strictTypeChecked,
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      // Type-aware linting, which is what buys `no-floating-promises`. Points
      // at the checking project so test and e2e files are covered too.
      parserOptions: {
        project: ["./tsconfig.check.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Anki's own values are numbers, and an error naming one reads better
      // than the same message with a manual String().
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      // Off until `noUncheckedIndexedAccess` is on. Without it, a
      // `Record<string, T>` lookup is typed as always present, so this calls
      // every `entries[name] === undefined` guard unnecessary when those guards
      // are what report a missing zip entry. Turn it on with that flag.
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/explicit-function-return-type": ["error", { allowExpressions: true }],
      "no-undef": "off",
    },
  },
  {
    // A test knows its own fixture, so asserting a lookup succeeded is clearer
    // than guarding it, and a spelled-out return type on every case adds noise.
    files: ["test/**/*.ts", "e2e/**/*.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-confusing-void-expression": "off",
      // `expect(...).rejects.toThrow()` returns undefined under bun, so the
      // await is a no-op here. Kept because it is what every other runner
      // needs, and dropping it would make these assertions bun-specific.
      "@typescript-eslint/await-thenable": "off",
    },
  },
  {
    ignores: ["dist/", "node_modules/", "src/generated/", "e2e/.venv/"],
  },
);
