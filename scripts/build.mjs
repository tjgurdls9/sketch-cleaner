import { build } from 'esbuild';
import { build as buildUI } from 'vite';
import { rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await build({
  entryPoints: ['src/main/main.ts', 'src/main/preload.ts'],
  outdir: 'dist/main', bundle: true, platform: 'node', format: 'cjs',
  target: 'node24', external: ['electron', 'sharp'], sourcemap: true,
});
await buildUI({ configFile: false, base: './', build: {
  outDir: 'dist/renderer', emptyOutDir: true, target: 'chrome140',
}, worker: { format: 'es' } });
