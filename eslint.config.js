// @ts-check
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // packages/schema is vendored from @clycites/schema@0.2.0 and is read-only here.
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.turbo/**',
      'packages/schema/**',
      // Build output of the documentation site, and the virtualenv that
      // produces it. Both contain vendored, minified JavaScript that nobody
      // here wrote.
      'site/**',
      '.venv-docs/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
