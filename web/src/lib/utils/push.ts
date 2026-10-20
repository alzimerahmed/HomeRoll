import type { PushSubscriptionCreateDto } from '@immich/sdk';
import { browser } from '$app/environment';

/**
 * Whether this browser context supports Web Push:
 * secure context + service worker + push manager + notifications.
 */
export const isPushSupported = (): boolean =>
  browser &&
  globalThis.isSecureContext === true &&
  'serviceWorker' in navigator &&
  'PushManager' in window &&
  'Notification' in window;

/** Current notification permission, or `undefined` when unsupported/SSR. */
export const getNotificationPermission = (): NotificationPermission | undefined => {
  if (!browser || !('Notification' in window)) {
    return;
  }
  return Notification.permission;
};

/** Decode a base64url VAPID public key into bytes for `PushManager.subscribe()`. */
export const urlBase64ToUint8Array = (base64String: string): Uint8Array => {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = `${base64String}${padding}`.replaceAll('-', '+').replaceAll('_', '/');
  const rawData = atob(base64);
  const bytes = new Uint8Array(rawData.length);
  for (const [index, character] of [...rawData].entries()) {
    bytes[index] = character.charCodeAt(0);
  }
  return bytes;
};

/** Encode raw bytes as base64url — the encoding push services expect for subscription keys. */
export const arrayBufferToBase64Url = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
};

/** The push subscription registered in this browser for this origin, if any. */
export const getBrowserPushSubscription = async (): Promise<PushSubscription | undefined> => {
  if (!isPushSupported()) {
    return;
  }
  const registration = await navigator.serviceWorker.ready;
  return (await registration.pushManager.getSubscription()) ?? undefined;
};

/** Map a browser `PushSubscription` onto the server DTO (keys as base64url). */
export const asPushSubscriptionCreateDto = (subscription: PushSubscription): PushSubscriptionCreateDto => {
  const p256dh = subscription.getKey('p256dh');
  const auth = subscription.getKey('auth');
  if (!p256dh || !auth) {
    throw new Error('Push subscription is missing encryption keys');
  }
  return {
    endpoint: subscription.endpoint,
    keys: {
      p256dh: arrayBufferToBase64Url(p256dh),
      auth: arrayBufferToBase64Url(auth),
    },
  };
};
