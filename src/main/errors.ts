export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}

export function safeErrorMessage(error: unknown): string {
  if (error instanceof UserError) return error.message;
  return '작업을 완료하지 못했습니다. 입력과 저장 위치를 확인한 뒤 다시 시도해 주세요.';
}
