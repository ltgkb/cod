import { GooseClient, type GooseClientCallbacks } from '@aaif/goose-sdk';
import { PROTOCOL_VERSION, type RequestPermissionRequest, type SessionNotification } from '@agentclientprotocol/sdk';

export interface GooseRunUpdate {
  kind: 'message' | 'thought' | 'tool' | 'permission' | 'status';
  text: string;
  data?: unknown;
}

export interface GooseRunOptions {
  acpUrl: string;
  cwd: string;
  prompt: string;
  onUpdate(update: GooseRunUpdate): void;
  requestPermission(request: RequestPermissionRequest): Promise<string | null>;
}

function createWebSocketStream(wsUrl: string) {
  const socket = new WebSocket(wsUrl);
  const incoming: unknown[] = [];
  const waiters: Array<() => void> = [];
  let closed = false;
  const opened = new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('Goose ACP connection failed')), { once: true });
  });
  socket.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') return;
    incoming.push(JSON.parse(event.data));
    waiters.shift()?.();
  });
  socket.addEventListener('close', () => {
    closed = true;
    for (const waiter of waiters.splice(0)) waiter();
  });
  return {
    readable: new ReadableStream({
      async pull(controller) {
        if (!incoming.length && !closed) await new Promise<void>((resolve) => waiters.push(resolve));
        while (incoming.length) controller.enqueue(incoming.shift());
        if (closed) controller.close();
      },
    }),
    writable: new WritableStream({
      async write(message) {
        await opened;
        socket.send(JSON.stringify(message));
      },
      close() { socket.close(); },
      abort() { socket.close(); },
    }),
    close: () => socket.close(),
  };
}

function sessionUpdateText(notification: SessionNotification): GooseRunUpdate | null {
  const update = notification.update;
  if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') return { kind: 'message', text: update.content.text };
  if (update.sessionUpdate === 'agent_thought_chunk' && update.content.type === 'text') return { kind: 'thought', text: update.content.text };
  if (update.sessionUpdate === 'tool_call') return { kind: 'tool', text: update.title, data: update };
  if (update.sessionUpdate === 'tool_call_update') return { kind: 'tool', text: update.title ?? '工具状态更新', data: update };
  return null;
}

export async function runGooseTask(options: GooseRunOptions): Promise<string> {
  const stream = createWebSocketStream(options.acpUrl);
  let answer = '';
  const callbacks = (): GooseClientCallbacks => ({
    sessionUpdate: async (notification) => {
      const update = sessionUpdateText(notification);
      if (!update) return;
      if (update.kind === 'message') answer += update.text;
      options.onUpdate(update);
    },
    requestPermission: async (request) => {
      options.onUpdate({ kind: 'permission', text: request.toolCall.title, data: request });
      const optionId = await options.requestPermission(request);
      return optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } };
    },
  });
  const client = new GooseClient(callbacks, stream);
  try {
    await client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: 'cod', version: '0.1.0' },
    });
    const created = await client.newSession({ cwd: options.cwd, mcpServers: [], _meta: { client: 'cod-desktop' } });
    const sessionId = String(created.sessionId);
    options.onUpdate({ kind: 'status', text: 'Goose 会话已创建' });
    await client.prompt({ sessionId, prompt: [{ type: 'text', text: options.prompt }] });
    return answer;
  } finally {
    stream.close();
  }
}
