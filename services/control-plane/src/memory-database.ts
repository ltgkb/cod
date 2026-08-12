import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { AccountSummary, AdminComputeRequestSummary, ComputeRequestStatus, DeviceRecord, TaskStatus, UsageEvent } from '@cod/contracts';
import { billedUsageEvent, CHAT_RESPONSE_CACHE_MAX_BYTES, computeRequestMatchesInput, creditPackCatalog, encodeComputeRequestCursor, normalizeAdminComputeRequestQuery, requireAdmin, topupMatchesLedger, usageMatchesLedger, validateComputeRequestId, validateComputeRequestStatus, validateComputeRequestTransition, validateDeviceInput, validateTaskOutcome, validateTaskTransition, validateTopupRequest, validateUsageEvent, type AdminComputeRequestQuery, type AssertVerifiedRegistrationInput, type AuditEntry, type ChatRequestClaim, type ChatRequestCompletion, type CodDatabase, type CompleteVerifiedRegistrationInput, type CreditGrant, type CreditSummary, type IdentityRecord, type InvalidateRegistrationCodeInput, type LedgerEntry, type PaymentCompletion, type PaymentOrder, type PaymentOrderRequest, type Principal, type RegistrationRateLimitInput, type StartEmailRegistrationInput, type StartPhoneRegistrationInput, type SyncedTask, type TaskEvent, type TaskOutcome, type TopupRequest, type VerifyRegistrationEmailInput, type VerifyRegistrationPhoneInput } from './database.js';
import { HttpError } from './errors.js';
import type { ComputeRequest, ComputeRequestInput } from './compute-market.js';

interface UserState {
  account: AccountSummary;
  ledger: LedgerEntry[];
  idempotency: Map<string, LedgerEntry>;
  devices: Map<string, DeviceRecord>;
  tasks: Map<string, SyncedTask>;
  events: TaskEvent[];
  audit: AuditEntry[];
  reservations: Map<string, { amountCents: number; walletCents: number; grantAllocations: Array<{grantId:string;amountCents:number}>; status: 'reserved' | 'settled' | 'released' }>;
  chatRequests: Map<string, { fingerprint: string; status: 'pending' | 'complete' | 'failed'; responsePayload: Record<string,unknown> | null; expiresAt: number }>;
  creditGrants: Map<string,CreditGrant>;
  creditPackIdempotency: Map<string,string>;
  paymentOrders: Map<string, PaymentOrder>;
  paymentIdempotency: Map<string, string>;
  computeRequests: Map<string, ComputeRequest>;
  computeIdempotency: Map<string, string>;
}

interface MemoryRegistrationChallenge {
  id: string;
  email: string;
  phone: string | null;
  emailCodeHash: string | null;
  phoneCodeHash: string | null;
  status: 'pending' | 'locked' | 'superseded' | 'consumed';
  failedAttempts: number;
  emailSendCount: number;
  phoneSendCount: number;
  emailVerifiedAt: number | null;
  phoneVerifiedAt: number | null;
  emailResendAt: number;
  phoneResendAt: number | null;
  expiresAt: number;
  idempotencyKey: string | null;
  fingerprint: string | null;
  consumedIdentity: IdentityRecord | null;
  replayUntil: number | null;
}

const normalizeRegistrationEmail=(email:string)=>email.trim().toLocaleLowerCase('en-US');
const normalizeRegistrationPhone=(phone:string)=>{const value=phone.trim();if(!/^\+[1-9]\d{7,14}$/.test(value))throw new HttpError('手机号必须使用 E.164 格式',400,'invalid_phone');return value;};
const validateRegistrationHash=(value:string,code='invalid_registration_code_hash')=>{if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))throw new HttpError('Registration verification data is invalid',400,code);};
const registrationHashMatches=(stored:string|null,supplied:string)=>Boolean(stored&&/^[a-f0-9]{64}$/.test(stored)&&/^[a-f0-9]{64}$/.test(supplied)&&timingSafeEqual(Buffer.from(stored,'hex'),Buffer.from(supplied,'hex')));
const retrySeconds=(at:number,now:number)=>Math.max(0,Math.ceil((at-now)/1000));

export class MemoryDatabase implements CodDatabase {
  private readonly users = new Map<string, UserState>();
  private readonly identities = new Map<string, IdentityRecord>();
  private readonly providerEvents = new Map<string, string>();
  private readonly registrationChallenges = new Map<string, MemoryRegistrationChallenge>();
  private readonly registrationRateLimits = new Map<string,{count:number;expiresAt:number}>();
  async initialize() {}
  async close() {}
  async health() { return true; }
  async ensurePrincipal(p: Principal) { this.state(p);this.ensureLegacyIdentity(p); }
  async findIdentityByEmail(email:string){return this.identities.get(email.toLowerCase())??null;}
  async registerIdentity(p:Principal,passwordHash:string,inviteCode:string|null,allowExisting:boolean){
    const email=p.email.toLowerCase();const current=this.identities.get(email);
    if(current?.passwordHash)throw new HttpError('该邮箱已经注册，请直接登录',409,'email_registered');
    if(current&&!allowExisting)throw new HttpError('这是旧试点账号，请使用旧访问码完成一次性迁移',409,'legacy_migration_required');
    let inviter:IdentityRecord|null=null;
    if(inviteCode){inviter=[...this.identities.values()].find((identity)=>identity.inviteCode?.toUpperCase()===inviteCode.toUpperCase())??null;if(!inviter)throw new HttpError('邀请码无效',400,'invalid_invite_code');}
    const identity:IdentityRecord={principal:current?.principal??p,passwordHash,phoneE164:current?.phoneE164??null,emailVerifiedAt:current?.emailVerifiedAt??null,phoneVerifiedAt:current?.phoneVerifiedAt??null,inviteCode:current?.inviteCode??`KAI-${p.userId.replace(/^usr_/,'').slice(0,10).toUpperCase()}`,referredByUserId:current?.referredByUserId??inviter?.principal.userId??null,referralCodeUsed:current?.referralCodeUsed??inviter?.inviteCode??null};
    this.state(identity.principal);this.identities.set(email,identity);return{identity,created:!current};
  }
  async startEmailRegistration(input:StartEmailRegistrationInput){
    const email=normalizeRegistrationEmail(input.email);validateRegistrationHash(input.codeHash);const now=input.now.getTime();
    const registered=this.identities.get(email);if(registered?.passwordHash)throw new HttpError('该邮箱已经注册，请直接登录',409,'email_registered');if(registered)throw new HttpError('这是旧试点账号，请使用旧访问码完成一次性迁移',409,'legacy_migration_required');
    let current=[...this.registrationChallenges.values()].find((item)=>item.email===email&&item.status==='pending');
    if(current&&current.expiresAt<=now){current.status='superseded';current.emailCodeHash=null;current.phoneCodeHash=null;current=undefined;}
    if(current){
      if(current.emailVerifiedAt)throw new HttpError('邮箱已经完成验证',409,'registration_email_already_verified');
      if(current.emailResendAt>now)throw new HttpError(`请在 ${retrySeconds(current.emailResendAt,now)} 秒后重试`,429,'registration_rate_limited');
      if(current.emailSendCount>=input.maxSends){current.status='locked';current.emailCodeHash=null;current.phoneCodeHash=null;throw new HttpError('验证码发送次数过多，请稍后重试',429,'registration_challenge_locked');}
      if(current.id!==input.challengeId){this.registrationChallenges.delete(current.id);current.id=input.challengeId;this.registrationChallenges.set(current.id,current);}current.emailCodeHash=input.codeHash;current.emailSendCount+=1;current.emailResendAt=input.resendAfter.getTime();current.expiresAt=input.expiresAt.getTime();
    }else{
      current={id:input.challengeId,email,phone:null,emailCodeHash:input.codeHash,phoneCodeHash:null,status:'pending',failedAttempts:0,emailSendCount:1,phoneSendCount:0,emailVerifiedAt:null,phoneVerifiedAt:null,emailResendAt:input.resendAfter.getTime(),phoneResendAt:null,expiresAt:input.expiresAt.getTime(),idempotencyKey:null,fingerprint:null,consumedIdentity:null,replayUntil:null};this.registrationChallenges.set(current.id,current);
    }
    return{challengeId:current.id,email,expiresAt:new Date(current.expiresAt).toISOString(),retryAfterSeconds:retrySeconds(current.emailResendAt,now)};
  }
  async verifyRegistrationEmail(input:VerifyRegistrationEmailInput){
    const email=normalizeRegistrationEmail(input.email);validateRegistrationHash(input.codeHash);const item=this.registrationChallenges.get(input.challengeId);const now=input.now.getTime();
    if(!item||item.email!==email)throw new HttpError('注册验证不存在',400,'invalid_registration_challenge');if(item.status==='consumed')throw new HttpError('本次注册已经完成',409,'registration_challenge_consumed');if(item.status==='locked')throw new HttpError('验证码错误次数过多，请重新开始',429,'registration_challenge_locked');if(item.status!=='pending'||item.expiresAt<=now){item.status='superseded';item.emailCodeHash=null;item.phoneCodeHash=null;throw new HttpError('本次注册验证已过期',410,'registration_challenge_expired');}if(item.emailVerifiedAt)return;
    if(!registrationHashMatches(item.emailCodeHash,input.codeHash)){item.failedAttempts+=1;if(item.failedAttempts>=input.maxFailures){item.status='locked';item.emailCodeHash=null;item.phoneCodeHash=null;throw new HttpError('验证码错误次数过多，请重新开始',429,'registration_challenge_locked');}throw new HttpError('验证码错误',400,'invalid_verification_code');}
    item.emailVerifiedAt=now;item.emailCodeHash=null;
  }
  async startPhoneRegistration(input:StartPhoneRegistrationInput){
    const email=normalizeRegistrationEmail(input.email);const phone=normalizeRegistrationPhone(input.phone);validateRegistrationHash(input.codeHash);const item=this.registrationChallenges.get(input.challengeId);const now=input.now.getTime();
    if(!item||item.email!==email)throw new HttpError('注册验证不存在',400,'invalid_registration_challenge');if(item.status==='consumed')throw new HttpError('本次注册已经完成',409,'registration_challenge_consumed');if(item.status==='locked')throw new HttpError('验证码发送次数过多，请重新开始',429,'registration_challenge_locked');if(item.status!=='pending'||item.expiresAt<=now){item.status='superseded';item.emailCodeHash=null;item.phoneCodeHash=null;throw new HttpError('本次注册验证已过期',410,'registration_challenge_expired');}if(!item.emailVerifiedAt)throw new HttpError('请先验证邮箱',409,'registration_email_verification_required');if(item.phone&&item.phone!==phone)throw new HttpError('本次验证已绑定其他手机号',409,'registration_phone_mismatch');
    if([...this.identities.values()].some((identity)=>identity.phoneE164===phone))throw new HttpError('该手机号已经注册',409,'phone_registered');if([...this.registrationChallenges.values()].some((other)=>other.id!==item.id&&other.status==='pending'&&other.phone===phone))throw new HttpError('该手机号正在用于其他注册验证',409,'phone_registration_pending');if(item.phoneVerifiedAt)throw new HttpError('手机号已经完成验证',409,'registration_phone_already_verified');
    if(item.phoneSendCount>0&&item.phoneResendAt&&item.phoneResendAt>now)throw new HttpError(`请在 ${retrySeconds(item.phoneResendAt,now)} 秒后重试`,429,'registration_rate_limited');if(item.phoneSendCount>=input.maxSends){item.status='locked';item.emailCodeHash=null;item.phoneCodeHash=null;throw new HttpError('验证码发送次数过多，请重新开始',429,'registration_challenge_locked');}
    item.phone=phone;item.phoneCodeHash=input.codeHash;item.phoneSendCount+=1;item.phoneResendAt=input.resendAfter.getTime();item.expiresAt=input.expiresAt.getTime();return{challengeId:item.id,phone,expiresAt:new Date(item.expiresAt).toISOString(),retryAfterSeconds:retrySeconds(item.phoneResendAt,now)};
  }
  async verifyRegistrationPhone(input:VerifyRegistrationPhoneInput){
    const email=normalizeRegistrationEmail(input.email);const phone=normalizeRegistrationPhone(input.phone);validateRegistrationHash(input.codeHash);const item=this.registrationChallenges.get(input.challengeId);const now=input.now.getTime();
    if(!item||item.email!==email||item.phone!==phone)throw new HttpError('注册验证不存在',400,'invalid_registration_challenge');if(item.status==='consumed')throw new HttpError('本次注册已经完成',409,'registration_challenge_consumed');if(item.status==='locked')throw new HttpError('验证码错误次数过多，请重新开始',429,'registration_challenge_locked');if(item.status!=='pending'||item.expiresAt<=now){item.status='superseded';item.emailCodeHash=null;item.phoneCodeHash=null;throw new HttpError('本次注册验证已过期',410,'registration_challenge_expired');}if(!item.emailVerifiedAt)throw new HttpError('请先验证邮箱',409,'registration_email_verification_required');if(item.phoneVerifiedAt)return;
    if(!registrationHashMatches(item.phoneCodeHash,input.codeHash)){item.failedAttempts+=1;if(item.failedAttempts>=input.maxFailures){item.status='locked';item.emailCodeHash=null;item.phoneCodeHash=null;throw new HttpError('验证码错误次数过多，请重新开始',429,'registration_challenge_locked');}throw new HttpError('验证码错误',400,'invalid_verification_code');}item.phoneVerifiedAt=now;item.phoneCodeHash=null;
  }
  async assertVerifiedRegistration(input:AssertVerifiedRegistrationInput):Promise<'ready'|'consumed'>{
    const email=normalizeRegistrationEmail(input.email);const phone=normalizeRegistrationPhone(input.phone);const item=this.registrationChallenges.get(input.challengeId);const now=input.now.getTime();
    if(!item||item.email!==email||item.phone!==phone)throw new HttpError('注册验证不存在',400,'invalid_registration_challenge');if(item.status==='consumed')return'consumed';if(item.status==='locked')throw new HttpError('本次注册验证已经锁定',429,'registration_challenge_locked');if(item.status!=='pending'||item.expiresAt<=now)throw new HttpError('本次注册验证已过期',410,'registration_challenge_expired');if(!item.emailVerifiedAt||!item.phoneVerifiedAt)throw new HttpError('请先完成邮箱和手机验证',409,'registration_verification_required');return'ready';
  }
  async completeVerifiedRegistration(input:CompleteVerifiedRegistrationInput){
    const email=normalizeRegistrationEmail(input.email);const phone=normalizeRegistrationPhone(input.phone);validateRegistrationHash(input.fingerprint,'invalid_request_fingerprint');if(!input.idempotencyKey||input.idempotencyKey.length>200)throw new HttpError('Registration idempotency key is invalid',400,'invalid_idempotency_key');const now=input.now.getTime();
    const replay=[...this.registrationChallenges.values()].find((item)=>item.idempotencyKey===input.idempotencyKey);if(replay){if(replay.fingerprint!==input.fingerprint)throw new HttpError('Idempotency key was already used with different registration data',409,'idempotency_conflict');if(!replay.consumedIdentity)throw new HttpError('Registration replay data is inconsistent',500,'registration_replay_inconsistent');if(replay.replayUntil!==null&&replay.replayUntil<now)throw new HttpError('本次注册已经完成，请直接登录',409,'registration_challenge_consumed');return{identity:replay.consumedIdentity,created:false,replayed:true};}
    const item=this.registrationChallenges.get(input.challengeId);if(!item||item.email!==email||item.phone!==phone)throw new HttpError('注册验证不存在',400,'invalid_registration_challenge');if(item.status==='consumed')throw new HttpError('本次注册已经完成，请直接登录',409,'registration_challenge_consumed');if(item.status==='locked')throw new HttpError('本次注册验证已经锁定',429,'registration_challenge_locked');if(item.status!=='pending'||item.expiresAt<=now){item.status='superseded';item.emailCodeHash=null;item.phoneCodeHash=null;throw new HttpError('本次注册验证已过期',410,'registration_challenge_expired');}if(!item.emailVerifiedAt||!item.phoneVerifiedAt)throw new HttpError('请先完成邮箱和手机验证',409,'registration_verification_required');if(normalizeRegistrationEmail(input.principal.email)!==email)throw new HttpError('Registration identity does not match the verified email',400,'registration_principal_mismatch');if(this.identities.get(email)?.passwordHash)throw new HttpError('该邮箱已经注册，请直接登录',409,'email_registered');if([...this.identities.values()].some((identity)=>identity.phoneE164===phone))throw new HttpError('该手机号已经注册',409,'phone_registered');
    let inviter:IdentityRecord|null=null;if(input.inviteCode){inviter=[...this.identities.values()].find((identity)=>identity.inviteCode?.toUpperCase()===input.inviteCode?.toUpperCase())??null;if(!inviter)throw new HttpError('邀请码无效',400,'invalid_invite_code');}
    const identity:IdentityRecord={principal:{...input.principal,email},passwordHash:input.passwordHash,phoneE164:phone,emailVerifiedAt:new Date(item.emailVerifiedAt).toISOString(),phoneVerifiedAt:new Date(item.phoneVerifiedAt).toISOString(),inviteCode:`KAI-${input.principal.userId.replace(/^usr_/,'').slice(0,10).toUpperCase()}`,referredByUserId:inviter?.principal.userId??null,referralCodeUsed:inviter?.inviteCode??null};
    const state=this.state(identity.principal);this.identities.set(email,identity);state.audit.unshift({id:randomUUID(),action:'auth.register',entityType:'user',entityId:identity.principal.userId,data:{inviteCodeUsed:identity.referralCodeUsed},createdAt:input.now.toISOString()});item.status='consumed';item.emailCodeHash=null;item.phoneCodeHash=null;item.idempotencyKey=input.idempotencyKey;item.fingerprint=input.fingerprint;item.consumedIdentity=identity;item.replayUntil=now+24*60*60*1000;return{identity,created:true,replayed:false};
  }
  async consumeRegistrationRateLimit(input:RegistrationRateLimitInput){
    if(!input.scope||input.scope.length>100||!input.keyHash||input.keyHash.length>256||!Number.isInteger(input.windowSeconds)||input.windowSeconds<1||!Number.isInteger(input.limit)||input.limit<1)throw new HttpError('Registration rate limit input is invalid',400,'invalid_rate_limit');const now=input.now.getTime();for(const [key,value] of this.registrationRateLimits)if(value.expiresAt<now)this.registrationRateLimits.delete(key);const bucket=Math.floor(now/(input.windowSeconds*1000));const key=`${input.scope}:${input.keyHash}:${input.windowSeconds}:${bucket}`;const current=this.registrationRateLimits.get(key);if(current&&current.count>=input.limit)throw new HttpError('请求过于频繁，请稍后重试',429,'registration_rate_limited');this.registrationRateLimits.set(key,{count:(current?.count??0)+1,expiresAt:(bucket+2)*input.windowSeconds*1000});
  }
  async invalidateRegistrationCode(input:InvalidateRegistrationCodeInput){
    validateRegistrationHash(input.codeHash);const item=this.registrationChallenges.get(input.challengeId);if(!item||item.status!=='pending')return;const stored=input.channel==='email'?item.emailCodeHash:item.phoneCodeHash;if(!registrationHashMatches(stored,input.codeHash))return;if(input.channel==='email'){item.status='superseded';item.emailCodeHash=null;item.phoneCodeHash=null;}else{item.phoneCodeHash=null;item.phoneVerifiedAt=null;}
  }
  async getReferralSummary(p:Principal){const identity=this.identities.get(p.email.toLowerCase());if(!identity?.inviteCode)throw new HttpError('Referral profile not found',404,'referral_profile_not_found');return{inviteCode:identity.inviteCode,referredUsers:[...this.identities.values()].filter((item)=>item.referredByUserId===p.userId).length,commissionRateBps:0,pendingCommissionCents:0,settledCommissionCents:0};}
  async getAccount(p: Principal) {
    const account=this.state(p).account;
    return { ...account, plan: p.role === 'admin' ? 'team' : account.plan, role: p.role, billingExempt: p.role === 'admin' };
  }
  async getLedger(p: Principal) { return [...this.state(p).ledger]; }
  async getCreditSummary(p:Principal):Promise<CreditSummary>{const state=this.state(p);this.expireGrants(state);const grants=[...state.creditGrants.values()].sort((a,b)=>a.expiresAt.localeCompare(b.expiresAt));return{availableCents:grants.filter((grant)=>grant.status==='active').reduce((total,grant)=>total+grant.remainingCents,0),grants:grants.map((grant)=>({...grant}))};}
  async purchaseCreditPack(p:Principal,packId:string,idempotencyKey:string){const state=this.state(p);const pack=creditPackCatalog.find((item)=>item.id===packId);if(!pack)throw new HttpError('Credit pack not found',404,'credit_pack_not_found');if(!idempotencyKey||idempotencyKey.length>200)throw new HttpError('Credit pack idempotency key is invalid',400,'invalid_idempotency_key');const existingId=state.creditPackIdempotency.get(idempotencyKey);if(existingId){const existing=state.creditGrants.get(existingId)!;if(existing.packId!==pack.id)throw new HttpError('Idempotency key was already used with another credit pack',409,'idempotency_conflict');return{grant:{...existing},account:{...state.account},summary:await this.getCreditSummary(p)};}if(state.account.balanceCents<pack.priceCents)throw new HttpError('Insufficient wallet balance',402,'insufficient_balance');const purchasedAt=new Date();const grant:CreditGrant={id:randomUUID(),packId:pack.id,name:pack.name,originalCents:pack.creditCents,remainingCents:pack.creditCents,purchasedAt:purchasedAt.toISOString(),expiresAt:new Date(purchasedAt.getTime()+180*24*60*60*1000).toISOString(),status:'active'};state.account={...state.account,balanceCents:state.account.balanceCents-pack.priceCents};state.creditGrants.set(grant.id,grant);state.creditPackIdempotency.set(idempotencyKey,grant.id);const purchase:LedgerEntry={id:randomUUID(),type:'pack_purchase',amountCents:-pack.priceCents,walletAmountCents:-pack.priceCents,creditAmountCents:0,createdAt:new Date().toISOString(),reference:pack.name,sourceId:null,model:null,paymentDirection:'COD 钱包 → 180 天额度包'};const credit:LedgerEntry={id:randomUUID(),type:'credit_grant',amountCents:pack.creditCents,walletAmountCents:0,creditAmountCents:pack.creditCents,createdAt:new Date().toISOString(),reference:pack.name,sourceId:null,model:null,paymentDirection:'额度包 → COD 使用额度'};state.ledger.unshift(credit,purchase);return{grant:{...grant},account:{...state.account},summary:await this.getCreditSummary(p)};}
  async topup(p: Principal, request: TopupRequest) {
    validateTopupRequest(request);const state=this.state(p); const existing=state.idempotency.get(request.idempotencyKey);
    if(existing){if(!topupMatchesLedger(existing,request))throw new HttpError('Idempotency key was already used with different top-up parameters',409,'idempotency_conflict');return existing;}
    const entry:LedgerEntry={id:randomUUID(),type:'topup',amountCents:request.amountCents,walletAmountCents:request.amountCents,creditAmountCents:0,createdAt:new Date().toISOString(),reference:`${request.channel}:${request.idempotencyKey}`,sourceId:null,model:null,paymentDirection:'用户 → COD 钱包'};
    state.account={...state.account,balanceCents:state.account.balanceCents+request.amountCents}; state.ledger.unshift(entry); state.idempotency.set(request.idempotencyKey,entry); return entry;
  }
  async createPaymentOrder(p: Principal, request: PaymentOrderRequest) {
    const state=this.state(p);
    if(!request.idempotencyKey||request.idempotencyKey.length>200)throw new HttpError('Payment idempotency key is invalid',400,'invalid_idempotency_key');
    if(!Number.isInteger(request.amountCents)||request.amountCents<100||request.amountCents>1_000_000)throw new HttpError('Payment amount must be between 100 and 1000000 cents',400,'invalid_payment_amount');
    if(request.channel!=='wechat'&&request.channel!=='alipay')throw new HttpError('Payment channel is invalid',400,'invalid_payment_channel');
    const existingId=state.paymentIdempotency.get(request.idempotencyKey);const existing=existingId?state.paymentOrders.get(existingId):null;
    if(existing){if(existing.amountCents!==request.amountCents||existing.channel!==request.channel)throw new HttpError('Idempotency key was already used with different payment parameters',409,'idempotency_conflict');return existing;}
    const now=new Date().toISOString();const order:PaymentOrder={id:randomUUID(),amountCents:request.amountCents,currency:'CNY',channel:request.channel,status:'pending',providerPaymentId:null,createdAt:now,updatedAt:now};state.paymentOrders.set(order.id,order);state.paymentIdempotency.set(request.idempotencyKey,order.id);return order;
  }
  async getPaymentOrder(p:Principal,orderId:string){const order=this.state(p).paymentOrders.get(orderId);if(!order)throw new HttpError('Payment order not found',404,'payment_order_not_found');return order;}
  async completePaymentOrder(event:PaymentCompletion){
    const eventOrder=this.providerEvents.get(event.providerEventId);if(eventOrder&&eventOrder!==event.orderId)throw new HttpError('Provider payment or event was already used for another order',409,'payment_provider_reused');
    for(const state of this.users.values())for(const order of state.paymentOrders.values())if(order.id!==event.orderId&&order.providerPaymentId===event.providerPaymentId)throw new HttpError('Provider payment or event was already used for another order',409,'payment_provider_reused');
    for(const state of this.users.values()){
      const current=state.paymentOrders.get(event.orderId);if(!current)continue;
      if(current.amountCents!==event.amountCents||current.currency!==event.currency||current.channel!==event.channel)throw new HttpError('Payment event does not match the order',409,'payment_order_mismatch');
      const ledgerKey=`payment-order:${current.id}`;const existing=state.idempotency.get(ledgerKey);
      if(current.status==='paid'){if(current.providerPaymentId!==event.providerPaymentId)throw new HttpError('Payment order is already bound to another provider payment',409,'payment_provider_conflict');if(!existing)throw new HttpError('Paid order ledger entry is missing',500,'payment_ledger_missing');return{order:current,entry:existing};}
      if(current.status!=='pending')throw new HttpError(`Payment order cannot be completed from ${current.status}`,409,'payment_order_not_pending');
      const entry:LedgerEntry={id:randomUUID(),type:'topup',amountCents:current.amountCents,walletAmountCents:current.amountCents,creditAmountCents:0,createdAt:new Date().toISOString(),reference:`${event.channel}:${event.providerPaymentId}`,sourceId:null,model:null,paymentDirection:'用户 → 支付渠道 → COD 钱包'};
      const order:PaymentOrder={...current,status:'paid',providerPaymentId:event.providerPaymentId,updatedAt:new Date().toISOString()};state.account={...state.account,balanceCents:state.account.balanceCents+current.amountCents};state.ledger.unshift(entry);state.idempotency.set(ledgerKey,entry);state.paymentOrders.set(order.id,order);this.providerEvents.set(event.providerEventId,order.id);return{order,entry};
    }
    throw new HttpError('Payment order not found',404,'payment_order_not_found');
  }
  async recordUsage(p: Principal,event:UsageEvent) {
    validateUsageEvent(event);const billedEvent=billedUsageEvent(p,event);const state=this.state(p); const existing=state.idempotency.get(event.idempotencyKey);
    if(existing){if(!usageMatchesLedger(existing,billedEvent))throw new HttpError('Idempotency key was already used with different usage parameters',409,'idempotency_conflict');return existing;}
    const allocation=this.allocateFunds(state,billedEvent.costCents);const creditCents=allocation.grantAllocations.reduce((total,item)=>total+item.amountCents,0);
    const entry=this.usageEntry(billedEvent,allocation.walletCents,creditCents);state.ledger.unshift(entry); state.idempotency.set(event.idempotencyKey,entry); return entry;
  }
  async claimChatRequest(p:Principal,requestKey:string,fingerprint:string):Promise<ChatRequestClaim>{
    if(!requestKey||requestKey.length>240)throw new HttpError('Chat request key is invalid',400,'invalid_idempotency_key');
    if(!/^[a-f0-9]{64}$/.test(fingerprint))throw new HttpError('Chat request fingerprint is invalid',400,'invalid_request_fingerprint');
    const state=this.state(p);const now=Date.now();let removed=0;for(const user of this.users.values()){for(const [key,item] of user.chatRequests){if(item.expiresAt<=now){user.chatRequests.delete(key);removed+=1;if(removed>=1000)break;}}if(removed>=1000)break;}const existing=state.chatRequests.get(requestKey);
    if(!existing){state.chatRequests.set(requestKey,{fingerprint,status:'pending',responsePayload:null,expiresAt:now+60*60*1000});return{state:'claimed'};}
    if(existing.fingerprint!==fingerprint)throw new HttpError('Request ID was already used for a different chat request',409,'idempotency_conflict');
    if(existing.status==='complete'){
      if(!existing.responsePayload)throw new HttpError('Cached chat response is invalid',500,'chat_cache_invalid');
      return{state:'complete',responsePayload:structuredClone(existing.responsePayload)};
    }
    if(existing.status==='pending')return{state:'pending'};
    state.chatRequests.set(requestKey,{fingerprint,status:'pending',responsePayload:null,expiresAt:now+60*60*1000});return{state:'claimed'};
  }
  async failChatRequest(p:Principal,requestKey:string,fingerprint:string){
    const state=this.state(p);const existing=state.chatRequests.get(requestKey);if(!existing||existing.fingerprint!==fingerprint||existing.status!=='pending')return;
    if(state.idempotency.has(`chat:${requestKey}:${fingerprint}`))return;
    state.chatRequests.set(requestKey,{...existing,status:'failed',responsePayload:null,expiresAt:Date.now()+60*60*1000});
  }
  async reserveUsage(p:Principal,id:string,amountCents:number){const state=this.state(p);if(state.reservations.has(id))return;if(!Number.isInteger(amountCents)||amountCents<0)throw new HttpError('Reservation amount is invalid',400,'invalid_reservation');const reservableAmount=p.role==='admin'?0:amountCents;const allocation=this.allocateFunds(state,reservableAmount);state.reservations.set(id,{amountCents:reservableAmount,...allocation,status:'reserved'});}
  async settleUsage(p:Principal,id:string,event:UsageEvent,completion?:ChatRequestCompletion){validateUsageEvent(event);const billedEvent=billedUsageEvent(p,event);const state=this.state(p);const reservation=state.reservations.get(id);const chatRequest=completion?state.chatRequests.get(completion.requestKey):null;const cachedResponse=completion?structuredClone(completion.responsePayload):null;const auditData=completion?structuredClone(completion.audit.data):null;if(completion){if(event.idempotencyKey!==`chat:${completion.requestKey}:${completion.fingerprint}`)throw new HttpError('Chat settlement key is invalid',400,'invalid_idempotency_key');if(Buffer.byteLength(JSON.stringify(completion.responsePayload),'utf8')>CHAT_RESPONSE_CACHE_MAX_BYTES)throw new HttpError('Model response is too large to cache safely',502,'chat_response_cache_too_large');if(!chatRequest||chatRequest.fingerprint!==completion.fingerprint)throw new HttpError('Chat request claim was not found',409,'chat_request_not_claimed');if(chatRequest.status==='failed')throw new HttpError('Chat request is no longer pending',409,'chat_request_not_pending');}const existing=state.idempotency.get(event.idempotencyKey);if(existing){if(!usageMatchesLedger(existing,billedEvent))throw new HttpError('Idempotency key was already used with different usage parameters',409,'idempotency_conflict');if(reservation?.status==='reserved')this.releaseReservation(state,reservation);if(completion&&chatRequest?.status==='pending')state.chatRequests.set(completion.requestKey,{fingerprint:completion.fingerprint,status:'complete',responsePayload:cachedResponse!,expiresAt:Date.now()+24*60*60*1000});return existing;}if(completion&&chatRequest?.status==='complete')throw new HttpError('Completed chat request is missing its billing record',500,'chat_billing_inconsistent');if(!reservation||reservation.status!=='reserved')throw new HttpError('Usage reservation not found',409,'reservation_not_found');if(event.taskId!=='chat'){const task=state.tasks.get(event.taskId);if(!task)throw new HttpError('Task not found',404,'task_not_found');if(task.status==='cancelled')throw new HttpError('Task was cancelled before settlement',409,'task_cancelled');if(task.status!=='running'&&task.status!=='waiting')throw new HttpError('Task is not running',409,'task_not_running');}let remaining=billedEvent.costCents;let creditConsumed=0;for(const allocation of reservation.grantAllocations){const consumed=Math.min(allocation.amountCents,remaining);creditConsumed+=consumed;remaining-=consumed;this.restoreGrant(state,allocation.grantId,allocation.amountCents-consumed);}const walletConsumed=Math.min(reservation.walletCents,remaining);remaining-=walletConsumed;state.account={...state.account,balanceCents:state.account.balanceCents+reservation.walletCents-walletConsumed};let totalWallet=walletConsumed;if(remaining>0){const extra=this.allocateFunds(state,remaining);totalWallet+=extra.walletCents;creditConsumed+=extra.grantAllocations.reduce((total,item)=>total+item.amountCents,0);}const entry=this.usageEntry(billedEvent,totalWallet,creditConsumed);state.ledger.unshift(entry);state.idempotency.set(event.idempotencyKey,entry);reservation.status='settled';if(completion){state.chatRequests.set(completion.requestKey,{fingerprint:completion.fingerprint,status:'complete',responsePayload:cachedResponse!,expiresAt:Date.now()+24*60*60*1000});state.audit.unshift({id:randomUUID(),action:'chat.complete',entityType:'model',entityId:completion.audit.entityId,data:auditData,createdAt:new Date().toISOString()});}return entry;}
  async releaseUsage(p:Principal,id:string){const state=this.state(p);const reservation=state.reservations.get(id);if(!reservation||reservation.status!=='reserved')return;this.releaseReservation(state,reservation);}
  async createComputeRequest(p:Principal,input:ComputeRequestInput,idempotencyKey:string){const state=this.state(p);if(!idempotencyKey||idempotencyKey.length>200)throw new HttpError('Compute request idempotency key is invalid',400,'invalid_idempotency_key');const existingId=state.computeIdempotency.get(idempotencyKey);if(existingId){const existing=state.computeRequests.get(existingId)!;if(!computeRequestMatchesInput(existing,input))throw new HttpError('Idempotency key was already used with different compute request parameters',409,'idempotency_conflict');return{request:{...existing},created:false};}const now=new Date().toISOString();const request:ComputeRequest={...input,id:randomUUID(),email:p.email,offerId:input.offerId??null,durationHours:input.durationHours??null,termMonths:input.termMonths??null,hostingPeriodMonths:input.hostingPeriodMonths??null,rackUnits:input.rackUnits??null,powerKilowatts:input.powerKilowatts??null,networkMbps:input.networkMbps??null,availabilityNotes:input.availabilityNotes??null,settlementPreference:input.settlementPreference??null,hostingRequirements:input.hostingRequirements??null,fulfillmentMode:input.kind==='hosting'?'third-party-manual-match':'manual-confirmation',status:'submitted',createdAt:now,updatedAt:now};state.computeRequests.set(request.id,request);state.computeIdempotency.set(idempotencyKey,request.id);return{request:{...request},created:true};}
  async listComputeRequests(p:Principal){return[...this.state(p).computeRequests.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map((request)=>({...request}));}
  async listAdminComputeRequests(p:Principal,rawQuery:AdminComputeRequestQuery={}){
    requireAdmin(p);const query=normalizeAdminComputeRequestQuery(rawQuery);
    const matchesQuery=(request:ComputeRequest)=>!query.q||[request.id,request.email,request.company,request.contactName,request.contactPhone,request.city,request.gpuModel].some((value)=>value.toLocaleLowerCase('en-US').includes(query.q!));
    const beforeCursor=(request:ComputeRequest)=>!query.cursor||request.createdAt<query.cursor.createdAt||(request.createdAt===query.cursor.createdAt&&request.id<query.cursor.id);
    const matching=[...this.users.values()].flatMap((state)=>[...state.computeRequests.values()])
      .filter((request)=>(!query.status||request.status===query.status)&&(!query.kind||request.kind===query.kind)&&matchesQuery(request)&&beforeCursor(request))
      .sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id));
    const items:AdminComputeRequestSummary[]=matching.slice(0,query.limit).map((request)=>({id:request.id,kind:request.kind,company:request.company,gpuModel:request.gpuModel,quantity:request.quantity,status:request.status,createdAt:request.createdAt,updatedAt:request.updatedAt}));const last=items.at(-1);
    return{items,nextCursor:matching.length>query.limit&&last?encodeComputeRequestCursor({createdAt:last.createdAt,id:last.id}):null};
  }
  async getAdminComputeRequest(p:Principal,id:string){requireAdmin(p);validateComputeRequestId(id);for(const state of this.users.values()){const request=state.computeRequests.get(id);if(request)return{...request};}throw new HttpError('Compute request not found',404,'compute_request_not_found');}
  async updateAdminComputeRequestStatus(p:Principal,id:string,status:ComputeRequestStatus,expectedStatus:ComputeRequestStatus){
    requireAdmin(p);validateComputeRequestId(id);validateComputeRequestStatus(status);validateComputeRequestStatus(expectedStatus);const adminState=this.state(p);
    for(const state of this.users.values()){
      const current=state.computeRequests.get(id);if(!current)continue;
      if(current.status!==status&&current.status!==expectedStatus)throw new HttpError('Compute request status changed; reload and confirm the latest state',409,'compute_request_status_conflict');
      validateComputeRequestTransition(current.status,status);
      const changed=current.status!==status;const request=changed?{...current,status,updatedAt:new Date().toISOString()}:current;
      if(changed)state.computeRequests.set(id,request);
      adminState.audit.unshift({id:randomUUID(),action:'compute.request.admin.status',entityType:'compute_request',entityId:id,data:{previousStatus:current.status,status:request.status,changed},createdAt:new Date().toISOString()});
      return{request:{...request},previousStatus:current.status,changed};
    }
    throw new HttpError('Compute request not found',404,'compute_request_not_found');
  }
  async listDevices(p:Principal){return [...this.state(p).devices.values()].map((device)=>Date.now()-new Date(device.lastSeenAt).getTime()>45_000?{...device,status:'offline' as const}:device);}
  async registerDevice(p:Principal,input:Pick<DeviceRecord,'name'|'platform'>){validateDeviceInput(input);const state=this.state(p);const device:DeviceRecord={id:randomUUID(),name:input.name.trim().slice(0,100),platform:input.platform,status:'online',lastSeenAt:new Date().toISOString()};state.devices.set(device.id,device);this.append(state,'device.registered',device.id,device);return device;}
  async heartbeat(p:Principal,id:string){const state=this.state(p);const current=state.devices.get(id);if(!current)throw new HttpError('Device not found',404,'device_not_found');const device={...current,status:'online' as const,lastSeenAt:new Date().toISOString()};state.devices.set(id,device);return device;}
  async listTasks(p:Principal){return [...this.state(p).tasks.values()];}
  async getTask(p:Principal,id:string){const task=this.state(p).tasks.get(id);if(!task)throw new HttpError('Task not found',404,'task_not_found');return task;}
  async createTask(p:Principal,input:Pick<SyncedTask,'title'|'deviceId'>){const state=this.state(p);if(!input||typeof input!=='object'||typeof input.title!=='string'||!input.title.trim())throw new HttpError('Task title is required',400,'invalid_task');if(typeof input.deviceId!=='string'||!state.devices.has(input.deviceId))throw new HttpError('Device not found',404,'device_not_found');const task:SyncedTask={id:randomUUID(),title:input.title.trim().slice(0,500),deviceId:input.deviceId,status:'draft',updatedAt:new Date().toISOString(),version:1,result:null,error:null};state.tasks.set(task.id,task);this.append(state,'task.created',task.id,task);return task;}
  async updateTask(p:Principal,id:string,status:TaskStatus,version:number,outcome:TaskOutcome={}){const state=this.state(p);const current=state.tasks.get(id);if(!current)throw new HttpError('Task not found',404,'task_not_found');if(current.version!==version)throw new HttpError('Task version conflict',409,'version_conflict');validateTaskTransition(current.status,status);if(outcome.result!==undefined&&outcome.result!==null&&typeof outcome.result!=='string')throw new HttpError('Task result is invalid',400,'invalid_task_result');if(outcome.error!==undefined&&outcome.error!==null&&typeof outcome.error!=='string')throw new HttpError('Task error is invalid',400,'invalid_task_error');if(typeof outcome.result==='string'&&outcome.result.length>50_000)throw new HttpError('Task result is too large',400,'task_result_too_large');if(typeof outcome.error==='string'&&outcome.error.length>5_000)throw new HttpError('Task error is too large',400,'task_error_too_large');if(current.status===status&&outcome.result===undefined&&outcome.error===undefined)return current;let result=outcome.result===undefined?current.result:outcome.result;let error=outcome.error===undefined?current.error:outcome.error;if(status==='running'&&current.status!=='running'){result=null;error=null;}if(status==='complete')error=null;if(status==='failed')result=null;if(status==='cancelled'){result=null;error=null;}validateTaskOutcome(status,result,error);const task={...current,status,result,error,version:current.version+1,updatedAt:new Date().toISOString()};state.tasks.set(id,task);this.append(state,'task.updated',id,task);return task;}
  async eventsAfter(p:Principal,cursor:number){return this.state(p).events.filter((event)=>event.cursor>cursor);}
  async audit(p:Principal,action:string,entityType:string,entityId:string|null,data:unknown={}){this.state(p).audit.unshift({id:randomUUID(),action,entityType,entityId,data,createdAt:new Date().toISOString()});}
  async listAudit(p:Principal,limit:number){return this.state(p).audit.slice(0,Math.min(Math.max(limit,1),200));}
  private key(p:Principal){return `${p.tenantId}:${p.userId}`;}
  private ensureLegacyIdentity(p:Principal){const email=p.email.toLowerCase();if(!this.identities.has(email))this.identities.set(email,{principal:p,passwordHash:null,phoneE164:null,emailVerifiedAt:null,phoneVerifiedAt:null,inviteCode:`KAI-${p.userId.replace(/^usr_/,'').slice(0,10).toUpperCase()}`,referredByUserId:null,referralCodeUsed:null});}
  private state(p:Principal){const key=this.key(p);let state=this.users.get(key);if(!state){const now=new Date();const trial:CreditGrant={id:randomUUID(),packId:'trial',name:'新用户试用金',originalCents:1000,remainingCents:1000,purchasedAt:now.toISOString(),expiresAt:new Date(now.getTime()+30*24*60*60*1000).toISOString(),status:'active'};const trialEntry:LedgerEntry={id:randomUUID(),type:'trial_credit',amountCents:1000,walletAmountCents:0,creditAmountCents:1000,createdAt:now.toISOString(),reference:'新用户试用金',sourceId:null,model:null,paymentDirection:'平台赠送 → COD 使用额度'};state={account:{userId:p.userId,displayName:p.email.split('@')[0],balanceCents:0,currency:'CNY',plan:p.role==='admin'?'team':'developer',role:p.role,billingExempt:p.role==='admin'},ledger:[trialEntry],idempotency:new Map(),devices:new Map(),tasks:new Map(),events:[],audit:[],reservations:new Map(),chatRequests:new Map(),creditGrants:new Map([[trial.id,trial]]),creditPackIdempotency:new Map(),paymentOrders:new Map(),paymentIdempotency:new Map(),computeRequests:new Map(),computeIdempotency:new Map()};this.users.set(key,state);}else if(state.account.role!==p.role||state.account.billingExempt!==(p.role==='admin'))state.account={...state.account,role:p.role,billingExempt:p.role==='admin'};return state;}
  private expireGrants(state:UserState){for(const [id,grant] of state.creditGrants)if(grant.status==='active'&&new Date(grant.expiresAt).getTime()<=Date.now())state.creditGrants.set(id,{...grant,status:'expired'});}
  private allocateFunds(state:UserState,amountCents:number){this.expireGrants(state);let remaining=amountCents;const grantAllocations:Array<{grantId:string;amountCents:number}>=[];const active=[...state.creditGrants.values()].filter((grant)=>grant.status==='active'&&grant.remainingCents>0).sort((a,b)=>a.expiresAt.localeCompare(b.expiresAt));for(const grant of active){if(remaining<=0)break;const amount=Math.min(grant.remainingCents,remaining);grantAllocations.push({grantId:grant.id,amountCents:amount});remaining-=amount;state.creditGrants.set(grant.id,{...grant,remainingCents:grant.remainingCents-amount,status:grant.remainingCents===amount?'depleted':'active'});}if(state.account.balanceCents<remaining){for(const allocation of grantAllocations)this.restoreGrant(state,allocation.grantId,allocation.amountCents);throw new HttpError('Insufficient balance',402,'insufficient_balance');}state.account={...state.account,balanceCents:state.account.balanceCents-remaining};return{walletCents:remaining,grantAllocations};}
  private restoreGrant(state:UserState,grantId:string,amountCents:number){if(amountCents<=0)return;const grant=state.creditGrants.get(grantId);if(!grant)return;const remainingCents=Math.min(grant.originalCents,grant.remainingCents+amountCents);state.creditGrants.set(grantId,{...grant,remainingCents,status:new Date(grant.expiresAt).getTime()<=Date.now()?'expired':'active'});}
  private releaseReservation(state:UserState,reservation:{walletCents:number;grantAllocations:Array<{grantId:string;amountCents:number}>;status:'reserved'|'settled'|'released'}){state.account={...state.account,balanceCents:state.account.balanceCents+reservation.walletCents};for(const allocation of reservation.grantAllocations)this.restoreGrant(state,allocation.grantId,allocation.amountCents);reservation.status='released';}
  private usageEntry(event:UsageEvent,walletCents:number,creditCents:number):LedgerEntry{return{id:randomUUID(),type:'usage',amountCents:event.costCents?-event.costCents:0,walletAmountCents:walletCents?-walletCents:0,creditAmountCents:creditCents?-creditCents:0,createdAt:new Date().toISOString(),reference:`${event.sourceId}:${event.model}:${event.taskId}`,sourceId:event.sourceId,upstreamSourceId:event.upstreamSourceId??'ai-kai',model:event.model,paymentDirection:event.paymentDirection,commissionRateBps:event.commissionRateBps??0,commissionCents:event.commissionCents??0};}
  private append(state:UserState,type:TaskEvent['type'],entityId:string,data:unknown){state.events.push({cursor:state.events.length+1,type,entityId,data,createdAt:new Date().toISOString()});}
}
