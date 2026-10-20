import request from 'supertest';
import { PushController } from 'src/controllers/push.controller.js';
import { PushService } from 'src/services/push.service.js';
import { ControllerContext, controllerSetup, mockBaseService } from 'test/utils.js';

describe(PushController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(PushService);

  beforeAll(async () => {
    ctx = await controllerSetup(PushController, [{ provide: PushService, useValue: service }]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    ctx.reset();
  });

  describe('GET /push/vapid-public-key', () => {
    it('should be an authenticated route', async () => {
      await request(ctx.getHttpServer()).get('/push/vapid-public-key');

      expect(ctx.authenticate).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ sharedLinkRoute: false, adminRoute: false }),
        }),
      );
    });
  });

  describe('POST /push/subscriptions', () => {
    it('should require a valid subscription body', async () => {
      const { status } = await request(ctx.getHttpServer()).post('/push/subscriptions').send({});
      expect(status).toBe(400);
      expect(service.subscribe).not.toHaveBeenCalled();
    });

    it('should register a subscription', async () => {
      const body = {
        endpoint: 'https://push.example.com/send/abc',
        keys: { p256dh: 'key', auth: 'secret' },
      };
      await request(ctx.getHttpServer()).post('/push/subscriptions').send(body);

      expect(service.subscribe.mock.calls[0][1]).toEqual(body);
    });
  });

  describe('DELETE /push/subscriptions', () => {
    it('should delete by endpoint', async () => {
      const body = { endpoint: 'https://push.example.com/send/abc' };
      const { status } = await request(ctx.getHttpServer()).delete('/push/subscriptions').send(body);

      expect(status).toBe(204);
      expect(service.unsubscribe).toHaveBeenCalledWith(undefined, body);
    });
  });

  describe('POST /push/test', () => {
    it('should send a test notification', async () => {
      await request(ctx.getHttpServer()).post('/push/test');
      expect(service.sendTestNotification).toHaveBeenCalled();
    });
  });
});
