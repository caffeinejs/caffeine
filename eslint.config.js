import { defineConfig } from 'eslint/config'
import eslint from '@eslint/js'
import { configs as tseslintConfigs } from 'typescript-eslint'
import importX from 'eslint-plugin-import-x'
import pluginN from 'eslint-plugin-n'
import pluginPromise from 'eslint-plugin-promise'
import tsdocPlugin from 'eslint-plugin-tsdoc'
import globals from 'globals'

export default defineConfig(
  { ignores: ['**/dist/**', '.vscode/**', '.local/**'] },
  eslint.configs.recommended,
  tseslintConfigs.recommended,
  importX.flatConfigs.recommended,
  importX.flatConfigs.typescript,
  {
    settings: {
      'import-x/resolver': { typescript: true },
    },
    plugins: {
      n: pluginN,
      promise: pluginPromise,
      tsdoc: tsdocPlugin,
    },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      curly: ['error', 'all'],

      'tsdoc/syntax': 'error',

      'n/no-missing-import': 'off',
      'n/no-unpublished-import': 'off',

      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-empty-function': ['error', { allow: ['decoratedFunctions'] }],
      '@typescript-eslint/no-useless-constructor': 'error',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-namespace': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',
      '@typescript-eslint/no-wrapper-object-types': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',

      'import-x/no-named-as-default-member': 'off',

      'import-x/extensions': ['error', 'ignorePackages', { js: 'always', jsx: 'never', ts: 'never', tsx: 'never' }],
      'import-x/order': [
        'error',
        { groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index', 'object'] },
      ],
      'import-x/no-named-as-default': 'off',
      'import-x/no-duplicates': 'off',
      'import-x/no-mutable-exports': 'error',
      'import-x/no-useless-path-segments': ['error', { noUselessIndex: false }],
      'import-x/no-self-import': 'error',
      'import-x/export': 'error',
      'import-x/no-deprecated': 'error',

      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '(?:\\.\\./)+_',
              message: 'Private (_*) modules cannot be imported from outside their directory.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.test.ts', '**/*.spec.ts'],
    rules: {
      'import-x/extensions': 'off',
      '@typescript-eslint/no-useless-constructor': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
  {
    files: ['**/*.js'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
)
