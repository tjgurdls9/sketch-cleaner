import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, open, rename, rm, copyFile } from 'node:fs/promises';
import path from 'node:path';

const manifest = JSON.parse(await readFile('models/model.json', 'utf8'));
if (manifest.filename !== 'text-det.onnx' || !/^[a-f0-9]{64}$/.test(manifest.sha256) || new URL(manifest.url).protocol !== 'https:') throw new Error('Invalid model manifest');
const folder = path.resolve('artifacts/models');
const target = path.join(folder, manifest.filename);
await mkdir(folder, { recursive: true });
let valid = false;
try { valid = createHash('sha256').update(await readFile(target)).digest('hex') === manifest.sha256; }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (!valid) {
  const response = await fetch(manifest.url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error(`Model download failed: ${response.status}`);
  const temporary = `${target}.${randomUUID()}.download`;
  try {
    const output = await open(temporary, 'wx');
    const hash = createHash('sha256');
    let bytes = 0;
    try {
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > 32 * 1024 * 1024) throw new Error('Model exceeds build download limit');
        hash.update(chunk);
        await output.writeFile(chunk);
      }
    } finally { await output.close(); }
    if (hash.digest('hex') !== manifest.sha256) throw new Error('Model checksum mismatch');
    await rename(temporary, target);
  } finally { await rm(temporary, { force: true }); }
}
for (const name of ['model.json', 'LICENSE', 'NOTICE', 'ONNXRUNTIME-LICENSE', 'ONNXRUNTIME-NOTICES']) await copyFile(`models/${name}`, path.join(folder, name));
console.log('Verified bundled text model (SHA-256 matched)');
