import { defineConfig } from 'vitest/config';
export default defineConfig({ test: {
  include: ['tests/**/*.test.ts'],
  coverage: {
    provider: 'v8',
    include: ['src/core/engine.ts', 'src/core/automatic.ts', 'src/main/ai.ts', 'src/main/ai-manager.ts', 'src/main/persistence.ts', 'src/main/image.ts', 'src/main/security.ts', 'src/main/errors.ts', 'src/renderer/state.ts'],
    reporter: ['text', 'json-summary', 'html'],
  }
} });
