import { defineConfig } from 'vitest/config';
export default defineConfig({ test: {
  include: ['tests/**/*.test.ts'],
  coverage: { provider: 'v8', include: ['src/core/**/*.ts', 'src/main/store.ts', 'src/main/validation.ts', 'src/renderer/state.ts'], exclude: ['**/*worker*'], reporter: ['text', 'json-summary', 'html'] }
} });
