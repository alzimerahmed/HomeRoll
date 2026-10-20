import {
  createPushSubscription,
  deletePushSubscription,
  sendTestPushNotification,
  type PushTestResponseDto,
} from '@immich/sdk';
import { queryClient } from '$lib/queries/client';
import { getPushSubscriptionsQuery } from '$lib/queries/push.query';
import {
  asPushSubscriptionCreateDto,
  getBrowserPushSubscription,
  getNotificationPermission,
  isPushSupported,
  urlBase64ToUint8Array,
} from '$lib/utils/push';

export type PushSubscribeResult = 'subscribed' | 'denied' | 'unsupported';

const invalidateSubscriptions = () => queryClient.invalidateQueries({ queryKey: getPushSubscriptionsQuery().queryKey });

/**
 * Browser-side push subscription lifecycle (FG-11). Owns the local
 * `PushSubscription` state and keeps the server subscription table in sync
 * (`POST/DELETE /api/push/subscriptions`). User-facing notification categories
 * live in `authManager.preferences.pushNotifications` — filtered server-side.
 */
class PushManager {
  /** The subscription registered in this browser, if any. */
  subscription = $state<PushSubscription>();
  #permission = $state<NotificationPermission | undefined>(getNotificationPermission());

  get supported() {
    return isPushSupported();
  }

  get permission() {
    return this.#permission;
  }

  /** Refresh the cached browser subscription + permission. Call from `onMount`. */
  async sync() {
    this.#permission = getNotificationPermission();
    this.subscription = await getBrowserPushSubscription();
  }

  /**
   * Request permission, register a browser push subscription, and register it
   * with the server. Rolls the browser subscription back if the API call fails.
   */
  async subscribe(vapidPublicKey: string): Promise<PushSubscribeResult> {
    if (!isPushSupported()) {
      return 'unsupported';
    }

    this.#permission = await Notification.requestPermission();
    if (this.#permission !== 'granted') {
      return 'denied';
    }

    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      userVisibleOnly: true,
    });

    try {
      await createPushSubscription({ pushSubscriptionCreateDto: asPushSubscriptionCreateDto(subscription) });
    } catch (error) {
      await subscription.unsubscribe();
      throw error;
    }

    this.subscription = subscription;
    await invalidateSubscriptions();
    return 'subscribed';
  }

  /**
   * Unregister this browser's push subscription, then delete the server record.
   * Dead endpoints are also pruned server-side on the next send (404/410), so a
   * failed delete leaves only a stale record — still surfaced to the caller.
   */
  async unsubscribe() {
    const subscription = this.subscription ?? (await getBrowserPushSubscription());
    if (!subscription) {
      return;
    }

    const endpoint = subscription.endpoint;
    await subscription.unsubscribe();
    this.subscription = undefined;

    try {
      await deletePushSubscription({ pushSubscriptionDeleteDto: { endpoint } });
    } finally {
      await invalidateSubscriptions();
    }
  }

  /** Delete a server-side subscription record for another (e.g. stale) device. */
  async deleteSubscription(endpoint: string) {
    await deletePushSubscription({ pushSubscriptionDeleteDto: { endpoint } });
    await invalidateSubscriptions();
  }

  /** Send a test push notification to all of the current user's subscriptions. */
  sendTest(): Promise<PushTestResponseDto> {
    return sendTestPushNotification();
  }
}

export const pushManager = new PushManager();
