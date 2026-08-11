import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError } from './errors.js';

export async function readJson<T>(request: IncomingMessage): Promise<T> {
  const body = await readText(request);
  try {
    return JSON.parse(body || '{}') as T;
  } catch {
    throw new HttpError('Request body must be valid JSON', 400, 'invalid_json');
  }
}

export async function readText(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 1024 * 1024) throw new HttpError('Request body is too large', 413, 'body_too_large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}

export function sendText(response: ServerResponse, status: number, value: string): void {
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(value);
}

export function bearerToken(request: IncomingMessage): string | null {
  const value = request.headers.authorization;
  return value?.startsWith('Bearer ') ? value.slice(7) : null;
}
