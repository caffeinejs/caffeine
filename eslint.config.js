import { defineConfig } from 'eslint/config'
import eslint from '@eslint/js'
import { configs as tseslintConfigs } from 'typescript-eslint'
import importX from 'eslint-plugin-import-x'
import pluginN from 'eslint-plugin-n'
import pluginPromise from 'eslint-plugin-promise'
import tsdocPlugin from 'eslint-plugin-tsdoc'
import globals from 'globals'
import unusedImports from 'eslint-plugin-unused-imports'
import simpleImportSort from 'eslint-plugin-simple-import-sort'
import stylistic from '@stylistic/eslint-plugin'

export default defineConfig(
  {
    ignores: [
      '**/dist/**',
      '.vscode/**',
      '.local/**',
      'core/_benchmarks/**',
      'core/_tests/deno/**',
    ],
  },
  eslint.configs.recommended,
  tseslintConfigs.recommended,
  importX.flatConfigs.recommended,
  importX.flatConfigs.typescript,
  stylistic.configs.customize({
    semi: false,
    quotes: 'single',
    arrowParens: false,
    trailingComma: 'all',
    braceStyle: '1tbs',
    indent: 2,
    quoteProps: 'as-needed',
    blockSpacing: true,
  }),
  {
    settings: {
      'import-x/resolver': {
        typescript: {
          alwaysTryTypes: true,
          noWarnOnMultipleProjects: true,
          project: [
            './tsconfig.json',
            './core/tsconfig.json',
            './http/tsconfig.json',
            './http-fastify-adapter/tsconfig.json',
            './http-hono/tsconfig.json',
            './testing/tsconfig.json',
            './benchmarks/tsconfig.json',
            './examples/*/tsconfig.json',
            './core/examples/*/tsconfig.json',
          ],
        },
      },
    },
    plugins: {
      n: pluginN,
      promise: pluginPromise,
      tsdoc: tsdocPlugin,
      'unused-imports': unusedImports,
      'simple-import-sort': simpleImportSort,
    },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      curly: ['error', 'all'],

      'tsdoc/syntax': 'error',

      '@stylistic/max-len': ['warn', {
        code: 120,
        tabWidth: 2,
        ignoreComments: true,
        ignoreTrailingComments: true,
        ignoreStrings: true,
        ignoreTemplateLiterals: true,
        ignoreUrls: true,
        ignoreRegExpLiterals: true,
      }],
      '@stylistic/max-statements-per-line': ['error', { max: 2 }],
      '@stylistic/arrow-parens': ['error', 'as-needed'],
      '@stylistic/newline-per-chained-call': ['error'],

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
      'import-x/no-duplicates': 'error',
      'import-x/no-mutable-exports': 'error',
      'import-x/no-useless-path-segments': ['error', { noUselessIndex: false }],
      'import-x/no-self-import': 'error',
      'import-x/export': 'error',
      'import-x/no-deprecated': 'error',

      'unused-imports/no-unused-imports': 'error',
      'simple-import-sort/exports': 'error',
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
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-exports': ['error', { fixMixedExportsWithInlineTypeSpecifier: true }],
    },
  },
  {
    files: [
      '**/_tests/**/*.ts',
      '**/_testdata/**/*.ts',
      '**/_benchmarks/**/*.ts',
      '**/*.test.ts',
      '**/*.spec.ts',
      '**/*.bench.ts',
    ],
    languageOptions: {
      parserOptions: {
        project: false,
        projectService: false,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-exports': 'off',
    },
  },
  {
    files: ['**/*.test.ts', '**/*.spec.ts'],
    rules: {
      'import-x/extensions': 'off',
      'tsdoc/syntax': 'off',
      '@typescript-eslint/no-useless-constructor': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
  {
    files: ['**/*.js', '**/*.cjs'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
)
