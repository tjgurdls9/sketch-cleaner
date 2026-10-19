import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
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

  it('rejects a stale work version and malformed snapshot dimensions', async () => {
    const store = new ProjectStore({ root: await makeRoot() });
    const created = await store.create('source-id', 'original.png', await png(pixels([1, 2, 3, 255])), snapshot());
    await store.save(created.id, { ...snapshot(2), working: pixels([9, 8, 7, 255]) });

    await expect(store.save(created.id, snapshot(1))).rejects.toThrow(/버전|변경/);
    await expect(store.save(created.id, { ...snapshot(3), baseVersion: 'other-project' })).rejects.toThrow(/버전|기준/);
    await expect(store.save(created.id, {
      ...snapshot(3), deleteMask: new Uint8Array(3),
    })).rejects.toThrow(/마스크|크기|이미지/);
  });

  it('round-trips mask intensities and RGBA bytes without quantizing them', async () => {
    const store = new ProjectStore({ root: await makeRoot() });
    const created = await store.create('source-id', 'original.png', await png(pixels([1, 2, 3, 255])), snapshot());
    const edited: Snapshot = {
      ...snapshot(1),
      working: { ...pixels([1, 2, 3, 255]), data: new Uint8ClampedArray([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]) },
      deleteMask: new Uint8Array([0, 64, 128, 255]),
      protectMask: new Uint8Array([255, 128, 64, 0]),
    };
    await store.save(created.id, edited);
    const reopened = await store.open(created.folder);

    expect(reopened.snapshot.working.data).toEqual(edited.working.data);
    expect(reopened.snapshot.deleteMask).toEqual(edited.deleteMask);
    expect(reopened.snapshot.protectMask).toEqual(edited.protectMask);
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
});
