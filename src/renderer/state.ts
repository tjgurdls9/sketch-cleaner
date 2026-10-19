import type { Candidate, RequestInfo } from '../shared/types.ts';

export type CandidateReadiness =
  | 'missing-request'
  | 'missing-candidate'
  | 'wrong-project'
  | 'wrong-request'
  | 'stale-basis'
  | 'alignment-required'
  | 'acknowledgement-required'
  | 'ready';

export function candidateReadiness(input: {
  projectId: string;
  baseVersion: string;
  workVersion?: number;
  request: RequestInfo | null;
  candidate: Candidate | null;
  aligned: boolean;
  acknowledged: boolean;
}): CandidateReadiness {
  const { projectId, baseVersion, request, candidate } = input;
  if (!request) return 'missing-request';
  if (!candidate) return 'missing-candidate';
  if (request.projectId !== projectId) return 'wrong-project';
  if (candidate.requestId !== request.id) return 'wrong-request';
  if (request.baseVersion !== baseVersion) return 'stale-basis';
  if (!input.aligned) return 'alignment-required';
  if (!input.acknowledged) return 'acknowledgement-required';
  return 'ready';
}

export type AffineTransform = { a: number; b: number; c: number; d: number; e: number; f: number };

export function fitCandidateTransform(
  baseWidth: number,
  baseHeight: number,
  candidateWidth: number,
  candidateHeight: number,
  scaleFactor = 1,
  rotationDegrees = 0,
  offsetX = 0,
  offsetY = 0,
): AffineTransform {
  const values = [baseWidth, baseHeight, candidateWidth, candidateHeight, scaleFactor, rotationDegrees, offsetX, offsetY];
  if (values.some(value => !Number.isFinite(value)) || values.slice(0, 5).some(value => value <= 0)) {
    throw new RangeError('정렬 값은 양수 크기와 유효한 숫자여야 합니다.');
  }
  const scale = Math.min(baseWidth / candidateWidth, baseHeight / candidateHeight) * scaleFactor;
  const angle = rotationDegrees * Math.PI / 180;
  const a = scale * Math.cos(angle);
  const b = scale * Math.sin(angle);
  const c = b === 0 ? 0 : -b;
  const d = a;
  return {
    a, b, c, d,
    e: baseWidth / 2 + offsetX - a * candidateWidth / 2 - c * candidateHeight / 2,
    f: baseHeight / 2 + offsetY - b * candidateWidth / 2 - d * candidateHeight / 2,
  };
}
