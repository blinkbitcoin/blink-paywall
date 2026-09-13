import js from '@eslint/js';
import globals from 'globals';

/**
 * Flat ESLint config for the Blink Paywall widget.
 *
 * Environments:
 *   - src/**            browser ES modules, bundled by esbuild.
 *   - tests/**          Vitest + jsdom.
 *   - examples/**       Node ESM (reference L402 server).
 *   - *.config.js       Node ESM tooling.
 *   - generator.js      browser script (generator page, served raw).
 */
export default [
    {
        ignores: ['node_modules/**', 'v1/**', 'coverage/**', 'src/qr.js'],
    },
    js.configs.recommended,
    {
        files: ['src/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: { ...globals.browser },
        },
        rules: {
            'no-unused-vars': ['warn', { args: 'none' }],
            'no-empty': ['warn', { allowEmptyCatch: true }],
        },
    },
    {
        files: ['generator.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'script',
            globals: { ...globals.browser },
        },
        rules: {
            'no-unused-vars': ['warn', { args: 'none' }],
        },
    },
    {
        files: ['tests/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: { ...globals.node, ...globals.browser },
        },
    },
    {
        files: ['examples/**/*.mjs', '*.config.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: { ...globals.node },
        },
    },
];
