import js from "@eslint/js";
import ts from "typescript-eslint";
import globals from "globals";

export default ts.config(
  js.configs.recommended,
  ...ts.configs.strict,
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
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
    ignores: ["dist/", "node_modules/", "src/generated/"],
  },
);
