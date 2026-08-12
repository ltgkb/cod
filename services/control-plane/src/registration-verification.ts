import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request as httpRequest, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import type { RegistrationVerificationConfig, RegistrationWebhookConfig } from './config.js';
import { HttpError } from './errors.js';

export type RegistrationChannel = 'email' | 'phone';

export interface RegistrationDeliveryMessage {
  challengeId: string;
  destination: string;
  code: string;
  expiresAt: string;
}

export interface RegistrationDelivery {
  sendEmailCode(message: RegistrationDeliveryMessage): Promise<void>;
  sendSmsCode(message: RegistrationDeliveryMessage): Promise<void>;
}

// Validates an outbound registration endpoint URL and returns the single
// pinned public IP address that must be used for the subsequent connection.
// Resolving once and pinning the address closes the DNS-rebinding TOCTOU that
// would otherwise let a hostname resolve to a public address during validation
// and to a private address at connect time.
export type RegistrationEndpointValidator = (url: string, allowedHostnames: string[], label: string) => Promise<string>;

export interface PinnedFetchRequest {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}

// Connects to the supplied URL using the pinned IP address for the underlying
// socket while keeping TLS SNI/Host and certificate validation bound to the
// URL hostname. Redirects are rejected (the prior fetch used redirect:'error').
export type PinnedFetcher = (url: string, pinnedAddress: string, init: PinnedFetchRequest) => Promise<Response>;

export const REGISTRATION_OTP_DIGITS = 6;

function normalizedHostname(value:string):string{return value.toLowerCase().replace(/\.$/,'');}

export function isPrivateRegistrationAddress(value:string):boolean{
  if(isIP(value)===4){const octets=value.split('.').map(Number);return octets[0]===0||octets[0]===10||octets[0]===100&&octets[1]>=64&&octets[1]<=127||octets[0]===127||octets[0]===169&&octets[1]===254||octets[0]===172&&octets[1]>=16&&octets[1]<=31||octets[0]===192&&octets[1]===0&&octets[2]===0||octets[0]===192&&octets[1]===0&&octets[2]===2||octets[0]===192&&octets[1]===168||octets[0]===198&&octets[1]>=18&&octets[1]<=19||octets[0]===198&&octets[1]===51&&octets[2]===100||octets[0]===203&&octets[1]===0&&octets[2]===113||octets[0]>=224;}
  if(isIP(value)!==6)return true;
  let normalized=value.toLowerCase();
  if(normalized.includes('.')){
    const separator=normalized.lastIndexOf(':');const octets=normalized.slice(separator+1).split('.').map(Number);
    if(octets.length!==4||octets.some((octet)=>!Number.isInteger(octet)||octet<0||octet>255))return true;
    normalized=`${normalized.slice(0,separator)}:${((octets[0]<<8)|octets[1]).toString(16)}:${((octets[2]<<8)|octets[3]).toString(16)}`;
  }
  const [head='',tail='']=normalized.split('::');
  const left=head?head.split(':'):[];const right=tail?tail.split(':'):[];
  const groups=[...left,...Array(Math.max(0,8-left.length-right.length)).fill('0'),...right].map((group)=>Number.parseInt(group||'0',16));
  if(groups.length===8&&groups.slice(0,5).every((group)=>group===0)&&groups[5]===0xffff){
    return isPrivateRegistrationAddress(`${groups[6]>>8}.${groups[6]&255}.${groups[7]>>8}.${groups[7]&255}`);
  }
  return normalized==='::'||normalized==='::1'||normalized.startsWith('fc')||normalized.startsWith('fd')||/^fe[89ab]/.test(normalized)||normalized.startsWith('ff')||normalized.startsWith('fec')||normalized.startsWith('fed')||normalized.startsWith('fee')||normalized.startsWith('fef')||normalized.startsWith('2001:db8');
}

async function assertSafeRegistrationEndpoint(rawUrl:string,allowedHostnames:string[],label:string):Promise<string>{
  let url:URL;try{url=new URL(rawUrl);}catch{throw new Error(`${label} URL is invalid`);}
  const hostname=normalizedHostname(url.hostname.replace(/^\[|\]$/g,''));
  if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443')||!allowedHostnames.includes(hostname)||isIP(hostname))throw new Error(`${label} endpoint is not allowed`);
  const addresses=await lookup(hostname,{all:true,verbatim:true});
  if(addresses.length===0||addresses.some(({address})=>isPrivateRegistrationAddress(address)))throw new Error(`${label} endpoint resolved to a private address`);
  const pinned=addresses.find(({address})=>!isPrivateRegistrationAddress(address));
  if(!pinned)throw new Error(`${label} endpoint resolved to a private address`);
  return pinned.address;
}

// Builds a dns.lookup-compatible callback that always returns the pinned
// address, so the TCP connection target is fixed regardless of live DNS.
export function pinnedLookup(pinnedAddress:string):LookupFunction{
  const family=isIP(pinnedAddress)===6?6:4;
  return ((_hostname:string,_options:unknown,callback:(err:NodeJS.ErrnoException|null,address:string|Array<unknown>,family?:number)=>void):void=>{
    callback(null,pinnedAddress,family);
  }) as unknown as LookupFunction;
}

export const defaultPinnedFetcher:PinnedFetcher=(url,pinnedAddress,init)=>new Promise((resolve,reject)=>{
  let parsed:URL;try{parsed=new URL(url);}catch{reject(new Error('invalid pinned URL'));return;}
  const isTls=parsed.protocol==='https:';
  if(!isTls){reject(new Error('pinned outbound must use HTTPS'));return;}
  const options:RequestOptions={method:init.method,headers:init.headers,hostname:parsed.hostname,port:parsed.port||443,path:`${parsed.pathname||''}${parsed.search||''}`,lookup:pinnedLookup(pinnedAddress)};
  if(init.signal)options.signal=init.signal;
  const req=httpsRequest(options,(res)=>{
    if(res.statusCode&&res.statusCode>=300&&res.statusCode<400){res.resume();reject(new Error('redirect not allowed'));return;}
    const chunks:Buffer[]=[];
    res.on('data',(chunk:Buffer)=>chunks.push(chunk));
    res.on('end',()=>{
      const body=Buffer.concat(chunks);
      const headers:Record<string,string>={};
      for(const[key,value]of Object.entries(res.headers))if(value!=null)headers[key]=Array.isArray(value)?value.join(', '):String(value);
      resolve(new Response(body,{status:res.statusCode??200,headers}));
    });
  });
  req.on('error',reject);
  if(init.body)req.write(init.body);
  req.end();
});

function decodeHmacKey(value: string): Buffer {
  if(value.startsWith('base64url:'))return Buffer.from(value.slice('base64url:'.length),'base64url');
  return value.startsWith('base64:') ? Buffer.from(value.slice('base64:'.length), 'base64') : Buffer.from(value, 'utf8');
}

function safeEqualHex(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function normalizeRegistrationEmail(raw: unknown): string {
  if (typeof raw !== 'string') throw new HttpError('请输入有效邮箱', 400, 'invalid_email');
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !/^\S+@\S+\.\S+$/.test(email)) throw new HttpError('请输入有效邮箱', 400, 'invalid_email');
  return email;
}

export function normalizeRegistrationPhone(raw: unknown): string {
  if (typeof raw !== 'string' || !/^\+[1-9][0-9]{7,14}$/.test(raw)) {
    throw new HttpError('请输入带国家区号的手机号', 400, 'invalid_phone');
  }
  return raw;
}

export function validateRegistrationChallengeId(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw)) {
    throw new HttpError('注册验证已失效，请重新开始', 400, 'invalid_registration_challenge');
  }
  return raw.toLowerCase();
}

export function validateRegistrationCode(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[0-9]{6}$/.test(raw)) {
    throw new HttpError('验证码不正确', 400, 'invalid_verification_code');
  }
  return raw;
}

export function maskRegistrationDestination(channel: RegistrationChannel, value: string): string {
  if (channel === 'phone') return `${value.slice(0, Math.min(3, value.length - 4))}${'*'.repeat(Math.max(3, value.length - 7))}${value.slice(-4)}`;
  const [local = '', domain = ''] = value.split('@');
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${'*'.repeat(Math.max(3, local.length - visible.length))}@${domain}`;
}

export class RegistrationVerification {
  readonly available: boolean;
  private readonly key: Buffer | null;

  constructor(
    readonly config: RegistrationVerificationConfig,
    private readonly delivery: RegistrationDelivery | null,
    private readonly pinnedFetcher: PinnedFetcher = defaultPinnedFetcher,
    private readonly endpointValidator:RegistrationEndpointValidator=assertSafeRegistrationEndpoint,
  ) {
    this.key = config.hmacKey ? decodeHmacKey(config.hmacKey) : null;
    this.available = Boolean(this.key?.length === 32 && delivery && config.turnstileSiteKey && config.turnstileSecretKey);
  }

  createCode(challengeId: string, channel: RegistrationChannel, destination: string): { code: string; hash: string } {
    if (!this.key) throw new HttpError('账号注册暂不可用', 503, 'registration_unavailable');
    const code = randomInt(0, 1_000_000).toString().padStart(REGISTRATION_OTP_DIGITS, '0');
    return { code, hash: this.hashCode(challengeId, channel, destination, code) };
  }

  hashCode(challengeId: string, channel: RegistrationChannel, destination: string, code: string): string {
    if (!this.key) throw new HttpError('账号注册暂不可用', 503, 'registration_unavailable');
    return createHmac('sha256', this.key)
      .update(`cod-registration-otp-v1\0${challengeId}\0${channel}\0${destination}\0${code}`)
      .digest('hex');
  }

  matchesCode(expectedHash: string, challengeId: string, channel: RegistrationChannel, destination: string, code: string): boolean {
    return safeEqualHex(expectedHash, this.hashCode(challengeId, channel, destination, code));
  }

  rateLimitKey(scope: string, value: string): string {
    if (!this.key) throw new HttpError('账号注册暂不可用', 503, 'registration_unavailable');
    return createHmac('sha256', this.key).update(`cod-registration-rate-v1\0${scope}\0${value}`).digest('hex');
  }

  requestFingerprint(input: { challengeId: string; email: string; phone: string; password: string; inviteCode: string | null }): string {
    if (!this.key) throw new HttpError('账号注册暂不可用', 503, 'registration_unavailable');
    return createHmac('sha256', this.key)
      .update('cod-registration-request-v1\0')
      .update(JSON.stringify(input))
      .digest('hex');
  }

  async verifyHuman(token: unknown, expectedAction:string, remoteIp?: string): Promise<void> {
    if (!this.config.turnstileSecretKey) throw new HttpError('人机验证服务暂不可用', 503, 'human_verification_unavailable');
    if (typeof token !== 'string' || !token || token.length > 2048) {
      throw new HttpError('请完成人机验证', 400, 'human_verification_required');
    }
    const form = new URLSearchParams({
      secret: this.config.turnstileSecretKey,
      response: token,
      idempotency_key: randomUUID(),
    });
    if (remoteIp) form.set('remoteip', remoteIp);
    try {
      const pinnedAddress=await this.endpointValidator(this.config.turnstileVerifyUrl,['challenges.cloudflare.com'],'Turnstile');
      const response = await this.pinnedFetcher(this.config.turnstileVerifyUrl, pinnedAddress, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) throw new Error('verification provider unavailable');
      const result = await response.json() as { success?: unknown;hostname?:unknown;action?:unknown };
      const hostname=typeof result.hostname==='string'?normalizedHostname(result.hostname):'';
      if (result.success !== true||!this.config.turnstileExpectedHostnames.includes(hostname)||!this.config.turnstileExpectedActions.includes(expectedAction)||result.action!==expectedAction) throw new HttpError('人机验证失败，请重试', 400, 'human_verification_failed');
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError('人机验证服务暂不可用', 503, 'human_verification_unavailable');
    }
  }

  async deliver(channel: RegistrationChannel, message: RegistrationDeliveryMessage): Promise<void> {
    if (!this.delivery) throw new HttpError('验证码发送服务暂不可用', 503, 'registration_delivery_unavailable');
    try {
      if (channel === 'email') await this.delivery.sendEmailCode(message);
      else await this.delivery.sendSmsCode(message);
    } catch {
      throw new HttpError('验证码发送失败，请稍后重试', 503, 'registration_delivery_failed');
    }
  }
}

class WebhookRegistrationDelivery implements RegistrationDelivery {
  constructor(
    private readonly email: RegistrationWebhookConfig,
    private readonly sms: RegistrationWebhookConfig,
    private readonly pinnedFetcher: PinnedFetcher,
    private readonly allowedHostnames: string[],
    private readonly endpointValidator:RegistrationEndpointValidator,
  ) {}

  sendEmailCode(message: RegistrationDeliveryMessage): Promise<void> { return this.send(this.email, 'email', message); }
  sendSmsCode(message: RegistrationDeliveryMessage): Promise<void> { return this.send(this.sms, 'sms', message); }

  private async send(config: RegistrationWebhookConfig, channel: 'email' | 'sms', message: RegistrationDeliveryMessage): Promise<void> {
    const pinnedAddress=await this.endpointValidator(config.url,this.allowedHostnames,'Registration webhook');
    const response = await this.pinnedFetcher(config.url, pinnedAddress, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.bearerToken}` },
      body: JSON.stringify({ type: 'cod.registration.otp', channel, ...message }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error('registration delivery rejected');
  }
}

export function registrationDeliveryFromConfig(config: RegistrationVerificationConfig, pinnedFetcher: PinnedFetcher = defaultPinnedFetcher,endpointValidator:RegistrationEndpointValidator=assertSafeRegistrationEndpoint): RegistrationDelivery | null {
  return config.emailWebhook && config.smsWebhook ? new WebhookRegistrationDelivery(config.emailWebhook, config.smsWebhook, pinnedFetcher,config.outboundAllowedHostnames,endpointValidator) : null;
}
