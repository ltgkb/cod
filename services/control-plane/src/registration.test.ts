import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config.js';
import { MemoryDatabase } from './memory-database.js';
import { type RegistrationDelivery, type RegistrationDeliveryMessage } from './registration-verification.js';
import { createControlPlane, registrationRateLimitAddress } from './server.js';

const servers: Array<ReturnType<typeof createControlPlane>>=[];
afterEach(async()=>Promise.all(servers.splice(0).map((server)=>new Promise<void>((resolve)=>server.close(()=>resolve())))));

class CapturingDelivery implements RegistrationDelivery {
  readonly emails:RegistrationDeliveryMessage[]=[];
  readonly sms:RegistrationDeliveryMessage[]=[];
  failEmail=false;
  failSms=false;
  async sendEmailCode(message:RegistrationDeliveryMessage){if(this.failEmail)throw new Error('email unavailable');this.emails.push({...message});}
  async sendSmsCode(message:RegistrationDeliveryMessage){if(this.failSms)throw new Error('sms unavailable');this.sms.push({...message});}
}

async function startRegistrationServer(overrides:Record<string,string>={}){
  const database=new MemoryDatabase();const delivery=new CapturingDelivery();let timestamp=Date.parse('2026-08-12T00:00:00.000Z');
  const turnstile=vi.fn(async(_input:RequestInfo|URL,init?:RequestInit)=>{const action=new URLSearchParams(String(init?.body)).get('response')?.includes('phone')?'cod_registration_phone':'cod_registration_email';return Response.json({success:true,hostname:'test.localhost',action});});
  const config=loadConfig({NODE_ENV:'test',COD_DEMO_MODE:'true',COD_REGISTRATION_ENABLED:'true',COD_REGISTRATION_HMAC_KEY:'r'.repeat(32),COD_TURNSTILE_SITE_KEY:'test-site-key',COD_TURNSTILE_SECRET_KEY:'test-secret-key',COD_PUBLIC_REGISTRATION_URL:'http://127.0.0.1:5173/?auth=register',...overrides});
  const server=createControlPlane({config,database,registrationDelivery:delivery,registrationFetcher:turnstile as typeof fetch,registrationEndpointValidator:async()=>undefined,now:()=>new Date(timestamp)});servers.push(server);
  await new Promise<void>((resolve)=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error('missing address');
  return{base:`http://127.0.0.1:${address.port}`,database,delivery,turnstile,advance:(milliseconds:number)=>{timestamp+=milliseconds;}};
}

const post=(base:string,path:string,body:unknown,headers:Record<string,string>={})=>fetch(`${base}${path}`,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});

async function completeEmail(base:string,delivery:CapturingDelivery,email:string){
  const started=await post(base,'/api/auth/registration/email/start',{email,humanChallengeToken:'human-ok'});expect(started.status).toBe(202);const challenge=await started.json() as {challengeId:string;maskedDestination:string;expiresAt:string;resendAt:string};
  const message=delivery.emails.at(-1)!;expect(message.challengeId).toBe(challenge.challengeId);expect(message.code).toMatch(/^\d{6}$/);expect(JSON.stringify(challenge)).not.toContain(message.code);
  const verified=await post(base,'/api/auth/registration/email/verify',{challengeId:challenge.challengeId,email,code:message.code});expect(verified.status).toBe(200);expect(await verified.json()).toEqual({verified:true});return challenge.challengeId;
}

async function completePhone(base:string,delivery:CapturingDelivery,challengeId:string,email:string,phone:string){
  const started=await post(base,'/api/auth/registration/phone/start',{challengeId,email,phone,humanChallengeToken:'human-phone-ok'});expect(started.status).toBe(202);const body=await started.json() as {maskedDestination:string};expect(body.maskedDestination).not.toBe(phone);
  const message=delivery.sms.at(-1)!;expect(message.code).toMatch(/^\d{6}$/);expect(JSON.stringify(body)).not.toContain(message.code);
  const verified=await post(base,'/api/auth/registration/phone/verify',{challengeId,email,phone,code:message.code});expect(verified.status).toBe(200);return message.code;
}

describe('dual OTP registration HTTP lifecycle',()=>{
  it('requires email and phone verification, persists a unique phone, grants the trial, and replays exactly once',async()=>{
    const {base,database,delivery,turnstile}=await startRegistrationServer();
    const inviterEmail='inviter@kai.com';const inviter={userId:`usr_${createHash('sha256').update(inviterEmail).digest('hex').slice(0,20)}`,tenantId:'tenant_kai_com',email:inviterEmail,role:'member' as const};
    await database.registerIdentity(inviter,'scrypt$16384$8$1$dGVzdC1hdXRoLXNhbHQtMQ$OkZEwwvTyk_BXs8umIBKldU3L-Oit-AkHANDBB81kdN0CCW6-5kqg9cGUwmetGRwxs9g_NiohCkGSni7NtcayQ',null,false);const invite=(await database.getReferralSummary(inviter)).inviteCode;
    const capabilities=await (await fetch(`${base}/api/capabilities`)).json();expect(capabilities).toMatchObject({authentication:{registrationEnabled:true,verificationMethods:['email_otp','sms_otp'],registrationWebOnly:true,turnstileSiteKey:'test-site-key',publicRegistrationUrl:expect.stringContaining('auth=register')}});
    const noHuman=await post(base,'/api/auth/registration/email/start',{email:'member@example.com'});expect(noHuman.status).toBe(400);expect(await noHuman.json()).toMatchObject({error:'human_verification_required'});expect(delivery.emails).toHaveLength(0);

    const email='member@example.com';const phone='+14155550123';const challengeId=await completeEmail(base,delivery,email);
    const invalidPhone=await post(base,'/api/auth/registration/phone/start',{challengeId,email,phone:'14155550123',humanChallengeToken:'human-phone-ok'});expect(invalidPhone.status).toBe(400);expect(await invalidPhone.json()).toMatchObject({error:'invalid_phone'});
    await completePhone(base,delivery,challengeId,email,phone);expect(turnstile).toHaveBeenCalledTimes(2);

    const input={challengeId,email,phone,password:'Password123',inviteCode:invite};const key='registration-test-0001';const registration=await post(base,'/api/auth/register',input,{'idempotency-key':key});expect(registration.status).toBe(201);const registered=await registration.json() as {token:string;user:{id:string};referred:boolean};expect(registered).toMatchObject({token:expect.any(String),user:{id:expect.any(String)},referred:true});
    const identity=await database.findIdentityByEmail(email);expect(identity).toMatchObject({phoneE164:phone,emailVerifiedAt:expect.any(String),phoneVerifiedAt:expect.any(String)});const principal=identity!.principal;
    expect((await database.getCreditSummary(principal)).grants.filter((grant)=>grant.packId==='trial')).toHaveLength(1);expect((await database.getLedger(principal)).filter((entry)=>entry.type==='trial_credit')).toHaveLength(1);expect((await database.listAudit(principal,20)).filter((entry)=>entry.action==='auth.register')).toHaveLength(1);expect((await database.getReferralSummary(inviter)).referredUsers).toBe(1);

    const replay=await post(base,'/api/auth/register',input,{'idempotency-key':key});expect(replay.status).toBe(200);expect(await replay.json()).toMatchObject({user:{id:principal.userId}});expect((await database.listAudit(principal,20)).filter((entry)=>entry.action==='auth.register')).toHaveLength(1);expect((await database.getCreditSummary(principal)).grants.filter((grant)=>grant.packId==='trial')).toHaveLength(1);
    const conflict=await post(base,'/api/auth/register',{...input,password:'DifferentPass123'},{'idempotency-key':key});expect(conflict.status).toBe(409);expect(await conflict.json()).toMatchObject({error:'idempotency_conflict'});
    const login=await post(base,'/api/auth/login',{email,password:'Password123'});expect(login.status).toBe(200);
  });

  it('commits failure counts, expires challenges, and never accepts a code whose delivery failed',async()=>{
    const first=await startRegistrationServer();first.delivery.failEmail=true;
    const failed=await post(first.base,'/api/auth/registration/email/start',{email:'failed@example.com',humanChallengeToken:'human-ok'});expect(failed.status).toBe(503);expect(await failed.json()).toMatchObject({error:'registration_delivery_failed'});expect(first.delivery.emails).toHaveLength(0);
    first.delivery.failEmail=false;const challengeId=await completeEmail(first.base,first.delivery,'working@example.com');first.delivery.failSms=true;
    const smsFailed=await post(first.base,'/api/auth/registration/phone/start',{challengeId,email:'working@example.com',phone:'+442071838750',humanChallengeToken:'human-phone-ok'});expect(smsFailed.status).toBe(503);const deliveredCode=first.delivery.sms.at(-1)?.code??'000000';
    const rejected=await post(first.base,'/api/auth/registration/phone/verify',{challengeId,email:'working@example.com',phone:'+442071838750',code:deliveredCode});expect(rejected.status).toBe(400);expect(await rejected.json()).toMatchObject({error:'registration_verification_failed'});

    const second=await startRegistrationServer();const start=await post(second.base,'/api/auth/registration/email/start',{email:'locked@example.com',humanChallengeToken:'human-ok'});const {challengeId:lockedId}=await start.json() as {challengeId:string};
    for(let attempt=1;attempt<=5;attempt++){const response=await post(second.base,'/api/auth/registration/email/verify',{challengeId:lockedId,email:'locked@example.com',code:'999999'});expect(response.status).toBe(400);expect(await response.json()).toMatchObject({error:'registration_verification_failed'});expect(response.headers.get('retry-after')).toBeNull();}
    const correctAfterLock=await post(second.base,'/api/auth/registration/email/verify',{challengeId:lockedId,email:'locked@example.com',code:second.delivery.emails[0]!.code});expect(correctAfterLock.status).toBe(400);expect(await correctAfterLock.json()).toMatchObject({error:'registration_verification_failed'});

    const third=await startRegistrationServer();const expiring=await post(third.base,'/api/auth/registration/email/start',{email:'expired@example.com',humanChallengeToken:'human-ok'});const {challengeId:expiredId}=await expiring.json() as {challengeId:string};third.advance(601_000);
    const expired=await post(third.base,'/api/auth/registration/email/verify',{challengeId:expiredId,email:'expired@example.com',code:third.delivery.emails[0]!.code});expect(expired.status).toBe(400);expect(await expired.json()).toMatchObject({error:'registration_verification_failed'});
  });

  it('returns the same public email-start contract for new, registered, and legacy accounts',async()=>{
    const legacyEmail='pilot@kai.com';const {base,database,delivery}=await startRegistrationServer({COD_DEVELOPMENT_LOGIN_ENABLED:'true',COD_DEVELOPMENT_LOGIN_EMAIL:legacyEmail,COD_PILOT_ACCESS_CODE_HASH:createHash('sha256').update('legacy-code').digest('hex')});
    await database.ensurePrincipal({userId:'usr_legacy_contract',tenantId:'tenant_kai_com',email:legacyEmail,role:'member'});
    await database.registerIdentity({userId:'usr_registered_contract',tenantId:'tenant_example_com',email:'registered@example.com',role:'member'},'stored-password-hash',null,false);

    const available=await post(base,'/api/auth/registration/email/start',{email:'available@example.com',humanChallengeToken:'human-ok'});
    const registered=await post(base,'/api/auth/registration/email/start',{email:'registered@example.com',humanChallengeToken:'human-ok'});
    const legacy=await post(base,'/api/auth/registration/email/start',{email:legacyEmail,humanChallengeToken:'human-ok'});
    expect([available.status,registered.status,legacy.status]).toEqual([202,202,202]);
    const bodies=await Promise.all([available.json(),registered.json(),legacy.json()]) as Array<Record<string,unknown>>;
    const keys=bodies.map((body)=>Object.keys(body).sort());
    expect(keys[1]).toEqual(keys[0]);expect(keys[2]).toEqual(keys[0]);
    expect(bodies.map((body)=>body.notice)).toEqual([bodies[0]!.notice,bodies[0]!.notice,bodies[0]!.notice]);
    for(const body of bodies){expect(body).toMatchObject({challengeId:expect.stringMatching(/^[0-9a-f-]{36}$/),maskedDestination:expect.any(String),expiresAt:expect.any(String),resendAt:expect.any(String),notice:expect.stringContaining('迁移')});expect(body).not.toHaveProperty('error');}
    expect(delivery.emails).toHaveLength(1);
    const capabilities=await (await fetch(`${base}/api/capabilities`)).json();expect(capabilities).toMatchObject({authentication:{legacyMigrationEnabled:true}});
  });

  it('returns the same public phone-start contract when a phone is already registered',async()=>{
    const {base,delivery}=await startRegistrationServer();const phone='+14155550888';const firstEmail='phone-owner@example.com';const firstChallenge=await completeEmail(base,delivery,firstEmail);
    const available=await post(base,'/api/auth/registration/phone/start',{challengeId:firstChallenge,email:firstEmail,phone,humanChallengeToken:'human-phone-ok'});expect(available.status).toBe(202);const availableBody=await available.json() as Record<string,unknown>;
    const phoneCode=delivery.sms.at(-1)!.code;expect((await post(base,'/api/auth/registration/phone/verify',{challengeId:firstChallenge,email:firstEmail,phone,code:phoneCode})).status).toBe(200);
    const completed=await post(base,'/api/auth/register',{challengeId:firstChallenge,email:firstEmail,phone,password:'Password123',inviteCode:null},{'idempotency-key':'phone-contract-registration'});expect(completed.status).toBe(201);

    const secondEmail='phone-contender@example.com';const secondChallenge=await completeEmail(base,delivery,secondEmail);
    const occupied=await post(base,'/api/auth/registration/phone/start',{challengeId:secondChallenge,email:secondEmail,phone,humanChallengeToken:'human-phone-ok'});expect(occupied.status).toBe(202);const occupiedBody=await occupied.json() as Record<string,unknown>;
    expect(Object.keys(occupiedBody).sort()).toEqual(Object.keys(availableBody).sort());
    expect(occupiedBody.notice).toBe(availableBody.notice);
    expect(occupiedBody).toMatchObject({challengeId:secondChallenge,maskedDestination:availableBody.maskedDestination,expiresAt:expect.any(String),resendAt:expect.any(String),notice:expect.any(String)});
    expect(occupiedBody).not.toHaveProperty('error');expect(delivery.sms).toHaveLength(1);
  });

  it('requires email before SMS, enforces resend cooldown, and routes passwordless pilots to migration',async()=>{
    const legacyCode='Legacy-Code-For-Test';const legacyEmail='pilot@kai.com';const {base,database,delivery,advance}=await startRegistrationServer({COD_DEVELOPMENT_LOGIN_ENABLED:'true',COD_DEVELOPMENT_LOGIN_EMAIL:legacyEmail,COD_PILOT_ACCESS_CODE_HASH:createHash('sha256').update(legacyCode).digest('hex')});
    await database.ensurePrincipal({userId:`usr_${createHash('sha256').update(legacyEmail).digest('hex').slice(0,20)}`,tenantId:'tenant_kai_com',email:legacyEmail,role:'member'});
    const legacyStart=await post(base,'/api/auth/registration/email/start',{email:legacyEmail,humanChallengeToken:'human-ok'});expect(legacyStart.status).toBe(202);expect(await legacyStart.json()).toMatchObject({notice:expect.stringContaining('迁移')});expect(delivery.emails).toHaveLength(0);

    const email='sequence@example.com';const start=await post(base,'/api/auth/registration/email/start',{email,humanChallengeToken:'human-ok'});const {challengeId}=await start.json() as {challengeId:string};const premature=await post(base,'/api/auth/registration/phone/start',{challengeId,email,phone:'+81312345678',humanChallengeToken:'human-phone-ok'});expect(premature.status).toBe(409);expect(await premature.json()).toMatchObject({error:'registration_email_verification_required'});expect(delivery.sms).toHaveLength(0);
    const tooSoon=await post(base,'/api/auth/registration/email/start',{email,humanChallengeToken:'human-ok'});expect(tooSoon.status).toBe(429);expect(tooSoon.headers.get('retry-after')).toBe('60');advance(60_000);
    const resent=await post(base,'/api/auth/registration/email/start',{email,humanChallengeToken:'human-ok'});expect(resent.status).toBe(202);const newChallenge=(await resent.json() as {challengeId:string}).challengeId;expect(newChallenge).not.toBe(challengeId);
    const oldCode=delivery.emails[0]!.code;const oldRejected=await post(base,'/api/auth/registration/email/verify',{challengeId:newChallenge,email,code:oldCode});expect(oldRejected.status).toBe(400);const newCode=delivery.emails.at(-1)!.code;expect((await post(base,'/api/auth/registration/email/verify',{challengeId:newChallenge,email,code:newCode})).status).toBe(200);
  });

  it('releases a phone reservation when the owning challenge expires',async()=>{
    const {base,delivery,advance}=await startRegistrationServer();const phone='+14155550999';
    const firstEmail='first-phone-owner@example.com';const firstChallenge=await completeEmail(base,delivery,firstEmail);
    expect((await post(base,'/api/auth/registration/phone/start',{challengeId:firstChallenge,email:firstEmail,phone,humanChallengeToken:'human-phone-ok'})).status).toBe(202);
    advance(601_000);
    const secondEmail='second-phone-owner@example.com';const secondChallenge=await completeEmail(base,delivery,secondEmail);
    const reused=await post(base,'/api/auth/registration/phone/start',{challengeId:secondChallenge,email:secondEmail,phone,humanChallengeToken:'human-phone-ok'});
    expect(reused.status).toBe(202);
  });

  it('removes expired challenge PII after the bounded retention window',async()=>{
    const {base,database,delivery}=await startRegistrationServer();const email='retention@example.com';
    const started=await post(base,'/api/auth/registration/email/start',{email,humanChallengeToken:'human-ok'});const {challengeId}=await started.json() as {challengeId:string};
    expect(await database.cleanupRegistrationChallenges(new Date('2026-08-12T00:10:01.000Z'),1)).toBe(1);
    expect(await database.cleanupRegistrationChallenges(new Date('2026-08-12T00:10:02.000Z'),1)).toBe(0);
    expect(await database.cleanupRegistrationChallenges(new Date('2026-08-13T00:10:01.000Z'),1)).toBe(1);
    const removed=await post(base,'/api/auth/registration/email/verify',{challengeId,email,code:delivery.emails[0]!.code});expect(removed.status).toBe(400);expect(await removed.json()).toMatchObject({error:expect.any(String)});
  });
});

describe('registration configuration and proxy address safety',()=>{
  const productionBase={NODE_ENV:'production',COD_SESSION_SECRET:'s'.repeat(32),DATABASE_URL:'postgresql://cod:test@127.0.0.1:5432/cod',KAI_API_KEY:'provider-key',COD_DEVELOPMENT_LOGIN_ENABLED:'false',COD_REGISTRATION_ENABLED:'true',COD_ALLOWED_ORIGINS:'https://cod.kai.com'};
  it('fails production startup unless both providers, Turnstile, the HMAC key, and a safe public URL are complete',()=>{
    expect(()=>loadConfig(productionBase)).toThrow('COD_REGISTRATION_HMAC_KEY');
    const complete={...productionBase,COD_REGISTRATION_HMAC_KEY:'h'.repeat(32),COD_REGISTRATION_EMAIL_WEBHOOK_URL:'https://notify.example/email',COD_REGISTRATION_EMAIL_WEBHOOK_TOKEN:'email-token',COD_REGISTRATION_SMS_WEBHOOK_URL:'https://notify.example/sms',COD_REGISTRATION_SMS_WEBHOOK_TOKEN:'sms-token',COD_REGISTRATION_OUTBOUND_ALLOWED_HOSTS:'notify.example',COD_TURNSTILE_SITE_KEY:'site-key',COD_TURNSTILE_SECRET_KEY:'secret-key',COD_TURNSTILE_EXPECTED_HOSTNAMES:'cod.kai.com',COD_PUBLIC_REGISTRATION_URL:'https://cod.kai.com/app/?auth=register'};
    expect(()=>loadConfig(complete)).not.toThrow();expect(()=>loadConfig({...complete,COD_REGISTRATION_OUTBOUND_ALLOWED_HOSTS:undefined})).toThrow('COD_REGISTRATION_OUTBOUND_ALLOWED_HOSTS');expect(()=>loadConfig({...complete,COD_REGISTRATION_SMS_WEBHOOK_URL:'http://notify.example/sms'})).toThrow('must use HTTPS');expect(()=>loadConfig({...complete,COD_REGISTRATION_SMS_WEBHOOK_URL:'https://evil.example/sms'})).toThrow('host is not allowed');expect(()=>loadConfig({...complete,COD_PUBLIC_REGISTRATION_URL:'https://evil.example/register'})).toThrow('origin must be listed');expect(()=>loadConfig({...complete,COD_TURNSTILE_VERIFY_URL:'https://evil.example/siteverify'})).toThrow('challenges.cloudflare.com');
  });

  it('trusts x-real-ip only from a loopback proxy and stores network prefixes',()=>{
    expect(registrationRateLimitAddress('::1','203.0.113.99')).toBe('203.0.113.0/24');expect(registrationRateLimitAddress('127.0.0.1','2001:db8:abcd:12::99')).toBe('2001:db8:abcd:12::/64');expect(registrationRateLimitAddress('198.51.100.44','203.0.113.99')).toBe('198.51.100.0/24');expect(registrationRateLimitAddress('::1','203.0.113.1, 198.51.100.2')).toBe('0:0:0:0::/64');
  });
});
