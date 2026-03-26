import typescriptEslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

export default [
  {
    files: ["**/*.ts"],
  },
  {
    plugins: {
      "@typescript-eslint": typescriptEslint,
    },

    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: "module",
    },

    rules: {
      "@typescript-eslint/naming-convention": [
        "warn",
        {
          selector: "import",
          format: ["camelCase", "PascalCase"],
        },
      ],

      "@typescript-eslint/no-explicit-any": [
        "error",
        {
          fixToUnknown: true,
          ignoreRestArgs: false,
        },
      ],

      "@typescript-eslint/consistent-type-assertions": [
        "error",
        {
          assertionStyle: "as",
          objectLiteralTypeAssertions: "allow-as-parameter",
        },
      ],

      curly: "warn",
      eqeqeq: "warn",
      "no-throw-literal": "warn",
      semi: "warn",
    },
  },
  // Allow 'any' in test files where mocking may require flexibility
  {
    files: ["**/*.test.ts", "**/__tests__/**/*.ts", "**/test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
];
