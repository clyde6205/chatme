import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'apps/mobile/**', '**/coverage/**', '**/test-results/**', '**/playwright-report/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': ['error', { allow: ['warn', 'error', 'log'] }],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // Kysely migrations operate on an untyped schema by design.
    files: ['apps/api/src/db/migrations/**', '**/*.test.ts', '**/test/**', '**/e2e/**'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
);
