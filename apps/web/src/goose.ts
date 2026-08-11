import { GooseClient, type GooseClientCallbacks } from '@aaif/goose-sdk';
import { PROTOCOL_VERSION, type RequestPermissionRequest, type SessionNotification, type ToolCallStatus, type ToolKind } from '@agentclientprotocol/sdk';

export interface GooseRunUpdate {
  kind: 'message' | 'thought' | 'tool' | 'permission' | 'status';
  text: string;
  data?: unknown;
}

export interface GooseRunOptions {
  acpUrl: string;
  cwd: string;
  prompt: string;
  signal?: AbortSignal;
  onUpdate(update: GooseRunUpdate): void;
  requestPermission(request: RequestPermissionRequest): Promise<string | null>;
}

export interface GooseRunResult {
  answer: string;
  toolCalls: number;
  completedTools: number;
  failedTools: number;
  mutationTools: number;
}

interface TrackedToolCall { kind: ToolKind; status: ToolCallStatus }

// Goose reports its Developer shell tool as `execute`. Shell commands are a
// supported way to create files, so they must count as a real project action.
const mutationKinds = new Set<ToolKind>(['edit', 'delete', 'move', 'execute']);
const mutationRequestPattern = /(?:创建|新建|生成|实现|开发|编写|修改|修复|优化|重构|添加|删除|替换|改成|做一个|搭建|安装|升级|create|build|implement|develop|write|modify|edit|fix|optimi[sz]e|refactor|add|delete|remove|replace|install|upgrade)/i;

export function buildCodeExecutionPrompt(prompt: string): string {
  return `You are COD's coding agent operating inside the selected local project. Execute the user's request now with the Developer tools available to you. Inspect the project before changing it, then use Developer write/edit/shell tools to make the requested file changes. For a creation or modification request, perform a real file-changing tool call before marking any TODO item complete or writing a completion message. Verify the result with an appropriate command when possible. Do not merely promise to start, describe hypothetical work, or claim completion without using tools. If execution is blocked, report the concrete blocker instead of claiming success.\n\nUser request:\n${prompt}`;
}

export function validateCodeRun(prompt: string, result: GooseRunResult): void {
  if (result.toolCalls === 0) throw new Error('COD 没有执行任何项目工具，因此未将本次任务标记为完成。请重试；若仍出现此提示，请检查桌面端 Developer Tools。');
  if (result.failedTools > 0 && result.completedTools === 0) throw new Error('COD 调用的项目工具全部失败，因此未将本次任务标记为完成。请查看工具状态后重试。');
  if (mutationRequestPattern.test(prompt) && result.mutationTools === 0) throw new Error('COD 完成了项目检查，但没有执行文件修改，因此未将本次创建或修改任务标记为完成。');
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

export async function runGooseTask(options: GooseRunOptions): Promise<GooseRunResult> {
  if(options.signal?.aborted)throw options.signal.reason??new DOMException('Task cancelled','AbortError');
  const stream = createWebSocketStream(options.acpUrl);
  const abort=()=>stream.close();options.signal?.addEventListener('abort',abort,{once:true});
  let answer = '';
  const toolCalls = new Map<string, TrackedToolCall>();
  const callbacks = (): GooseClientCallbacks => ({
    sessionUpdate: async (notification) => {
      const sessionUpdate=notification.update;
      if(sessionUpdate.sessionUpdate==='tool_call')toolCalls.set(sessionUpdate.toolCallId,{kind:sessionUpdate.kind??'other',status:sessionUpdate.status??'pending'});
      if(sessionUpdate.sessionUpdate==='tool_call_update'){
        const current=toolCalls.get(sessionUpdate.toolCallId)??{kind:'other' as const,status:'pending' as const};
        toolCalls.set(sessionUpdate.toolCallId,{kind:sessionUpdate.kind??current.kind,status:sessionUpdate.status??current.status});
      }
      const update = sessionUpdateText(notification);
      if (!update) return;
      if (update.kind === 'message') answer += update.text;
      options.onUpdate(update);
    },
    requestPermission: async (request) => {
      options.onUpdate({ kind: 'permission', text: request.toolCall.title ?? '工具权限请求', data: request });
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
    if(options.signal?.aborted)throw options.signal.reason??new DOMException('Task cancelled','AbortError');
    const created = await client.newSession({ cwd: options.cwd, mcpServers: [], _meta: { client: 'cod-desktop' } });
    const sessionId = String(created.sessionId);
    options.onUpdate({ kind: 'status', text: 'Goose 会话已创建' });
    await client.prompt({ sessionId, prompt: [{ type: 'text', text: options.prompt }] });
    if(options.signal?.aborted)throw options.signal.reason??new DOMException('Task cancelled','AbortError');
    const executions=[...toolCalls.values()];
    return {
      answer,
      toolCalls:executions.length,
      completedTools:executions.filter((tool)=>tool.status==='completed').length,
      failedTools:executions.filter((tool)=>tool.status==='failed').length,
      mutationTools:executions.filter((tool)=>mutationKinds.has(tool.kind)&&tool.status!=='failed').length,
    };
  } finally {
    options.signal?.removeEventListener('abort',abort);
    stream.close();
  }
}
