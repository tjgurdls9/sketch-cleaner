import { build } from 'esbuild';
import { build as buildUI } from 'vite';
import { rm, cp } from 'node:fs/promises';
import './prepare-model.mjs';

await rm('dist', { recursive: true, force: true });
await build({
  entryPoints: ['src/main/main.ts', 'src/main/preload.ts', 'src/main/ai-worker.ts'],
  outdir: 'dist/main', bundle: true, platform: 'node', format: 'cjs',
  target: 'node24', external: ['electron', 'sharp', 'onnxruntime-node'], sourcemap: true,
});
await cp('artifacts/models', 'dist/models', { recursive: true });
await buildUI({ configFile: false, base: './', build: {
  outDir: 'dist/renderer', emptyOutDir: true, target: 'chrome140',
}, worker: { format: 'es' } });
