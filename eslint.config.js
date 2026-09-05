import globals from 'globals';
import pluginJs from '@eslint/js';
import tseslint from 'typescript-eslint';
import noCatchAll from 'eslint-plugin-no-catch-all';

export default [
  { ignores: ['node_modules/', 'dist/', 'container/', 'groups/'] },
  { files: ['src/**/*.{js,ts}'] },
  { languageOptions: { globals: globals.node } },
  pluginJs.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { 'no-catch-all': noCatchAll },
    rules: {
      'preserve-caught-error': ['error', { requireCatchParameter: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'all',
          argsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      'no-catch-all/no-catch-all': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  // Type-aware promise-safety rules, scoped to src/ only: scripts/ is covered by
  // tsconfig.scripts.json, which typescript-eslint's projectService cannot
  // auto-discover (it only looks for a file literally named tsconfig.json), and
  // 3 of those scripts are excluded from typechecking entirely (PR #335).
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      // checksSpreads: `{ ...buildX() }` of a now-async builder spreads nothing;
      // the seam-3 conversion hit exactly that in the recall row.
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksConditionals: true, checksVoidReturn: true, checksSpreads: true },
      ],
      '@typescript-eslint/await-thenable': 'error',
    },
  },
];
