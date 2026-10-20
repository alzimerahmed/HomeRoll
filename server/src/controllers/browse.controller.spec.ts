import { NotFoundException } from '@nestjs/common';
import request from 'supertest';
import { BrowseController } from 'src/controllers/browse.controller.js';
import { BrowseService } from 'src/services/browse.service.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { errorDto } from 'test/medium/responses.js';
import { newUuid } from 'test/small.factory.js';
import { ControllerContext, controllerSetup, mockBaseService } from 'test/utils.js';

describe(BrowseController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(BrowseService);

  beforeAll(async () => {
    ctx = await controllerSetup(BrowseController, [{ provide: BrowseService, useValue: service }]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    ctx.reset();
    ctx.authenticate.mockResolvedValue(authStub.user1);
  });

  describe('GET /browse/labels', () => {
    it('should return the label list', async () => {
      const previewAssetId = newUuid();
      service.getLabels.mockResolvedValue([{ key: 'beach', label: 'Beach', count: 3, previewAssetId }]);

      const { status, body } = await request(ctx.getHttpServer())
        .get('/browse/labels')
        .set('Authorization', 'Bearer token');

      expect(status).toBe(200);
      expect(body).toEqual([{ key: 'beach', label: 'Beach', count: 3, previewAssetId }]);
      expect(service.getLabels).toHaveBeenCalledWith(authStub.user1);
    });
  });

  describe('GET /browse/labels/:key', () => {
    it('should return the label assets page', async () => {
      service.getLabelAssets.mockResolvedValue({ count: 0, items: [], nextCursor: null });

      const { status, body } = await request(ctx.getHttpServer())
        .get('/browse/labels/beach')
        .set('Authorization', 'Bearer token');

      expect(status).toBe(200);
      expect(body).toEqual({ count: 0, items: [], nextCursor: null });
      expect(service.getLabelAssets).toHaveBeenCalledWith(authStub.user1, 'beach', { size: 250 });
    });

    it('should reject size as a string', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .get('/browse/labels/beach?size=abc')
        .set('Authorization', 'Bearer token');

      expect(status).toBe(400);
      expect(body).toEqual(errorDto.validationError([{ path: ['size'], message: expect.any(String) }]));
    });

    it('should reject size as 0', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .get('/browse/labels/beach?size=0')
        .set('Authorization', 'Bearer token');

      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([{ path: ['size'], message: 'Too small: expected number to be >=1' }]),
      );
    });

    it('should reject size over the maximum', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .get('/browse/labels/beach?size=1001')
        .set('Authorization', 'Bearer token');

      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([{ path: ['size'], message: 'Too big: expected number to be <=1000' }]),
      );
    });

    it('should pass size and cursor to the service', async () => {
      service.getLabelAssets.mockResolvedValue({ count: 0, items: [], nextCursor: null });

      const { status } = await request(ctx.getHttpServer())
        .get('/browse/labels/beach?size=50&cursor=abc')
        .set('Authorization', 'Bearer token');

      expect(status).toBe(200);
      expect(service.getLabelAssets).toHaveBeenCalledWith(authStub.user1, 'beach', { size: 50, cursor: 'abc' });
    });

    it('should surface a 404 for an unknown label key', async () => {
      service.getLabelAssets.mockRejectedValue(new NotFoundException("Unknown browse label 'nope'"));

      const { status } = await request(ctx.getHttpServer())
        .get('/browse/labels/nope')
        .set('Authorization', 'Bearer token');

      expect(status).toBe(404);
    });

    it('should reject a key longer than 64 characters', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .get(`/browse/labels/${'a'.repeat(65)}`)
        .set('Authorization', 'Bearer token');

      expect(status).toBe(400);
      expect(body).toEqual(errorDto.validationError([{ path: ['key'], message: expect.any(String) }]));
    });
  });
});
