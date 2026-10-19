import { UserError, safeErrorMessage } from './errors';

export const CHATGPT_URL = 'https://chatgpt.com/';
export { safeErrorMessage };

export function isTrustedSender(senderId: number, mainWindowId: number): boolean {
  return Number.isSafeInteger(senderId) && senderId === mainWindowId;
}

export function requireObject(value: unknown, message = '잘못된 요청입니다.'): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new UserError(message);
}

export function requireId(value: unknown, message = '작업을 찾을 수 없습니다.'): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new UserError(message);
  }
  return value;
}
