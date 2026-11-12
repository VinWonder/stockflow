const PIN_ITERATIONS = 160_000;

export interface AppUnlockSettings {
  salt: string;
  pinHash: string;
  biometricCredential: string | null;
  failedAttempts: number;
}

const settingsKey = (userId: number) => `stockflow.app-unlock.v1.${userId}`;

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

async function hashPin(pin: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: base64UrlToBytes(salt), iterations: PIN_ITERATIONS },
    key,
    256,
  );
  return bytesToBase64Url(new Uint8Array(bits));
}

export function readAppUnlock(userId: number): AppUnlockSettings | null {
  const raw = localStorage.getItem(settingsKey(userId));
  if (!raw) return null;
  const value: unknown = JSON.parse(raw);
  if (
    !value ||
    typeof value !== 'object' ||
    !('salt' in value) ||
    typeof value.salt !== 'string' ||
    !('pinHash' in value) ||
    typeof value.pinHash !== 'string' ||
    !('biometricCredential' in value) ||
    (value.biometricCredential !== null && typeof value.biometricCredential !== 'string') ||
    !('failedAttempts' in value) ||
    typeof value.failedAttempts !== 'number'
  ) {
    throw new Error('App-unlock data is invalid. Sign in with your password and set it up again.');
  }
  return value as AppUnlockSettings;
}

export async function createAppUnlockSettings(
  pin: string,
  biometricCredential: string | null,
): Promise<AppUnlockSettings> {
  const salt = bytesToBase64Url(randomBytes(16));
  return {
    salt,
    pinHash: await hashPin(pin, salt),
    biometricCredential,
    failedAttempts: 0,
  };
}

export async function verifyAppPin(pin: string, settings: AppUnlockSettings): Promise<boolean> {
  const expected = base64UrlToBytes(settings.pinHash);
  const actual = base64UrlToBytes(await hashPin(pin, settings.salt));
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < actual.length; i++) difference |= actual[i] ^ expected[i];
  return difference === 0;
}

export function saveAppUnlock(userId: number, settings: AppUnlockSettings): void {
  localStorage.setItem(settingsKey(userId), JSON.stringify(settings));
}

export function clearAppUnlock(userId: number): void {
  localStorage.removeItem(settingsKey(userId));
}

export function canUsePlatformBiometrics(): Promise<boolean> {
  if (!window.isSecureContext || !('PublicKeyCredential' in window)) return Promise.resolve(false);
  return PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
}

export async function registerPlatformBiometric(userId: number, username: string): Promise<string> {
  if (!(await canUsePlatformBiometrics())) {
    throw new Error('This browser or device does not support a platform biometric authenticator.');
  }
  const credential = await navigator.credentials.create({
    publicKey: {
      challenge: randomBytes(32),
      rp: { name: 'StockFlow', id: window.location.hostname },
      user: {
        id: new TextEncoder().encode(`stockflow-user-${userId}`),
        name: username,
        displayName: username,
      },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        residentKey: 'discouraged',
        userVerification: 'required',
      },
      timeout: 60_000,
    },
  });
  if (!(credential instanceof PublicKeyCredential)) {
    throw new Error('The device did not create a biometric credential.');
  }
  return bytesToBase64Url(new Uint8Array(credential.rawId));
}

export async function authenticatePlatformBiometric(credentialId: string): Promise<boolean> {
  const credential = await navigator.credentials.get({
    publicKey: {
      challenge: randomBytes(32),
      rpId: window.location.hostname,
      allowCredentials: [{ type: 'public-key', id: base64UrlToBytes(credentialId) }],
      userVerification: 'required',
      timeout: 60_000,
    },
  });
  return credential instanceof PublicKeyCredential && bytesToBase64Url(new Uint8Array(credential.rawId)) === credentialId;
}
