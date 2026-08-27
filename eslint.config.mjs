import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**"],
  },
  {
    files: ["**/*.{js,mjs}"],
    ...eslint.configs.recommended,
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["**/*.ts"],
    extends: [
      eslint.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        project: [
          "./tsconfig.main.json",
          "./tsconfig.ui.json",
          "./tsconfig.test.json",
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "no-undef": "off",
    },
  },
  {
    files: ["src/main/**/*.ts"],
    languageOptions: {
      globals: {
        __html__: "readonly",
        figma: "readonly",
      },
    },
  },
  {
    files: ["src/ui/**/*.ts"],
    languageOptions: {
      globals: globals.browser,
    },
  },
);
