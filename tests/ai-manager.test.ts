import type { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const workers = vi.hoisted(() => [] as Array<EventEmitter & { terminate: ReturnType<typeof vi.fn> }>);
vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events');
  return {
  Worker: class extends EventEmitter {
    terminate = vi.fn(async () => { this.emit('exit', 0); return 0; });
    constructor() { super(); workers.push(this); }
  },
  };
});
import { TextDetectionService } from '../src/main/ai-manager';
const id = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const pixels = () => ({ width: 2, height: 1, data: new Uint8ClampedArray([30, 40, 50, 255, 60, 70, 80, 255]) });

describe('bounded cancellable local AI service', () => {
  let service: TextDetectionService;
  beforeEach(() => { workers.length = 0; service = new TextDetectionService('/bundled/model.onnx', '/bundled/ai-worker.js'); });
  afterEach(() => { service.dispose(); vi.useRealTimers(); });

  it('rejects malformed pixels and identifiers before starting native code', async () => {
    for (const p of [ { ...pixels(), width: 0 }, { ...pixels(), width: 25_000_001 }, { ...pixels(), data: new Uint8ClampedArray(1) } ]) {
      await expect(service.detect(p, id)).rejects.toThrow();
    }
    await expect(service.detect(pixels(), 'bad-id')).rejects.toThrow();
    expect(workers).toHaveLength(0);
  });

  it('accepts only a correctly sized binary mask and preserves the caller image', async () => {
    const p = pixels(); const before = p.data.slice();
    const result = service.detect(p, id);
    workers[0].emit('message', new Uint8Array([255, 0]));
    await expect(result).resolves.toEqual(new Uint8Array([255, 0]));
    expect(p.data).toEqual(before);
    expect(workers[0].terminate).toHaveBeenCalledOnce();
  });

  it('rejects short or nonbinary native output without returning a partial result', async () => {
    const result = service.detect(pixels(), id);
    workers[0].emit('message', new Uint8Array([128, 0]));
    await expect(result).rejects.toThrow();
    expect(workers[0].terminate).toHaveBeenCalledOnce();
  });

  it('allows one active inference, ignores other cancellation IDs, and terminates on cancellation', async () => {
    const result = service.detect(pixels(), id);
    const cancelled = expect(result).rejects.toThrow(/취소/);
    await expect(service.detect(pixels(), otherId)).rejects.toThrow();
    service.cancel(otherId); expect(workers[0].terminate).not.toHaveBeenCalled();
    service.cancel(id); await cancelled;
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    workers[0].emit('message', new Uint8Array([255, 255]));
  });

  it('times out stalled native work and surfaces worker crashes as failures', async () => {
    vi.useFakeTimers();
    const result = service.detect(pixels(), id);
    const timeout = expect(result).rejects.toThrow(/시간/);
    await vi.advanceTimersByTimeAsync(60_000); await timeout;
    const retry = service.detect(pixels(), otherId);
    const failure = expect(retry).rejects.toThrow();
    workers[1].emit('error', new Error('native failure with private path'));
    await failure;
  });
});
