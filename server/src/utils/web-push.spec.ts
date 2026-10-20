import { createDecipheriv, createECDH, createPublicKey, hkdfSync, verify } from 'node:crypto';
import { buildVapidAuthorization, encryptWebPushPayload, generateVapidKeys } from 'src/utils/web-push.js';

const hkdf = (ikm: Buffer, salt: Buffer, info: Buffer | string, length: number): Buffer =>
  Buffer.from(hkdfSync('sha256', ikm, salt, info, length));

/** Test-side decryption of an `aes128gcm` body (RFC 8291), proving interop. */
const decryptWebPushPayload = (body: Buffer, subscriber: { privateKey: Buffer; publicKey: Buffer }, auth: Buffer) => {
  const salt = body.subarray(0, 16);
  const recordSize = body.readUInt32BE(16);
  const keyIdLength = body[20];
  const senderPublicKey = body.subarray(21, 21 + keyIdLength);
  const ciphertext = body.subarray(21 + keyIdLength);

  const subscriberEcdh = createECDH('prime256v1');
  subscriberEcdh.setPrivateKey(subscriber.privateKey);
  const sharedSecret = subscriberEcdh.computeSecret(senderPublicKey);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), subscriber.publicKey, senderPublicKey]);
  const ikm = hkdf(sharedSecret, auth, keyInfo, 32);
  const contentEncryptionKey = hkdf(ikm, salt, 'Content-Encoding: aes128gcm\0', 16);
  const nonce = hkdf(ikm, salt, 'Content-Encoding: nonce\0', 12);

  const tag = ciphertext.subarray(-16);
  const encrypted = ciphertext.subarray(0, -16);
  const decipher = createDecipheriv('aes-128-gcm', contentEncryptionKey, nonce);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);

  return { recordSize, senderPublicKey, plaintext };
};

const newSubscriber = () => {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    publicKey: ecdh.getPublicKey(undefined, 'uncompressed'),
    privateKey: ecdh.getPrivateKey(),
  };
};

describe('web-push', () => {
  describe('encryptWebPushPayload', () => {
    it('produces an aes128gcm body: salt || rs || idlen || sender public key || ciphertext', () => {
      const subscriber = newSubscriber();
      const body = encryptWebPushPayload('payload', {
        p256dh: subscriber.publicKey.toString('base64url'),
        auth: 'BTBZMqHH6r4Tts7J_aSIgg',
      });

      expect(body.readUInt32BE(16)).toBe(4096);
      const keyIdLength = body[20];
      expect(keyIdLength).toBe(65);
      expect(body[21]).toBe(0x04); // uncompressed point marker
      // header (86) + payload (7) + delimiter (1) + auth tag (16)
      expect(body.length).toBe(86 + 8 + 16);
    });

    it('round-trips: the subscriber can decrypt the payload', () => {
      const subscriber = newSubscriber();
      const auth = Buffer.from('BTBZMqHH6r4Tts7J_aSIgg', 'base64url');
      const payload = JSON.stringify({ title: 'Hello', body: 'World' });

      const body = encryptWebPushPayload(payload, {
        p256dh: subscriber.publicKey.toString('base64url'),
        auth: auth.toString('base64url'),
      });

      const { plaintext } = decryptWebPushPayload(body, subscriber, auth);
      // trailing delimiter octet per RFC 8188
      expect(plaintext.subarray(-1)).toEqual(Buffer.from([0x02]));
      expect(plaintext.subarray(0, -1).toString()).toBe(payload);
    });

    it('matches the RFC 8291 worked example', () => {
      // vectors from RFC 8291 Appendix (aes128gcm example)
      const body = encryptWebPushPayload(
        'When I grow up, I want to be a watermelon',
        {
          p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
          auth: 'BTBZMqHH6r4Tts7J_aSIgg',
        },
        {
          salt: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'),
          localPrivateKey: Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url'),
          recordSize: 4096,
        },
      );

      expect(body.toString('base64url')).toBe(
        'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
      );
    });
  });

  describe('buildVapidAuthorization', () => {
    const vapid = {
      publicKey: 'BBaIqplzEbrlmtz5CYl0Tl3nHyfw8l0q0XGJbQ2zO7pITbeqVFzHwSz8K0i8VE0wTyDJhvt4m3bDJdMdhF8tbE0',
      privateKey: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
      subject: 'mailto:admin@homeroll.test',
    };

    it('builds a vapid authorization header', () => {
      const authorization = buildVapidAuthorization('https://push.example.com/send/123', vapid, {
        now: new Date('2024-05-01T10:00:00Z'),
      });

      expect(authorization.startsWith('vapid t=')).toBe(true);
      expect(authorization.endsWith(`, k=${vapid.publicKey}`)).toBe(true);

      const jwt = authorization.slice('vapid t='.length, authorization.lastIndexOf(','));
      const [header, body, signature] = jwt.split('.', 3);

      expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
      expect(JSON.parse(Buffer.from(body, 'base64url').toString())).toEqual({
        aud: 'https://push.example.com',
        exp: Math.floor(Date.parse('2024-05-01T10:00:00Z') / 1000) + 43_200,
        sub: 'mailto:admin@homeroll.test',
      });
      // ES256 ieee-p1363 signature = 64 bytes
      expect(Buffer.from(signature, 'base64url').length).toBe(64);
    });

    it('produces a signature verifiable with the public key', () => {
      const keys = generateVapidKeys();
      const authorization = buildVapidAuthorization('https://push.example.com/', keys);
      const jwt = authorization.slice('vapid t='.length, authorization.lastIndexOf(','));
      const [header, body, signature] = jwt.split('.', 3);

      const publicKeyBytes = Buffer.from(keys.publicKey, 'base64url');
      const publicKey = createPublicKey({
        format: 'jwk',
        key: {
          kty: 'EC',
          crv: 'P-256',
          x: publicKeyBytes.subarray(1, 33).toString('base64url'),
          y: publicKeyBytes.subarray(33, 65).toString('base64url'),
        },
      });

      const valid = verify(
        'sha256',
        Buffer.from(`${header}.${body}`),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(signature, 'base64url'),
      );
      expect(valid).toBe(true);
    });
  });

  describe('generateVapidKeys', () => {
    it('generates a valid P-256 key pair', () => {
      const { publicKey, privateKey } = generateVapidKeys();

      const publicKeyBytes = Buffer.from(publicKey, 'base64url');
      expect(publicKeyBytes.length).toBe(65);
      expect(publicKeyBytes[0]).toBe(0x04);

      // the public key must be derivable from the private key
      const ecdh = createECDH('prime256v1');
      ecdh.setPrivateKey(Buffer.from(privateKey, 'base64url'));
      expect(ecdh.getPublicKey(undefined, 'uncompressed').toString('base64url')).toBe(publicKey);
    });
  });
});
