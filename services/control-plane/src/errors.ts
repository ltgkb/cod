export class HttpError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
  }
}

export function errorResponse(error: unknown): { status: number; body: { error: string; message: string } } {
  if (error instanceof HttpError) return { status: error.status, body: { error: error.code, message: error.message } };
  return { status: 500, body: { error: 'internal_error', message: 'Internal server error' } };
}
