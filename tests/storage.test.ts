import { afterEach, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { link, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import type { Pixels, Snapshot } from '../src/shared/types';
import { ProjectStore } from '../src/main/persistence';

const tempDirs: string[] = [];
const makeRoot = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sketch-cleaner-storage-'));
  tempDirs.push(root);
  return root;
};

const pixels = (color: [number, number, number, number], width = 2, height = 2): Pixels => ({
  width,
  height,
  data: new Uint8ClampedArray(Array.from({ length: width * height }, () => color).flat()),
});

const snapshot = (workVersion = 0): Snapshot => ({
  base: pixels([10, 20, 30, 255]),
  working: pixels([10, 20, 30, 255]),
  deleteMask: new Uint8Array(4),
  protectMask: new Uint8Array(4),
  baseVersion: 'base-1',
  workVersion,
});

const png = async (image: Pixels) => sharp(Buffer.from(image.data), {
  raw: { width: image.width, height: image.height, channels: 4 },
}).png().toBuffer();

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('ProjectStore durable revisions', () => {
  it('rejects malformed snapshots at the main-process persistence boundary', async () => {
    const root = await makeRoot();
    const store = new ProjectStore({ root });
    const original = await png(pixels([1, 2, 3, 255]));
    const baseSnapshot = snapshot();
    const tooLarge: Snapshot = {
      ...baseSnapshot,
      base: { width: 5_001, height: 5_000, data: new Uint8ClampedArray() },
      working: { width: 5_001, height: 5_000, data: new Uint8ClampedArray() },
      deleteMask: new Uint8Array(), protectMask: new Uint8Array(),
    };
    const mismatched: Snapshot = { ...baseSnapshot, working: pixels([1, 2, 3, 255], 1, 2) };
    const floatMask = { ...baseSnapshot, protectMask: new Float32Array(4) } as unknown as Snapshot;
    const nanVersion = { ...baseSnapshot, workVersion: Number.NaN };
    const invalid = [
      { ...baseSnapshot, base: pixels([1, 2, 3, 255], 0, 2), working: pixels([1, 2, 3, 255], 0, 2) },
      tooLarge, mismatched, floatMask, nanVersion,
    ];

    for (const item of invalid) await expect(store.create('source-id', 'original.png', original, item)).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  });

  it('keeps the imported source byte-for-byte and records its hash', async () => {
    const root = await makeRoot();
    const sourceBytes = await png(pixels([220, 40, 30, 255]));
    const store = new ProjectStore({ root });
    const project = await store.create('source-id', 'original.png', sourceBytes, snapshot());
    const source = await readFile(path.join(project.folder, 'original.png'));
    const manifest = JSON.parse(await readFile(path.join(project.folder, 'project.json'), 'utf8'));

    expect(source.equals(sourceBytes)).toBe(true);
    expect(manifest.original.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.original.sha256).toBe(createHash('sha256').update(sourceBytes).digest('hex'));
    expect(await store.listRecent()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: project.id, folder: project.folder }),
    ]));
    expect((await store.openRecent(project.id)).id).toBe(project.id);
  });

  it('accepts an internal lossless working PNG larger than the external import limit', async () => {
    const width = 3_600;
    const height = 3_700;
    const raw = randomBytes(width * height * 4);
    const original = await sharp(raw, { raw: { width, height, channels: 4 } }).jpeg({ quality: 45 }).toBuffer();
    const workingPng = await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer();
    expect(original.byteLength).toBeLessThan(50 * 1024 * 1024);
    expect(workingPng.byteLength).toBeGreaterThan(50 * 1024 * 1024);
    const image: Pixels = { width, height, data: new Uint8ClampedArray(raw) };
    const base: Pixels = { width, height, data: new Uint8ClampedArray(width * height * 4).fill(255) };
    const largeSnapshot: Snapshot = {
      base, working: image, deleteMask: new Uint8Array(width * height), protectMask: new Uint8Array(width * height),
      baseVersion: 'large-base', workVersion: 0,
    };
    const store = new ProjectStore({ root: await makeRoot() });
    const project = await store.create('source-id', 'large.jpg', original, largeSnapshot);
    const reopened = await store.open(project.folder);
    expect(Buffer.from(reopened.snapshot.working.data).equals(raw)).toBe(true);
  }, 60_000);

  it('writes immutable revisions and reopens the latest saved snapshot', async () => {
    const store = new ProjectStore({ root: await makeRoot() });
    const created = await store.create('source-id', 'original.png', await png(pixels([1, 2, 3, 255])), snapshot());
    await store.save(created.id, { ...snapshot(1), working: pixels([90, 80, 70, 255]) });
    const before = await readdir(path.join(created.folder, 'revisions', 'r000001'));
    const firstRevision = await Promise.all(before.map((file) => readFile(path.join(created.folder, 'revisions', 'r000001', file))));
    await store.save(created.id, { ...snapshot(2), working: pixels([4, 5, 6, 255]) });
    const after = await Promise.all(before.map((file) => readFile(path.join(created.folder, 'revisions', 'r000001', file))));
    const reopened = await store.open(created.folder);

    expect(after.map((bytes, index) => bytes.equals(firstRevision[index]))).toEqual(before.map(() => true));
    expect(reopened.snapshot.working.data).toEqual(pixels([4, 5, 6, 255]).data);
    expect(reopened.recovered).toBe(false);
  });

  it('rejects a guide with mismatched dimensions before saving or creating request files', async () => {
    const store = new ProjectStore({ root: await makeRoot() });
    const project = await store.create('source-id', 'original.png', await png(pixels([1, 2, 3, 255])), snapshot());

    await expect(store.createRequest(project.id, snapshot(1), pixels([255, 0, 0, 255], 1, 1))).rejects.toThrow(/크기/);
    const reopened = await store.open(project.folder);
    expect(reopened.snapshot.workVersion).toBe(0);
    expect(reopened.requests).toHaveLength(0);
    expect(await readdir(path.join(project.folder, 'requests'))).toEqual([]);
  });

  it('keeps the previous pointer and revision when atomic replacement fails', async () => {
    const root = await makeRoot();
    const store = new ProjectStore({ root });
    const created = await store.create('source-id', 'original.png', await png(pixels([1, 2, 3, 255])), snapshot());
    const failingStore = new ProjectStore({ root, replaceFile: async () => { throw new Error('disk full'); } });

    await expect(failingStore.save(created.id, { ...snapshot(1), working: pixels([9, 9, 9, 255]) })).rejects.toThrow();
    const reopened = await store.open(created.folder);
    expect(reopened.snapshot.working.data).toEqual(snapshot().working.data);
    expect(reopened.snapshot.workVersion).toBe(0);
  });

  it('falls back to the last valid revision and marks the project recovered', async () => {
    const store = new ProjectStore({ root: await makeRoot() });
    const created = await store.create('source-id', 'original.png', await png(pixels([1, 2, 3, 255])), snapshot());
    await store.save(created.id, { ...snapshot(1), working: pixels([9, 8, 7, 255]) });
    const manifestPath = path.join(created.folder, 'project.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.currentRevision = 'r999999';
    await writeFile(manifestPath, JSON.stringify(manifest));

    const recovered = await store.open(created.folder);
    expect(recovered.recovered).toBe(true);
    expect(recovered.snapshot.workVersion).toBe(0);
    expect(recovered.snapshot.working.data).toEqual(snapshot().working.data);
  });

  it('recovers from a damaged current revision and rejects renderer-supplied path ids', async () => {
    const store = new ProjectStore({ root: await makeRoot() });
    const created = await store.create('source-id', 'original.png', await png(pixels([1, 2, 3, 255])), snapshot());
    await store.save(created.id, { ...snapshot(1), working: pixels([9, 8, 7, 255]) });
    await writeFile(path.join(created.folder, 'revisions', 'r000002', 'working.png'), Buffer.from('damaged'));

    const recovered = await store.open(created.folder);
    expect(recovered.recovered).toBe(true);
    expect(recovered.snapshot.workVersion).toBe(0);
    await expect(store.openRecent('../outside')).rejects.toThrow();
  });

  it('rejects stale work but permits a newer undo that restores an older image basis', async () => {
    const store = new ProjectStore({ root: await makeRoot() });
    const created = await store.create('source-id', 'original.png', await png(pixels([1, 2, 3, 255])), snapshot());
    await store.save(created.id, { ...snapshot(2), working: pixels([9, 8, 7, 255]) });

    await expect(store.save(created.id, snapshot(1))).rejects.toThrow(/버전|변경/);
    const cropped: Snapshot = {
      base: pixels([10, 20, 30, 255], 1, 1), working: pixels([90, 80, 70, 255], 1, 1),
      deleteMask: new Uint8Array(1), protectMask: new Uint8Array(1), baseVersion: 'crop-2', workVersion: 3,
    };
    await store.save(created.id, cropped);
    await store.save(created.id, { ...snapshot(4), working: pixels([9, 8, 7, 255]) });
    const undone = await store.open(created.folder);
    expect(undone.snapshot.baseVersion).toBe('base-1');
    expect(undone.snapshot.base.width).toBe(2);
    await expect(store.save(created.id, {
      ...snapshot(5), deleteMask: new Uint8Array(3),
    })).rejects.toThrow(/마스크|크기|이미지/);
  });

  it('preserves a verified fallback pointer if a save fails after recovery', async () => {
    const root = await makeRoot();
    const store = new ProjectStore({ root });
    const created = await store.create('source-id', 'original.png', await png(pixels([1, 2, 3, 255])), snapshot());
    await store.save(created.id, { ...snapshot(1), working: pixels([90, 80, 70, 255]) });
    await writeFile(path.join(created.folder, 'project.json'), '{damaged');

    const recovered = await store.open(created.folder);
    expect(recovered.recovered).toBe(true);
    expect(recovered.snapshot.workVersion).toBe(0);
    const failing = new ProjectStore({ root, replaceFile: async () => { throw new Error('disk full'); } });
    await expect(failing.save(created.id, { ...snapshot(1), working: pixels([8, 8, 8, 255]) })).rejects.toThrow();

    const reopened = await store.open(created.folder);
    expect(reopened.recovered).toBe(true);
    expect(reopened.snapshot.workVersion).toBe(0);
    expect(reopened.snapshot.working.data).toEqual(snapshot().working.data);
  });

  it('round-trips mask intensities and RGBA bytes without quantizing them', async () => {
    const store = new ProjectStore({ root: await makeRoot() });
    const created = await store.create('source-id', 'original.png', await png(pixels([1, 2, 3, 255])), snapshot());
    const edited: Snapshot = {
      ...snapshot(1),
      working: { ...pixels([1, 2, 3, 255]), data: new Uint8ClampedArray([10, 20, 30, 255, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]) },
      deleteMask: new Uint8Array([0, 64, 128, 255]),
      protectMask: new Uint8Array([255, 128, 64, 0]),
    };
    await store.save(created.id, edited);
    const reopened = await store.open(created.folder);

    expect(reopened.snapshot.working.data).toEqual(edited.working.data);
    expect(reopened.snapshot.deleteMask).toEqual(edited.deleteMask);
    expect(reopened.snapshot.protectMask).toEqual(edited.protectMask);
  });

  it('rejects a current revision with changed fully protected pixels and recovers the prior revision', async () => {
    const store = new ProjectStore({ root: await makeRoot() });
    const created = await store.create('source-id', 'original.png', await png(pixels([1, 2, 3, 255])), snapshot());
    const validProtected: Snapshot = {
      ...snapshot(1),
      working: pixels([10, 20, 30, 255]),
      protectMask: new Uint8Array([255, 0, 0, 0]),
    };
    await store.save(created.id, validProtected);
    const protectedRevision = path.join(created.folder, 'revisions', 'r000002', 'working.png');
    await writeFile(protectedRevision, await png({ ...pixels([90, 20, 30, 255]), data: new Uint8ClampedArray([90, 20, 30, 255, 10, 20, 30, 255, 10, 20, 30, 255, 10, 20, 30, 255]) }));

    const reopened = await store.open(created.folder);
    expect(reopened.recovered).toBe(true);
    expect(reopened.snapshot.workVersion).toBe(0);
  });

  it('rejects an unsupported project schema version', async () => {
    const store = new ProjectStore({ root: await makeRoot() });
    const created = await store.create('source-id', 'original.png', await png(pixels([1, 2, 3, 255])), snapshot());
    const manifestPath = path.join(created.folder, 'project.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.schemaVersion = 99;
    await writeFile(manifestPath, JSON.stringify(manifest));

    await expect(store.open(created.folder)).rejects.toThrow(/열 수 없습니다|버전/);
  });

  it('stores an immutable request snapshot and forks from the exact requested revision', async () => {
    const store = new ProjectStore({ root: await makeRoot() });
    const original = await png(pixels([1, 2, 3, 255]));
    const created = await store.create('source-id', 'original.png', original, snapshot());
    const requested = { ...snapshot(4), working: pixels([40, 50, 60, 255]) };
    const bundle = await store.createRequest(created.id, requested, pixels([255, 0, 0, 255]));
    const requestDir = path.join(created.folder, 'requests', bundle.info.id);
    const metadata = JSON.parse(await readFile(path.join(requestDir, 'metadata.json'), 'utf8'));
    const loaded = await store.loadRequest(created.id, bundle.info.id);
    const fork = await store.forkRequest(created.id, bundle.info.id);

    expect(await readdir(requestDir)).toEqual(expect.arrayContaining([
      'input.png', 'guide.png', 'request.txt', 'metadata.json', 'base.png',
      'delete-mask.png', 'protect-mask.png', 'working.png',
    ]));
    expect(metadata).toMatchObject({
      projectId: created.id,
      requestId: bundle.info.id,
      baseVersion: requested.baseVersion,
      workVersion: requested.workVersion,
      width: requested.base.width,
      height: requested.base.height,
    });
    expect(loaded.snapshot.working.data).toEqual(requested.working.data);
    expect(loaded.snapshot.deleteMask).toEqual(requested.deleteMask);
    expect(fork.id).not.toBe(created.id);
    expect(fork.snapshot.working.data).toEqual(requested.working.data);
    expect((await readFile(path.join(fork.folder, 'original.png'))).equals(original)).toBe(true);
  });

  it('rejects project references that escape the project or pass through a symlink', async () => {
    const root = await makeRoot();
    const store = new ProjectStore({ root });
    const created = await store.create('source-id', 'original.png', await png(pixels([1, 2, 3, 255])), snapshot());
    const manifestPath = path.join(created.folder, 'project.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.original.file = '../outside.png';
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(store.open(created.folder)).rejects.toThrow();

    const second = await store.create('source-id-2', 'original.png', await png(pixels([1, 2, 3, 255])), snapshot());
    const outside = path.join(root, 'outside.png');
    await writeFile(outside, await png(pixels([7, 7, 7, 255])));
    await rm(path.join(second.folder, 'original.png'));
    await symlink(outside, path.join(second.folder, 'original.png'));
    await expect(store.open(second.folder)).rejects.toThrow();
  });

  it('exports a new PNG without overwriting an original or following its symlink', async () => {
    const root = await makeRoot();
    const originalPath = path.join(root, 'photo.png');
    const original = await png(pixels([15, 25, 35, 255]));
    await writeFile(originalPath, original);
    const store = new ProjectStore({ root: path.join(root, 'projects') });
    const project = await store.create('source-id', 'photo.png', original, snapshot(), originalPath);

    await expect(store.exportPNG(project.id, pixels([100, 110, 120, 255]), originalPath)).rejects.toThrow(/원본/);
    const alias = path.join(root, 'alias.png');
    await symlink(originalPath, alias);
    await expect(store.exportPNG(project.id, pixels([100, 110, 120, 255]), alias)).rejects.toThrow(/원본/);
    const hardlink = path.join(root, 'hardlink.png');
    await link(originalPath, hardlink);
    await expect(store.exportPNG(project.id, pixels([100, 110, 120, 255]), hardlink)).rejects.toThrow(/원본/);

    const chosen = path.join(root, 'final.png');
    await writeFile(chosen, 'keep this file');
    const result = await store.exportPNG(project.id, pixels([100, 110, 120, 255]), chosen);
    expect(result.path).toBe(path.join(await realpath(root), 'final (1).png'));
    expect(await readFile(chosen, 'utf8')).toBe('keep this file');
    expect((await sharp(await readFile(result.path)).metadata()).format).toBe('png');
  });

  it('clones Save As history directly into the chosen folder without writing to the default root', async () => {
    const root = await makeRoot();
    const managedRoot = path.join(root, 'managed');
    const store = new ProjectStore({ root: managedRoot });
    const original = await png(pixels([1, 2, 3, 255]));
    const project = await store.create('source-id', 'original.png', original, snapshot());
    const firstRequest = await store.createRequest(project.id, { ...snapshot(1), working: pixels([4, 5, 6, 255]) }, pixels([255, 0, 0, 255]));
    const secondRequest = await store.createRequest(project.id, { ...snapshot(2), working: pixels([7, 8, 9, 255]) }, pixels([0, 0, 255, 255]));
    const candidateBytes = await png(pixels([50, 60, 70, 255]));
    await store.addCandidate(project.id, firstRequest.info.id, 'result.png', candidateBytes, pixels([50, 60, 70, 255]));

    const destination = path.join(root, 'save-as');
    const defaultRootBefore = await readdir(managedRoot);
    let defaultRootWrites = 0;
    const saveAsStore = new ProjectStore({
      root: managedRoot,
      replaceFile: async (temporary, target) => {
        if (target.startsWith(`${managedRoot}${path.sep}`)) {
          defaultRootWrites += 1;
          throw new Error('default root is unwritable');
        }
        const { rename } = await import('node:fs/promises');
        await rename(temporary, target);
      },
    });
    const clone = await saveAsStore.cloneProject(project.id, { ...snapshot(3), working: pixels([10, 11, 12, 255]) }, destination);
    expect(defaultRootWrites).toBe(0);
    expect(await readdir(managedRoot)).toEqual(defaultRootBefore);
    expect(clone.id).not.toBe(project.id);
    expect(clone.folder).toBe(path.join(destination, clone.id));
    expect(clone.requests.map(request => request.id)).toEqual([firstRequest.info.id, secondRequest.info.id]);
    expect((await saveAsStore.loadRequest(clone.id, firstRequest.info.id)).info.projectId).toBe(clone.id);
    expect((await saveAsStore.loadRequest(clone.id, secondRequest.info.id)).info.projectId).toBe(clone.id);
    expect((await saveAsStore.loadCandidate(clone.id, firstRequest.info.id))?.pixels.data).toEqual(pixels([50, 60, 70, 255]).data);
    expect(await readFile(path.join(clone.folder, 'original.png'))).toEqual(original);
    const manifest = JSON.parse(await readFile(path.join(clone.folder, 'project.json'), 'utf8'));
    expect(manifest.requests[0].projectId).toBe(clone.id);
    const metadata = JSON.parse(await readFile(path.join(clone.folder, 'requests', firstRequest.info.id, 'metadata.json'), 'utf8'));
    expect(metadata).toMatchObject({ projectId: clone.id, sourceProjectId: project.id });
    await saveAsStore.save(clone.id, { ...snapshot(4), working: pixels([20, 21, 22, 255]) });
    const candidate = manifest.candidates[0];
    await writeFile(path.join(clone.folder, candidate.file), 'corrupted candidate');
    const recovered = await saveAsStore.open(clone.folder);
    expect(recovered.recovered).toBe(true);
    expect(recovered.snapshot.workVersion).toBe(4);
    expect(recovered.requests).toHaveLength(2);
    await expect(saveAsStore.loadCandidate(clone.id, firstRequest.info.id)).rejects.toThrow(/손상/);
  });

  it('rejects a request snapshot that points outside its request folder', async () => {
    const store = new ProjectStore({ root: await makeRoot() });
    const project = await store.create('source-id', 'original.png', await png(pixels([1, 2, 3, 255])), snapshot());
    const request = await store.createRequest(project.id, snapshot(1), pixels([255, 0, 0, 255]));
    await store.save(project.id, { ...snapshot(2), working: pixels([4, 5, 6, 255]) });
    const metadataPath = path.join(project.folder, 'requests', request.info.id, 'metadata.json');
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    metadata.snapshot.working = '../outside.png';
    await writeFile(metadataPath, JSON.stringify(metadata));

    await expect(store.loadRequest(project.id, request.info.id)).rejects.toThrow();
    const recovered = await store.open(project.folder);
    expect(recovered.recovered).toBe(true);
    expect(recovered.snapshot.workVersion).toBe(2);
    expect(recovered.requests).toHaveLength(1);
  });
});
