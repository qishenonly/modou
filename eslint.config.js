// @ts-check
import eslintConfigPrettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['node_modules/**', '**/dist/**', 'bun.lock', 'eslint.config.js'],
  },
  {
    files: ['packages/**/*.{ts,tsx}'],
    extends: [...tseslint.configs.recommended],
  },
  eslintConfigPrettier,
);
