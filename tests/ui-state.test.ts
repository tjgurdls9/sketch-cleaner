import { describe, expect, it } from 'vitest';
import { candidateReadiness, fitCandidateTransform } from '../src/renderer/state.ts';

const request = {
  id: 'request-1',
  projectId: 'project-1',
  baseVersion: 'base-1',
  workVersion: 4,
  width: 1200,
  height: 800,
  createdAt: '2026-10-19T00:00:00.000Z',
  folder: '/project/requests/request-1',
};

const candidate = { id: 'candidate-1', requestId: 'request-1', name: 'result.png', pixels: {
  width: 1200,
  height: 800,
  data: new Uint8ClampedArray(),
} };

const current = {
  projectId: 'project-1',
  baseVersion: 'base-1',
  workVersion: 4,
  request,
  candidate,
  aligned: true,
  acknowledged: true,
};

describe('candidateReadiness', () => {
  it('requires a matching active request and a current image basis before applying', () => {
    expect(candidateReadiness({ ...current, candidate: null })).toBe('missing-candidate');
    expect(candidateReadiness({ ...current, candidate: { ...candidate, requestId: 'request-2' } })).toBe('wrong-request');
    expect(candidateReadiness({ ...current, baseVersion: 'base-2' })).toBe('stale-basis');
    expect(candidateReadiness({ ...current, aligned: false })).toBe('alignment-required');
    expect(candidateReadiness({ ...current, acknowledged: false })).toBe('acknowledgement-required');
    expect(candidateReadiness(current)).toBe('ready');
  });

  it('allows a candidate after edits made while waiting if the working basis is unchanged', () => {
    expect(candidateReadiness({ ...current, workVersion: 5 })).toBe('ready');
  });

  it('blocks a request from a different project', () => {
    expect(candidateReadiness({ ...current, projectId: 'project-2' })).toBe('wrong-project');
  });
});

describe('fitCandidateTransform', () => {
  it('centers a candidate inside the base while preserving its aspect ratio', () => {
    expect(fitCandidateTransform(100, 100, 200, 100)).toEqual({
      a: 0.5, b: 0, c: 0, d: 0.5, e: 0, f: 25,
    });
  });

  it('rotates around the candidate center and applies image-coordinate offsets', () => {
    const transform = fitCandidateTransform(100, 100, 200, 100, 1, 90, 4, -2);
    expect(transform.a).toBeCloseTo(0);
    expect(transform.b).toBeCloseTo(0.5);
    expect(transform.c).toBeCloseTo(-0.5);
    expect(transform.d).toBeCloseTo(0);
    expect(transform.e).toBeCloseTo(79);
    expect(transform.f).toBeCloseTo(-2);
  });
});
