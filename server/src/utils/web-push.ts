/**
 * Dependency-free Web Push crypto (FG-11).
 *
 * - Payload encryption per RFC 8291 (`aes128gcm` content encoding, RFC 8188):
 *   ephemeral ECDH P-256 with the subscriber `p256dh` key, auth secret via
 *   HKDF-SHA256, single-record AES-128-GCM with the
 *   `salt || rs || idlen || keyid` header prepended.
 * - VAPID (RFC 8292): ES256 JWT with `aud`/`exp`/`sub`, sent as
 *   `Authorization: vapid t=<jwt>, k=<publicKey>`.
 *
 * Implemented with `node:crypto` only — the lockfile is frozen, so `web-push`
 * cannot be added as a dependency.
 */

import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
} from 'node:crypto';

/** A stored push subscription as needed for payload encryption. */
export interface WebPushTarget {
  endpoint: string;
  /** Subscriber public key: base64url uncompressed P-256 point (65 bytes). */
  p256dh: string;
  /** Auth secret: base64url (16 bytes). */
  auth: string;
}

export interface VapidConfig {
  /** base64url uncompressed P-256 point. */
  publicKey: string;
  /** base64url 32-byte P-256 private scalar. */
  privateKey: string;
  /** RFC 8292 `sub` claim — a `mailto:` or `https:` contact URI. */
  subject?: string;
}

export interface WebPushPayload {
  title: string;
  body?: string;
  url?: string;
  tag?: string;
}

const ECDH_CURVE = 'prime256v1'; // P-256
const DEFAULT_RECORD_SIZE = 4096;
/** RFC 8188 delimiter for the last (here: only) record. */
const RECORD_DELIMITER = 0x02;
/** JWT lifetime cap per RFC 8292 (must be <= 24h). */
const VAPID_EXPIRY_SECONDS = 12 * 60 * 60;

const hkdf = (ikm: Buffer, salt: Buffer, info: Buffer | string, length: number): Buffer =>
  Buffer.from(hkdfSync('sha256', ikm, salt, info, length));

export interface EncryptOptions {
  /** Fixed salt for deterministic output (tests only). */
  salt?: Buffer;
  /** Fixed sender private key for deterministic output (tests only). */
  localPrivateKey?: Buffer;
  /** Record size written to the header. Defaults to 4096. */
  recordSize?: number;
}

/**
 * Encrypt a payload for a subscription, returning the full `aes128gcm`
 * request body (header + ciphertext).
 */
export const encryptWebPushPayload = (
  payload: string | Buffer,
  target: Pick<WebPushTarget, 'p256dh' | 'auth'>,
  options: EncryptOptions = {},
): Buffer => {
  const salt = options.salt ?? randomBytes(16);
  const recordSize = options.recordSize ?? DEFAULT_RECORD_SIZE;

  const subscriberPublicKey = Buffer.from(target.p256dh, 'base64url');
  const authSecret = Buffer.from(target.auth, 'base64url');

  const local = createECDH(ECDH_CURVE);
  if (options.localPrivateKey) {
    local.setPrivateKey(options.localPrivateKey);
  } else {
    local.generateKeys();
  }
  const senderPublicKey = local.getPublicKey(undefined, 'uncompressed');
  const sharedSecret = local.computeSecret(subscriberPublicKey);

  // RFC 8291 §3.3: bind the shared secret to the subscription auth secret
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), subscriberPublicKey, senderPublicKey]);
  const ikm = hkdf(sharedSecret, authSecret, keyInfo, 32);

  // RFC 8291 §3.4 / RFC 8188: derive content-encryption key and nonce from the salt
  const contentEncryptionKey = hkdf(ikm, salt, 'Content-Encoding: aes128gcm\0', 16);
  const nonce = hkdf(ikm, salt, 'Content-Encoding: nonce\0', 12);

  // RFC 8188 §2: plaintext = data || delimiter || padding (zero padding used)
  const plaintext = Buffer.concat([Buffer.from(payload), Buffer.from([RECORD_DELIMITER])]);

  const cipher = createCipheriv('aes-128-gcm', contentEncryptionKey, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);

  const recordSizeBuffer = Buffer.alloc(4);
  recordSizeBuffer.writeUInt32BE(recordSize);

  const header = Buffer.concat([salt, recordSizeBuffer, Buffer.from([senderPublicKey.length]), senderPublicKey]);

  return Buffer.concat([header, ciphertext]);
};

/**
 * Build the RFC 8292 `Authorization` header value (`vapid t=<jwt>, k=<key>`).
 */
export const buildVapidAuthorization = (
  endpoint: string,
  vapid: VapidConfig,
  { now = new Date() }: { now?: Date } = {},
): string => {
  const audience = new URL(endpoint).origin;

  // reconstruct the public key coordinates from the private scalar
  const ecdh = createECDH(ECDH_CURVE);
  ecdh.setPrivateKey(Buffer.from(vapid.privateKey, 'base64url'));
  const publicKey = ecdh.getPublicKey(undefined, 'uncompressed');
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    d: vapid.privateKey,
    x: publicKey.subarray(1, 33).toString('base64url'),
    y: publicKey.subarray(33, 65).toString('base64url'),
  };
  const privateKey = createPrivateKey({ format: 'jwk', key: jwk });

  const header = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })).toString('base64url');
  const claims: Record<string, unknown> = {
    aud: audience,
    exp: Math.floor(now.getTime() / 1000) + VAPID_EXPIRY_SECONDS,
  };
  if (vapid.subject) {
    claims.sub = vapid.subject;
  }
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');

  const input = `${header}.${body}`;
  const signature = sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' });

  return `vapid t=${input}.${signature.toString('base64url')}, k=${vapid.publicKey}`;
};

/**
 * Generate a VAPID key pair (P-256). Convenience for operators; the keys go in
 * `IMMICH_VAPID_PUBLIC_KEY` / `IMMICH_VAPID_PRIVATE_KEY`.
 */
export const generateVapidKeys = (): { publicKey: string; privateKey: string } => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const publicJwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const privateJwk = privateKey.export({ format: 'jwk' }) as { d: string };

  const uncompressed = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(publicJwk.x, 'base64url'),
    Buffer.from(publicJwk.y, 'base64url'),
  ]);

  return { publicKey: uncompressed.toString('base64url'), privateKey: privateJwk.d };
};
