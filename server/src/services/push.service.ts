import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { Selectable } from 'kysely';
import type { ArgOf } from 'src/repositories/event.repository.js';
import { OnEvent } from 'src/decorators.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import {
  PushSubscriptionCreateDto,
  PushSubscriptionDeleteDto,
  PushSubscriptionResponseDto,
  PushTestResponseDto,
  VapidPublicKeyResponseDto,
} from 'src/dtos/push.dto.js';
import { PushRepository } from 'src/repositories/push.repository.js';
import { PushSubscriptionTable } from 'src/schema/tables/push-subscription.table.js';
import { BaseService } from 'src/services/base.service.js';
import { getPreferences } from 'src/utils/preferences.js';
import {
  VapidConfig,
  WebPushPayload,
  buildVapidAuthorization,
  encryptWebPushPayload,
} from 'src/utils/web-push.js';

/** Web Push TTL: keep undelivered notifications for 4 weeks (RFC 8030 max suggestion). */
const PUSH_TTL_SECONDS = 2_419_200;

/** Outbound push POST timeout — a slow endpoint must not wedge event fan-out. */
const PUSH_TIMEOUT_MS = 10_000;

/** Max subscriptions per user — bounds table growth and fan-out cost. */
const MAX_PUSH_SUBSCRIPTIONS_PER_USER = 10;

/**
 * SSRF guard (defense in depth on top of the https-only DTO refine): reject
 * endpoints pointing at loopback/private/link-local/reserved hosts so a
 * self-hosted server never POSTs into the operator's LAN.
 */
const isPrivatePushHost = (hostname: string): boolean => {
  const host = hostname.replace(/^\[|]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return true;
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && b <= 2) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (host.includes(':')) {
    if (host.startsWith('::ffff:')) {
      // IPv4-mapped IPv6 — evaluate the embedded IPv4 octets
      const mapped = host.slice(7).replace(/\./g, '.');
      const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(mapped);
      if (ipv4) {
        const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
        return (
          a === 0 ||
          a === 10 ||
          a === 127 ||
          a >= 224 ||
          (a === 100 && b >= 64 && b <= 127) ||
          (a === 169 && b === 254) ||
          (a === 172 && b >= 16 && b <= 31) ||
          (a === 192 && b === 0 && b <= 2) ||
          (a === 192 && b === 168) ||
          (a === 198 && (b === 18 || b === 19))
        );
      }
      return false;
    }
    return (
      host === '::' ||
      host === '::1' ||
      host.startsWith('fe8') ||
      host.startsWith('fe9') ||
      host.startsWith('fea') ||
      host.startsWith('feb') ||
      host.startsWith('fc') ||
      host.startsWith('fd')
    );
  }
  return false;
};

const mapSubscription = (subscription: Selectable<PushSubscriptionTable>): PushSubscriptionResponseDto => ({
  id: subscription.id,
  endpoint: subscription.endpoint,
  userAgent: subscription.userAgent,
  createdAt: subscription.createdAt instanceof Date ? subscription.createdAt : new Date(subscription.createdAt),
});

/**
 * Web Push notifications (FG-11), dependency-free (RFC 8291 + RFC 8292 via
 * `node:crypto` in `src/utils/web-push.ts`). Configured through env vars
 * `IMMICH_VAPID_PUBLIC_KEY` / `IMMICH_VAPID_PRIVATE_KEY` / `IMMICH_VAPID_SUBJECT`;
 * cleanly disabled when unset.
 *
 * Extends BaseService per upstream convention. The dedicated PushRepository
 * cannot ride the BaseService constructor (fixed positional deps shared with
 * test/newTestService), so it is property-injected — same pattern as
 * WebDavService/WebDavRepository.
 */
@Injectable()
export class PushService extends BaseService {
  @Inject(PushRepository)
  private pushRepository!: PushRepository;

  /** VAPID configuration, or `undefined` when push is not configured. */
  private getVapid(): VapidConfig | undefined {
    const { vapidPublicKey, vapidPrivateKey, vapidSubject } = this.configRepository.getEnv().push ?? {};
    if (!vapidPublicKey || !vapidPrivateKey) {
      return undefined;
    }
    return { publicKey: vapidPublicKey, privateKey: vapidPrivateKey, subject: vapidSubject };
  }

  isEnabled(): boolean {
    return !!this.getVapid();
  }

  getVapidPublicKey(): Promise<VapidPublicKeyResponseDto> {
    return Promise.resolve({ publicKey: this.getVapid()?.publicKey ?? null });
  }

  async getSubscriptions(auth: AuthDto): Promise<PushSubscriptionResponseDto[]> {
    const subscriptions = await this.pushRepository.getByUserId(auth.user.id);
    return subscriptions.map(mapSubscription);
  }

  async subscribe(
    auth: AuthDto,
    dto: PushSubscriptionCreateDto,
    userAgent?: string,
  ): Promise<PushSubscriptionResponseDto> {
    if (isPrivatePushHost(new URL(dto.endpoint).hostname)) {
      throw new BadRequestException('Push endpoint host is not allowed');
    }

    const existing = await this.pushRepository.getByUserId(auth.user.id);
    if (existing.length >= MAX_PUSH_SUBSCRIPTIONS_PER_USER && !existing.some((s) => s.endpoint === dto.endpoint)) {
      throw new BadRequestException(`At most ${MAX_PUSH_SUBSCRIPTIONS_PER_USER} push subscriptions per user`);
    }

    const subscription = await this.pushRepository.upsert({
      userId: auth.user.id,
      endpoint: dto.endpoint,
      p256dh: dto.keys.p256dh,
      auth: dto.keys.auth,
      userAgent: userAgent || null,
    });
    return mapSubscription(subscription);
  }

  async unsubscribe(auth: AuthDto, dto: PushSubscriptionDeleteDto): Promise<void> {
    await this.pushRepository.delete(auth.user.id, dto.endpoint);
  }

  /** Exercises the full send pipeline against the caller's own subscriptions. */
  async sendTestNotification(auth: AuthDto): Promise<PushTestResponseDto> {
    const delivered = await this.sendPushNotification([auth.user.id], {
      title: 'HomeRoll',
      body: 'Push notifications are working',
      url: '/',
      tag: 'push-test',
    });
    return { delivered };
  }

  /**
   * Fan a notification out to every subscription of the given users.
   * Sends are independent: dead endpoints (404/410) are pruned, other
   * failures are logged and dropped — no retries.
   *
   * @returns the number of subscriptions the payload was delivered to
   */
  async sendPushNotification(userIds: string[], payload: WebPushPayload): Promise<number> {
    const vapid = this.getVapid();
    if (!vapid || userIds.length === 0) {
      return 0;
    }

    const subscriptions = await this.pushRepository.getByUserIds(userIds);
    let delivered = 0;

    await Promise.all(
      subscriptions.map(async (subscription) => {
        try {
          if (await this.send(subscription, vapid, payload)) {
            delivered++;
          }
        } catch (error: Error | any) {
          // endpoint is a bearer-capability URL — log origin only
          this.logger.warn(`Failed to send push notification to ${new URL(subscription.endpoint).origin}: ${error?.message}`);
        }
      }),
    );

    return delivered;
  }

  private async send(
    subscription: Selectable<PushSubscriptionTable>,
    vapid: VapidConfig,
    payload: WebPushPayload,
  ): Promise<boolean> {
    const body = encryptWebPushPayload(JSON.stringify(payload), subscription);
    const response = await fetch(subscription.endpoint, {
      method: 'POST',
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        TTL: `${PUSH_TTL_SECONDS}`,
        Urgency: 'normal',
        Authorization: buildVapidAuthorization(subscription.endpoint, vapid),
      },
      body: new Uint8Array(body),
    });

    if (response.status === 404 || response.status === 410) {
      await this.pushRepository.deleteByEndpoint(subscription.endpoint);
      return false;
    }

    if (!response.ok) {
      throw new Error(`Push service responded with ${response.status}`);
    }
    return true;
  }

  /**
   * Shared-album update fan-out. `recipientIds` already excludes the actor
   * (see album.service), mirroring the in-app/email notification path. Unlike
   * the email path there is no debounce — one push per `AlbumUpdate` event.
   */
  @OnEvent({ name: 'AlbumUpdate' })
  async onAlbumUpdate({ id, recipientIds }: ArgOf<'AlbumUpdate'>) {
    if (recipientIds.length === 0 || !this.isEnabled()) {
      return;
    }

    const album = await this.albumRepository.getById(id);
    if (!album) {
      return;
    }

    const userIds = await this.filterRecipients(recipientIds, 'albumUpdate');
    await this.sendPushNotification(userIds, {
      title: 'Shared Album Update',
      body: `New media has been added to the album (${album.albumName})`,
      url: `/albums/${album.id}`,
      tag: `album-update-${album.id}`,
    });
  }

  @OnEvent({ name: 'AlbumInvite' })
  async onAlbumInvite({ id, userId, senderName }: ArgOf<'AlbumInvite'>) {
    if (!this.isEnabled()) {
      return;
    }

    const album = await this.albumRepository.getById(id);
    if (!album) {
      return;
    }

    const userIds = await this.filterRecipients([userId], 'albumInvite');
    await this.sendPushNotification(userIds, {
      title: 'Shared Album Invitation',
      body: `${senderName} shared an album (${album.albumName}) with you`,
      url: `/albums/${album.id}`,
      tag: `album-invite-${album.id}`,
    });
  }

  /** Drop users who disabled the given push notification category. */
  private async filterRecipients(
    userIds: string[],
    preference: 'albumInvite' | 'albumUpdate',
  ): Promise<string[]> {
    const result: string[] = [];
    for (const userId of userIds) {
      const user = await this.userRepository.get(userId, { withDeleted: false });
      if (!user) {
        continue;
      }

      const { pushNotifications } = getPreferences(user.metadata);
      if (pushNotifications.enabled && pushNotifications[preference]) {
        result.push(userId);
      }
    }
    return result;
  }
}
