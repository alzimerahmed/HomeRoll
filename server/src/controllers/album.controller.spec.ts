import request from 'supertest';
import { AlbumController } from 'src/controllers/album.controller.js';
import { AlbumService } from 'src/services/album.service.js';
import { factory } from 'test/small.factory.js';
import { ControllerContext, controllerSetup, mockBaseService } from 'test/utils.js';

describe(AlbumController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(AlbumService);

  beforeAll(async () => {
    ctx = await controllerSetup(AlbumController, [{ provide: AlbumService, useValue: service }]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    ctx.reset();
  });

  describe('GET /albums', () => {
    it('should reject an invalid shared param', async () => {
      const { status, body } = await request(ctx.getHttpServer()).get('/albums?isShared=invalid');
      expect(status).toEqual(400);
      expect(body).toEqual(
        factory.responses.validationError([
          { path: ['isShared'], message: 'Invalid option: expected one of "true"|"false"' },
        ]),
      );
    });

    it('should reject an invalid assetId param', async () => {
      const { status, body } = await request(ctx.getHttpServer()).get('/albums?assetId=invalid');
      expect(status).toEqual(400);
      expect(body).toEqual(factory.responses.validationError([{ path: ['assetId'], message: 'Invalid UUID' }]));
    });

    it('should reject an invalid parentId param', async () => {
      const { status } = await request(ctx.getHttpServer()).get('/albums?parentId=invalid');
      expect(status).toEqual(400);
    });

    it('should pass a uuid parentId to the service', async () => {
      const parentId = factory.uuid();
      const { status } = await request(ctx.getHttpServer()).get(`/albums?parentId=${parentId}`);
      expect(status).toEqual(200);
      expect(service.getAll).toHaveBeenCalledWith(undefined, expect.objectContaining({ parentId }));
    });

    it('should map the literal "null" parentId to a root-album filter', async () => {
      const { status } = await request(ctx.getHttpServer()).get('/albums?parentId=null');
      expect(status).toEqual(200);
      expect(service.getAll).toHaveBeenCalledWith(undefined, expect.objectContaining({ parentId: null }));
    });
  });

  describe('POST /albums', () => {
    it('should reject a smart album without rules', async () => {
      const { status } = await request(ctx.getHttpServer())
        .post('/albums')
        .send({ albumName: 'Smart', albumType: 'smart' });
      expect(status).toEqual(400);
    });

    it('should reject rules on a manual album', async () => {
      const { status } = await request(ctx.getHttpServer())
        .post('/albums')
        .send({ albumName: 'Manual', albumType: 'manual', rules: { isFavorite: true } });
      expect(status).toEqual(400);
    });

    it('should accept a smart album with rules', async () => {
      const { status } = await request(ctx.getHttpServer())
        .post('/albums')
        .send({ albumName: 'Smart', albumType: 'smart', rules: { isFavorite: true } });
      expect(status).toEqual(201);
      expect(service.create).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({ albumType: 'smart', rules: { isFavorite: true } }),
      );
    });

    it('should accept a nested album create', async () => {
      const { status } = await request(ctx.getHttpServer())
        .post('/albums')
        .send({ albumName: 'Child', parentId: factory.uuid() });
      expect(status).toEqual(201);
      expect(service.create).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({ parentId: expect.any(String) }),
      );
    });
  });

  describe('PATCH /albums/:id', () => {
    it('should reject rules set to null together with albumType smart', async () => {
      const { status } = await request(ctx.getHttpServer())
        .patch(`/albums/${factory.uuid()}`)
        .send({ albumType: 'smart', rules: null });
      expect(status).toEqual(400);
    });

    it('should accept clearing the parentId', async () => {
      const { status } = await request(ctx.getHttpServer())
        .patch(`/albums/${factory.uuid()}`)
        .send({ parentId: null });
      expect(status).toEqual(200);
      expect(service.update).toHaveBeenCalledWith(undefined, expect.any(String), expect.objectContaining({ parentId: null }));
    });
  });

  describe('POST /albums/:id/refresh', () => {
    it('should require a valid album id', async () => {
      const { status } = await request(ctx.getHttpServer()).post('/albums/invalid-id/refresh');
      expect(status).toEqual(400);
    });

    it('should call the service', async () => {
      const id = factory.uuid();
      const { status } = await request(ctx.getHttpServer()).post(`/albums/${id}/refresh`);
      expect(status).toEqual(201);
      expect(service.refreshSmartAlbum).toHaveBeenCalledWith(undefined, id);
    });
  });
});
