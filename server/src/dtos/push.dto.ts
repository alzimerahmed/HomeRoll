import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { isoDatetimeToDate } from 'src/validation.js';

/** Push endpoints are browser-vendor push services — https only (SSRF guard). */
const PushEndpointSchema = z
  .url()
  .describe('Push service endpoint URL')
  .refine((value) => new URL(value).protocol === 'https:', { message: 'Push endpoint must use https' });

const PushSubscriptionKeysSchema = z
  .object({
    p256dh: z.string().describe('Subscriber P-256 public key (base64url)'),
    auth: z.string().describe('Subscriber auth secret (base64url)'),
  })
  .meta({ id: 'PushSubscriptionKeys' });

const PushSubscriptionCreateSchema = z
  .object({
    endpoint: PushEndpointSchema,
    keys: PushSubscriptionKeysSchema,
  })
  .meta({ id: 'PushSubscriptionCreateDto' });

const PushSubscriptionDeleteSchema = z
  .object({
    endpoint: PushEndpointSchema,
  })
  .meta({ id: 'PushSubscriptionDeleteDto' });

const PushSubscriptionResponseSchema = z
  .object({
    id: z.uuidv4().describe('Subscription ID'),
    endpoint: z.string().describe('Push service endpoint URL'),
    userAgent: z.string().nullable().describe('User agent that registered the subscription'),
    createdAt: isoDatetimeToDate.describe('Registration date'),
  })
  .meta({ id: 'PushSubscriptionResponseDto' });

const VapidPublicKeyResponseSchema = z
  .object({
    publicKey: z.string().nullable().describe('VAPID public key (base64url), null when push is not configured'),
  })
  .meta({ id: 'VapidPublicKeyResponseDto' });

const PushTestResponseSchema = z
  .object({
    delivered: z.int().describe('Number of subscriptions the test notification was delivered to'),
  })
  .meta({ id: 'PushTestResponseDto' });

export class PushSubscriptionCreateDto extends createZodDto(PushSubscriptionCreateSchema) {}
export class PushSubscriptionDeleteDto extends createZodDto(PushSubscriptionDeleteSchema) {}
export class PushSubscriptionResponseDto extends createZodDto(PushSubscriptionResponseSchema) {}
export class VapidPublicKeyResponseDto extends createZodDto(VapidPublicKeyResponseSchema) {}
export class PushTestResponseDto extends createZodDto(PushTestResponseSchema) {}
