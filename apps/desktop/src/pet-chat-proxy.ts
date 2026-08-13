import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const maximumRequestBytes = 256 * 1024;
const maximumResponseBytes = 4 * 1024 * 1024;
const maximumConversationMessages = 24;
const maximumMessageCharacters = 24_000;

const sharedPetInstructions = [
  '先在心里判断用户这一轮是在交办任务，还是在进行普通问答；不要向用户输出分类过程。',
  '任务型请求包括要求你创作、修改、分析、规划、比较、计算、翻译、排查或产出明确结果。对于任务型请求，直接完成力所能及的交付物，不要只讲方法；信息不足时只追问完成任务所必需的问题。',
  '普通问答包括知识问题、解释、闲聊、建议和开放讨论。对于普通问答，直接自然地回答问题，不要强行附加行动计划、负责人、优先级、验收标准或任务清单。',
  '只有在确实有帮助时才使用分点或步骤；简单问题优先简洁回答。',
  '不要声称已经执行尚未执行的外部操作。若任务必须读取项目、修改文件、运行命令或操作设备，明确建议用户进入 COD 工作台继续。',
].join('\n');

export const desktopPetPersonaPrompts = Object.freeze({
  k: [
    '你是 COD 项目组的成员小K，角色是可靠执行官。你的语气温暖、稳定、利落。',
    sharedPetInstructions,
    '处理任务时，优先给出可直接使用的结果，并在必要时补充下一步与验收方式。处理普通问答时，像一个可靠、清楚的通用助手一样直接回答，不要把问题任务化。',
  ].join('\n'),
  a: [
    '你是 COD 项目组的成员小A，角色是灵感探索家。你的语气明亮、好奇、有创造力。',
    sharedPetInstructions,
    '处理任务时，可提供有区分度的方案并指出最快验证办法，但先交付用户明确要求的内容。处理普通问答时，直接给出清楚答案；只有用户需要创意或存在明显多种可能时才展开备选方向。',
  ].join('\n'),
  i: [
    '你是 COD 项目组的成员小I，角色是智慧分析师。你的语气低缓、克制、耐心。',
    sharedPetInstructions,
    '处理任务时，区分事实、假设和判断，抓住关键约束并完成分析结果。处理普通问答时，直接解释结论与必要依据；不要把每个问题都拆成流程或阻塞点。',
  ].join('\n'),
});

type DesktopPetPersonaId = keyof typeof desktopPetPersonaPrompts;

function personaFromMessages(messages: unknown[]): DesktopPetPersonaId {
  const systemContent = messages
    .filter((message): message is { role?: unknown; content?: unknown } => Boolean(message && typeof message === 'object'))
    .find((message) => message.role === 'system')?.content;
  if (typeof systemContent === 'string') {
    if (/小A|灵感探索家/.test(systemContent)) return 'a';
    if (/小I|智慧分析师/.test(systemContent)) return 'i';
  }
  return 'k';
}

export function buildDesktopPetMessages(messages: unknown[]): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const persona = personaFromMessages(messages);
  const conversation = messages
    .filter((message): message is { role?: unknown; content?: unknown } => Boolean(message && typeof message === 'object'))
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({
      role: message.role as 'user' | 'assistant',
      content: typeof message.content === 'string' ? message.content.trim().slice(0, maximumMessageCharacters) : '',
    }))
    .filter((message) => message.content)
    .slice(-maximumConversationMessages);
  return [{ role: 'system', content: desktopPetPersonaPrompts[persona] }, ...conversation];
}

export interface PetChatProxy {
  url: string;
  secret: string;
  close(): Promise<void>;
}

interface PetChatProxyOptions {
  controlPlaneUrl: string;
  token: string;
  sourceId: string;
  modelId: string;
  fetchImpl?: typeof fetch;
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximumRequestBytes) throw new Error('REQUEST_TOO_LARGE');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function send(response: ServerResponse, status: number, body: string): void {
  if (response.writableEnded) return;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(body);
}

function validCredential(value: string, maximumLength: number): boolean {
  return Boolean(value && value.length <= maximumLength && value.trim() === value && !/[\0\r\n]/.test(value));
}

export async function startPetChatProxy(options: PetChatProxyOptions): Promise<PetChatProxy> {
  const { controlPlaneUrl, token, sourceId, modelId, fetchImpl = fetch } = options;
  if (!validCredential(token, 8_192)) throw new Error('A valid COD session is required for desktop-pet chat');
  if (!/^[a-z0-9-]{2,40}$/.test(sourceId)) throw new Error('Desktop-pet model source is invalid');
  if (!validCredential(modelId, 200)) throw new Error('Desktop-pet model is invalid');
  const upstream = new URL('/v1/chat/completions', controlPlaneUrl);
  if (upstream.username || upstream.password || upstream.hash || (upstream.protocol !== 'https:'
    && !(upstream.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(upstream.hostname)))) {
    throw new Error('Desktop-pet chat requires HTTPS or a loopback development control plane');
  }
  const secret = randomBytes(32).toString('base64url');
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        send(response, 404, '{"error":{"message":"Not found"}}');
        return;
      }
      if (request.headers.authorization !== `Bearer ${secret}`) {
        send(response, 401, '{"error":{"message":"Unauthorized"}}');
        return;
      }
      const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
      if (contentType !== 'application/json') {
        send(response, 415, '{"error":{"message":"JSON required"}}');
        return;
      }
      const body = JSON.parse((await readBody(request)).toString('utf8')) as Record<string, unknown>;
      if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.messages)) {
        send(response, 400, '{"error":{"message":"Invalid chat request"}}');
        return;
      }
      const controller = new AbortController();
      const cancel = () => controller.abort();
      request.once('aborted', cancel);
      response.once('close', cancel);
      try {
        const upstreamResponse = await fetchImpl(upstream, {
          method: 'POST',
          headers: {
            accept: 'text/event-stream, application/json',
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            'x-request-id': randomBytes(16).toString('hex'),
          },
          body: JSON.stringify({
            ...body,
            source: sourceId,
            model: modelId,
            messages: buildDesktopPetMessages(body.messages),
            stream: body.stream === true,
            max_tokens: Math.min(4_096, Number.isInteger(body.max_tokens) ? Number(body.max_tokens) : 4_096),
          }),
          cache: 'no-store',
          credentials: 'omit',
          redirect: 'error',
          signal: controller.signal,
        });
        const payload = Buffer.from(await upstreamResponse.arrayBuffer());
        if (payload.length > maximumResponseBytes) {
          send(response, 502, '{"error":{"message":"Model response is too large"}}');
          return;
        }
        response.writeHead(upstreamResponse.status, {
          'content-type': upstreamResponse.headers.get('content-type') || 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        response.end(payload);
      } finally {
        request.removeListener('aborted', cancel);
        response.removeListener('close', cancel);
      }
    } catch (error) {
      if (response.writableEnded || response.destroyed) return;
      const tooLarge = error instanceof Error && error.message === 'REQUEST_TOO_LARGE';
      send(response, tooLarge ? 413 : 502, `{"error":{"message":"${tooLarge ? 'Request is too large' : 'Desktop-pet chat unavailable'}"}}`);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Desktop-pet chat proxy did not bind a loopback port');
  }
  return Object.freeze({
    url: `http://127.0.0.1:${address.port}/v1/chat/completions`,
    secret,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  });
}
