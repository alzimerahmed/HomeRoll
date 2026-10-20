import { BadRequestException } from '@nestjs/common';
import { vitest } from 'vitest';
import { UserMetadataKey } from 'src/enum.js';
import { PushRepository } from 'src/repositories/push.repository.js';
import { PushService } from 'src/services/push.service.js';
import { generateVapidKeys } from 'src/utils/web-push.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { factory } from 'test/small.factory.js';
import { ServiceMocks, automock, newTestService } from 'test/utils.js';

const auth = factory.auth();
const userId = auth.user.id;

const subscription = {
  id: factory.uuid(),
  userId,
  endpoint: 'https://push.example.com/send/abc',
  p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  userAgent: 'vitest',
  createdAt: new Date('2024-05-01T10:00:00Z'),
};

const vapidKeys = generateVapidKeys();
const vapidEnv = mockEnvData({
  push: {
    vapidPublicKey: vapidKeys.publicKey,
    vapidPrivateKey: vapidKeys.privateKey,
    vapidSubject: 'mailto:admin@homeroll.test',
  },
});

describe(PushService.name, () => {
  let sut: PushService;
  let mocks: ServiceMocks;
  const pushRepository = automock(PushRepository, { strict: false });
  const fetchMock = vitest.fn();

  beforeEach(() => {
    ({ sut, mocks } = newTestService(PushService));
    Object.assign(sut, { pushRepository });
    pushRepository.resetAllMocks();
    fetchMock.mockReset();
    vitest.stubGlobal('fetch', fetchMock);
    mocks.config.getEnv.mockReturnValue(vapidEnv);
    pushRepository.getByUserId.mockResolvedValue([]);
  });

  afterEach(() => {
    vitest.unstubAllGlobals();
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('getVapidPublicKey', () => {
    it('returns the configured public key', async () => {
      await expect(sut.getVapidPublicKey()).resolves.toEqual({ publicKey: vapidKeys.publicKey });
    });

    it('returns null when push is not configured', async () => {
      mocks.config.getEnv.mockReturnValue(mockEnvData({}));
      await expect(sut.getVapidPublicKey()).resolves.toEqual({ publicKey: null });
    });
  });

  describe('getSubscriptions', () => {
    it('returns the user subscriptions', async () => {
      pushRepository.getByUserId.mockResolvedValue([subscription]);
      await expect(sut.getSubscriptions(auth)).resolves.toEqual([
        {
          id: subscription.id,
          endpoint: subscription.endpoint,
          userAgent: subscription.userAgent,
          createdAt: subscription.createdAt,
        },
      ]);
      expect(pushRepository.getByUserId).toHaveBeenCalledWith(userId);
    });
  });

  describe('subscribe', () => {
    it('upserts a subscription', async () => {
      pushRepository.upsert.mockResolvedValue(subscription);

      const dto = { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } };
      await expect(sut.subscribe(auth, dto, 'agent/1.0')).resolves.toEqual(
        expect.objectContaining({ id: subscription.id, endpoint: subscription.endpoint }),
      );
      expect(pushRepository.upsert).toHaveBeenCalledWith({
        userId,
        endpoint: subscription.endpoint,
        p256dh: subscription.p256dh,
        auth: subscription.auth,
        userAgent: 'agent/1.0',
      });
    });

    it('rejects endpoints on private/loopback hosts', async () => {
      const dto = {
        endpoint: 'https://169.254.169.254/latest',
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      };
      await expect(sut.subscribe(auth, dto, 'agent/1.0')).rejects.toBeInstanceOf(BadRequestException);
      expect(pushRepository.upsert).not.toHaveBeenCalled();
    });

    it('enforces the per-user subscription cap', async () => {
      pushRepository.getByUserId.mockResolvedValue(
        Array.from({ length: 10 }, () => ({ ...subscription, endpoint: `https://push.example.com/${factory.uuid()}` })),
      );

      const dto = {
        endpoint: 'https://push.example.com/new-endpoint',
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      };
      await expect(sut.subscribe(auth, dto, 'agent/1.0')).rejects.toBeInstanceOf(BadRequestException);
      expect(pushRepository.upsert).not.toHaveBeenCalled();
    });

    it('allows re-subscribing an existing endpoint when at the cap', async () => {
      pushRepository.getByUserId.mockResolvedValue(
        Array.from({ length: 10 }, (_, i) => ({
          ...subscription,
          endpoint: i === 0 ? subscription.endpoint : `https://push.example.com/${factory.uuid()}`,
        })),
      );
      pushRepository.upsert.mockResolvedValue(subscription);

      const dto = { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } };
      await expect(sut.subscribe(auth, dto, 'agent/1.0')).resolves.toBeDefined();
      expect(pushRepository.upsert).toHaveBeenCalled();
    });
  });

  describe('unsubscribe', () => {
    it('deletes the subscription owned by the user', async () => {
      await sut.unsubscribe(auth, { endpoint: subscription.endpoint });
      expect(pushRepository.delete).toHaveBeenCalledWith(userId, subscription.endpoint);
    });
  });

  describe('sendPushNotification', () => {
    it('does nothing when push is not configured', async () => {
      mocks.config.getEnv.mockReturnValue(mockEnvData({}));
      await expect(sut.sendPushNotification([userId], { title: 'hi' })).resolves.toBe(0);
      expect(pushRepository.getByUserIds).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('sends to every subscription of the user', async () => {
      pushRepository.getByUserIds.mockResolvedValue([subscription]);
      fetchMock.mockResolvedValue({ ok: true, status: 201 });

      await expect(sut.sendPushNotification([userId], { title: 'hi' })).resolves.toBe(1);
      expect(fetchMock).toHaveBeenCalledWith(
        subscription.endpoint,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Encoding': 'aes128gcm',
            TTL: '2419200',
            Urgency: 'normal',
          }),
        }),
      );
      const init = fetchMock.mock.calls[0][1];
      expect(init.headers.Authorization).toMatch(/^vapid t=/);
      expect(Buffer.isBuffer(init.body)).toBe(true);
    });

    it('deletes dead subscriptions on 404/410', async () => {
      pushRepository.getByUserIds.mockResolvedValue([subscription]);
      fetchMock.mockResolvedValue({ ok: false, status: 410 });

      await expect(sut.sendPushNotification([userId], { title: 'hi' })).resolves.toBe(0);
      expect(pushRepository.deleteByEndpoint).toHaveBeenCalledWith(subscription.endpoint);
    });

    it('logs and drops other failures', async () => {
      pushRepository.getByUserIds.mockResolvedValue([subscription]);
      fetchMock.mockResolvedValue({ ok: false, status: 500 });

      await expect(sut.sendPushNotification([userId], { title: 'hi' })).resolves.toBe(0);
      expect(pushRepository.deleteByEndpoint).not.toHaveBeenCalled();
      expect(mocks.logger.warn).toHaveBeenCalled();
    });
  });

  describe('sendTestNotification', () => {
    it('sends a test notification to the caller', async () => {
      pushRepository.getByUserIds.mockResolvedValue([subscription]);
      fetchMock.mockResolvedValue({ ok: true, status: 201 });

      await expect(sut.sendTestNotification(auth)).resolves.toEqual({ delivered: 1 });
      expect(pushRepository.getByUserIds).toHaveBeenCalledWith([userId]);
    });
  });

  describe('onAlbumUpdate', () => {
    const album = { id: 'album-1', albumName: 'Vacation' };

    it('does nothing without recipients', async () => {
      await sut.onAlbumUpdate({ id: album.id, userIds: [userId], recipientIds: [] });
      expect(mocks.album.getById).not.toHaveBeenCalled();
    });

    it('does nothing when push is not configured', async () => {
      mocks.config.getEnv.mockReturnValue(mockEnvData({}));
      await sut.onAlbumUpdate({ id: album.id, userIds: [], recipientIds: ['recipient-1'] });
      expect(mocks.album.getById).not.toHaveBeenCalled();
    });

    it('does nothing when the album is gone', async () => {
      mocks.album.getById.mockResolvedValue(undefined as never);
      await sut.onAlbumUpdate({ id: album.id, userIds: [], recipientIds: ['recipient-1'] });
      expect(pushRepository.getByUserIds).not.toHaveBeenCalled();
    });

    it('pushes to recipients, excluding subscribers who opted out', async () => {
      mocks.album.getById.mockResolvedValue(album as never);
      mocks.user.get.mockImplementation(
        (id: string) =>
          Promise.resolve(
            id === 'opted-out'
              ? {
                  id,
                  metadata: [
                    {
                      key: UserMetadataKey.Preferences,
                      value: { pushNotifications: { enabled: true, albumUpdate: false } },
                    },
                  ],
                }
              : { id, metadata: [] },
          ) as never,
      );
      pushRepository.getByUserIds.mockResolvedValue([subscription]);
      fetchMock.mockResolvedValue({ ok: true, status: 201 });

      await sut.onAlbumUpdate({ id: album.id, userIds: [], recipientIds: [userId, 'opted-out'] });

      // the actor is already excluded upstream via recipientIds; opt-outs are filtered here
      expect(pushRepository.getByUserIds).toHaveBeenCalledWith([userId]);
      expect(fetchMock).toHaveBeenCalledWith(subscription.endpoint, expect.objectContaining({ method: 'POST' }));
    });
  });

  describe('onAlbumInvite', () => {
    it('pushes an invite to the invited user', async () => {
      const album = { id: 'album-1', albumName: 'Vacation' };
      mocks.album.getById.mockResolvedValue(album as never);
      mocks.user.get.mockResolvedValue({ id: 'invitee', metadata: [] } as never);
      pushRepository.getByUserIds.mockResolvedValue([subscription]);
      fetchMock.mockResolvedValue({ ok: true, status: 201 });

      await sut.onAlbumInvite({ id: album.id, userId: 'invitee', senderName: 'John' });

      expect(pushRepository.getByUserIds).toHaveBeenCalledWith(['invitee']);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
