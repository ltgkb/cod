import path from 'node:path';

type JsonObject = Record<string, unknown>;
const allowedRendererMethods = new Set(['initialize', 'session/cancel', 'session/new', 'session/prompt']);

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidFrame(): Error {
  // Deliberately avoid including any renderer-controlled value or local path in
  // this error. The caller can safely surface/log it without leaking a project
  // location or letting untrusted frame contents forge a log line.
  return new Error('Invalid ACP JSON-RPC frame');
}

function enforceMessageCwd(message: unknown, boundRoot: string): void {
  if (!isJsonObject(message)) throw invalidFrame();

  if (message.method !== undefined
    && (typeof message.method !== 'string' || !allowedRendererMethods.has(message.method))) {
    throw new Error('ACP operation is not permitted');
  }
  if (message.method !== 'session/new') return;
  if (!isJsonObject(message.params)) throw invalidFrame();

  const cwd = message.params.cwd;
  if (typeof cwd !== 'string' || cwd.length === 0 || cwd.includes('\0')) throw invalidFrame();
  if (!Array.isArray(message.params.mcpServers)) throw invalidFrame();
  if (message.params.mcpServers.length !== 0) throw new Error('ACP MCP servers are not permitted');
  if (message.params.additionalDirectories !== undefined && !Array.isArray(message.params.additionalDirectories)) throw invalidFrame();
  if (Array.isArray(message.params.additionalDirectories) && message.params.additionalDirectories.length !== 0) {
    throw new Error('ACP additional directories are not permitted');
  }
  if (path.resolve(cwd) !== boundRoot) {
    throw new Error('ACP session/new cwd is not permitted');
  }

  // Canonicalize the value before forwarding so Goose never receives a
  // renderer-supplied spelling of the approved path (for example, `/root/.`).
  message.params.cwd = boundRoot;
}

/**
 * Validate and canonicalize one renderer-to-Goose JSON-RPC text frame.
 *
 * The root is expected to be the trusted main process's realpath result. Every
 * `session/new` request must target that exact root after lexical path
 * resolution. Batch frames are rejected because ACP maps one WebSocket text
 * frame to one protocol message.
 */
export function enforceAcpCwdPolicy(rawText: string, boundRealRoot: string): string {
  if (typeof rawText !== 'string'
    || typeof boundRealRoot !== 'string'
    || boundRealRoot.length === 0
    || boundRealRoot.includes('\0')
    || !path.isAbsolute(boundRealRoot)) {
    throw invalidFrame();
  }

  const boundRoot = path.resolve(boundRealRoot);
  let frame: unknown;
  try {
    frame = JSON.parse(rawText) as unknown;
  } catch {
    throw invalidFrame();
  }

  // ACP's WebSocket transport carries exactly one JSON-RPC object per frame.
  // Never split or partially authorize a renderer-supplied batch.
  if (Array.isArray(frame)) throw invalidFrame();
  enforceMessageCwd(frame, boundRoot);

  return JSON.stringify(frame);
}
