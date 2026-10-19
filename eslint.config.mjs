import js from '@eslint/js';
import ts from 'typescript-eslint';
export default ts.config(
  { ignores: ['node_modules/**', 'dist/**', 'out/**', 'coverage/**', 'test-results/**'] },
  js.configs.recommended, ...ts.configs.recommended,
  { files: ['**/*.{ts,mjs}'], languageOptions: { globals: {
    window: 'readonly', document: 'readonly', console: 'readonly', process: 'readonly', Buffer: 'readonly',
    URL: 'readonly', __dirname: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly',
    requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly', performance: 'readonly',
    ImageData: 'readonly', Image: 'readonly', Worker: 'readonly', self: 'readonly',
    Blob: 'readonly', File: 'readonly', HTMLElement: 'readonly', HTMLCanvasElement: 'readonly',
    HTMLInputElement: 'readonly', HTMLButtonElement: 'readonly', HTMLSelectElement: 'readonly',
    CanvasRenderingContext2D: 'readonly', PointerEvent: 'readonly', KeyboardEvent: 'readonly',
    crypto: 'readonly', navigator: 'readonly', confirm: 'readonly', ResizeObserver: 'readonly',
    structuredClone: 'readonly', createImageBitmap: 'readonly', OffscreenCanvas: 'readonly',
    fetch: 'readonly', AbortSignal: 'readonly'
  } }, rules: { '@typescript-eslint/no-explicit-any': 'error', '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }] } }
);
