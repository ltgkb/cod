import * as SecureStore from 'expo-secure-store';

const sessionStorageKey = 'cod.session.v1';
const sessionKeychainService = 'com.kai.cod.session.v1';
const maximumSessionTokenLength = 8_192;

const secureStoreOptions: SecureStore.SecureStoreOptions = {
  keychainService: sessionKeychainService,
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  requireAuthentication: false,
};

interface TokenSessionRecord {
  version: 1;
  state: 'token';
  token: string;
}

interface LogoutSessionRecord {
  version: 1;
  state: 'logout';
}

type SessionRecord = TokenSessionRecord | LogoutSessionRecord;
type DecodedSession =
  | { kind: 'empty' }
  | { kind: 'token'; token: string; serialized: string }
  | { kind: 'logout'; serialized: string }
  | { kind: 'legacy'; token: string }
  | { kind: 'invalid' };

const logoutRecord: LogoutSessionRecord = { version: 1, state: 'logout' };
const serializedLogoutRecord = JSON.stringify(logoutRecord);

let operationQueue: Promise<void> = Promise.resolve();
let availability: Promise<boolean> | null = null;

function validToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximumSessionTokenLength && !/[\0-\x20\x7f]/.test(value);
}

function validLegacyToken(value: unknown): value is string {
  return validToken(value) && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
}

function decodeSession(value: string | null): DecodedSession {
  if (value === null) return { kind: 'empty' };
  try {
    const parsed = JSON.parse(value) as Partial<SessionRecord> | null;
    if (parsed && typeof parsed === 'object' && parsed.version === 1) {
      if (parsed.state === 'logout') return { kind: 'logout', serialized: serializedLogoutRecord };
      if (parsed.state === 'token' && validToken((parsed as Partial<TokenSessionRecord>).token)) {
        const token = (parsed as TokenSessionRecord).token;
        return { kind: 'token', token, serialized: JSON.stringify({ version: 1, state: 'token', token } satisfies TokenSessionRecord) };
      }
    }
    return { kind: 'invalid' };
  } catch {
    // Raw values from versions before the record format are migrated below.
    return validLegacyToken(value) ? { kind: 'legacy', token: value } : { kind: 'invalid' };
  }
}

async function assertAvailable(): Promise<void> {
  availability ??= SecureStore.isAvailableAsync();
  if (!await availability) throw new Error('Secure session storage is unavailable');
}

function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const result = operationQueue.then(operation, operation);
  operationQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function writeAndVerify(serializedRecord: string, failureMessage: string): Promise<void> {
  await SecureStore.setItemAsync(sessionStorageKey, serializedRecord, secureStoreOptions);
  if (await SecureStore.getItemAsync(sessionStorageKey, secureStoreOptions) !== serializedRecord) throw new Error(failureMessage);
}

async function replaceInvalidSessionWithLogout(): Promise<void> {
  await writeAndVerify(serializedLogoutRecord, 'Secure logout verification failed');
}

export function loadSessionCleanupPending(): Promise<boolean> {
  return serialized(async () => {
    await assertAvailable();
    const decoded = decodeSession(await SecureStore.getItemAsync(sessionStorageKey, secureStoreOptions));
    if (decoded.kind === 'logout') return true;
    if (decoded.kind !== 'invalid') return false;
    await replaceInvalidSessionWithLogout();
    return true;
  });
}

export function loadSessionToken(): Promise<string | null> {
  return serialized(async () => {
    await assertAvailable();
    const decoded = decodeSession(await SecureStore.getItemAsync(sessionStorageKey, secureStoreOptions));
    if (decoded.kind === 'empty' || decoded.kind === 'logout') return null;
    if (decoded.kind === 'invalid') {
      await replaceInvalidSessionWithLogout();
      throw new Error('Stored session is invalid');
    }
    if (decoded.kind === 'legacy') {
      const serializedRecord = JSON.stringify({ version: 1, state: 'token', token: decoded.token } satisfies TokenSessionRecord);
      await writeAndVerify(serializedRecord, 'Secure session migration verification failed');
      return decoded.token;
    }
    return decoded.token;
  });
}

export function saveSessionToken(token: string): Promise<void> {
  return serialized(async () => {
    await assertAvailable();
    if (!validToken(token)) throw new Error('Session token is invalid');
    const serializedRecord = JSON.stringify({ version: 1, state: 'token', token } satisfies TokenSessionRecord);
    try {
      await writeAndVerify(serializedRecord, 'Secure session verification failed');
    } catch (error) {
      await replaceInvalidSessionWithLogout().catch(() => undefined);
      throw error;
    }
  });
}

export function clearSessionToken(expectedToken?: string): Promise<boolean> {
  return serialized(async () => {
    await assertAvailable();
    const decoded = decodeSession(await SecureStore.getItemAsync(sessionStorageKey, secureStoreOptions));
    const currentToken = decoded.kind === 'token' || decoded.kind === 'legacy' ? decoded.token : null;
    if (expectedToken !== undefined && currentToken !== null && currentToken !== expectedToken) return false;
    await replaceInvalidSessionWithLogout();
    return true;
  });
}
