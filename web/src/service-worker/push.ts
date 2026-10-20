/* eslint-disable unicorn/no-unnecessary-global-this */
/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />

const sw = globalThis as unknown as ServiceWorkerGlobalScope;

/**
 * Server-sent web push payload — see `WebPushPayload` /
 * `PushService.sendPushNotification` in `server/src/services/push.service.ts`.
 */
type PushPayload = {
  title?: string;
  body?: string;
  url?: string;
  tag?: string;
};

const NOTIFICATION_ICON = '/manifest-icon-192.maskable.png';
const NOTIFICATION_BADGE = '/favicon-96.png';

const showNotification = async (event: PushEvent) => {
  let payload: PushPayload;
  try {
    payload = event.data ? (event.data.json() as PushPayload) : {};
  } catch {
    payload = { body: event.data?.text() };
  }

  // Subscriptions are `userVisibleOnly`, so every push must surface a visible
  // notification — fall back to a generic one on malformed/empty payloads.
  await sw.registration.showNotification(payload.title || 'HomeRoll', {
    body: payload.body,
    tag: payload.tag,
    icon: NOTIFICATION_ICON,
    badge: NOTIFICATION_BADGE,
    data: { url: payload.url || '/' },
  });
};

const handlePush = (event: PushEvent) => {
  event.waitUntil(showNotification(event));
};

const focusOrOpenClient = async (url: string) => {
  const clients = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });

  for (const client of clients) {
    const windowClient = client as WindowClient;
    if (windowClient.url === url) {
      return windowClient.focus();
    }
  }

  const existing = clients.find((client) => client.url.startsWith(sw.location.origin)) as WindowClient | undefined;
  if (existing) {
    await existing.navigate(url);
    return existing.focus();
  }

  return sw.clients.openWindow(url);
};

const handleNotificationClick = (event: NotificationEvent) => {
  // eslint-disable-next-line tscompat/tscompat -- Safari never fires notificationclick; unreachable there
  event.notification.close();
  // eslint-disable-next-line tscompat/tscompat -- Safari never fires notificationclick; unreachable there
  const path = typeof event.notification.data?.url === 'string' ? event.notification.data.url : '/';
  const url = new URL(path, sw.location.origin).href;
  event.waitUntil(focusOrOpenClient(url));
};

const arrayBufferToBase64Url = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
};

/**
 * Best-effort re-registration after the push service rotates a subscription.
 * The same-origin fetch carries the session cookie, so the authenticated
 * endpoint is usable from the worker. When `newSubscription` is absent
 * (older engines) the subscription is repaired on the next interactive
 * session instead.
 */
const resubscribe = async (event: PushSubscriptionChangeEvent) => {
  // eslint-disable-next-line tscompat/tscompat -- browsers lacking pushsubscriptionchange never reach this handler
  const subscription = event.newSubscription;
  if (!subscription) {
    return;
  }

  const p256dh = subscription.getKey('p256dh');
  const auth = subscription.getKey('auth');
  if (!p256dh || !auth) {
    return;
  }

  try {
    await fetch('/api/push/subscriptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpoint: subscription.endpoint,
        keys: {
          p256dh: arrayBufferToBase64Url(p256dh),
          auth: arrayBufferToBase64Url(auth),
        },
      }),
    });
  } catch {
    // best effort — the app re-registers on the next interactive session
  }
};

const handlePushSubscriptionChange = (event: PushSubscriptionChangeEvent) => {
  // eslint-disable-next-line tscompat/tscompat -- browsers lacking pushsubscriptionchange never reach this handler
  event.waitUntil(resubscribe(event));
};

/** Push event handlers (FG-11). `notificationclose` is intentionally a no-op. */
export const installPushListeners = () => {
  sw.addEventListener('push', handlePush);
  sw.addEventListener('notificationclick', handleNotificationClick);
  sw.addEventListener('pushsubscriptionchange', handlePushSubscriptionChange);
};
