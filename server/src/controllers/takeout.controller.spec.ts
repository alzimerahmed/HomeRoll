import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { TakeoutController } from 'src/controllers/takeout.controller.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { TakeoutImportState } from 'src/dtos/takeout.dto.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { TakeoutService } from 'src/services/takeout.service.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { errorDto } from 'test/medium/responses.js';
import { factory } from 'test/small.factory.js';
import { ControllerContext, automock, controllerSetup, mockBaseService } from 'test/utils.js';

describe(TakeoutController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(TakeoutService);
  const archiveData = Buffer.from('123');
  const filename = 'takeout.tgz';

  beforeAll(async () => {
    // the upload interceptor stages the archive inside the media location
    const mediaLocation = await mkdtemp(join(tmpdir(), 'takeout-controller-spec-'));
    StorageCore.setMediaLocation(mediaLocation);
    ctx = await controllerSetup(TakeoutController, [
      { provide: TakeoutService, useValue: service },
      { provide: LoggingRepository, useValue: automock(LoggingRepository, { strict: false }) },
      { provide: StorageRepository, useValue: new StorageRepository(LoggingRepository.create()) },
    ]);
    return async () => {
      await ctx.close();
      await rm(mediaLocation, { recursive: true, force: true });
    };
  });

  beforeEach(() => {
    service.resetAllMocks();
    ctx.reset();
    ctx.authenticate.mockResolvedValue(authStub.user1);
  });

  describe('POST /takeout', () => {
    it('should accept a takeout archive', async () => {
      const id = factory.uuid();
      service.uploadArchive.mockResolvedValue({ id, fileName: filename, status: TakeoutImportState.Queued });

      const { status, body } = await request(ctx.getHttpServer())
        .post('/takeout')
        .attach('file', archiveData, filename)
        .set('Authorization', 'Bearer token');

      expect(status).toBe(201);
      expect(body).toEqual({ id, fileName: filename, status: 'queued' });
      expect(service.uploadArchive).toHaveBeenCalledWith(
        authStub.user1,
        expect.objectContaining({ originalname: filename }),
      );
    });

    it('should reject unsupported file extensions', async () => {
      const { status } = await request(ctx.getHttpServer())
        .post('/takeout')
        .attach('file', archiveData, 'takeout.exe')
        .set('Authorization', 'Bearer token');

      expect(status).toBe(400);
      expect(service.uploadArchive).not.toHaveBeenCalled();
    });
  });

  describe('GET /takeout', () => {
    it('should list imports', async () => {
      service.getImports.mockResolvedValue([]);

      const { status } = await request(ctx.getHttpServer()).get('/takeout').set('Authorization', 'Bearer token');

      expect(status).toBe(200);
      expect(service.getImports).toHaveBeenCalledWith(authStub.user1);
    });
  });

  describe('GET /takeout/:id', () => {
    it('should return the import status', async () => {
      const id = factory.uuid();
      service.getImport.mockResolvedValue({
        id,
        fileName: filename,
        status: TakeoutImportState.Processing,
        createdAt: 1,
      });

      const { status, body } = await request(ctx.getHttpServer())
        .get(`/takeout/${id}`)
        .set('Authorization', 'Bearer token');

      expect(status).toBe(200);
      expect(body.id).toBe(id);
      expect(service.getImport).toHaveBeenCalledWith(authStub.user1, id);
    });

    it('should require id to be a uuid', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .get('/takeout/invalid')
        .set('Authorization', 'Bearer token');

      expect(status).toBe(400);
      expect(body).toEqual(errorDto.validationError([{ path: ['id'], message: 'Invalid UUID' }]));
    });
  });

  describe('DELETE /takeout/:id', () => {
    it('should require id to be a uuid', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .delete('/takeout/invalid')
        .set('Authorization', 'Bearer token');

      expect(status).toBe(400);
      expect(body).toEqual(errorDto.validationError([{ path: ['id'], message: 'Invalid UUID' }]));
    });

    it('should cancel an import', async () => {
      const id = factory.uuid();
      service.cancelImport.mockResolvedValue({
        id,
        fileName: filename,
        status: TakeoutImportState.Cancelled,
        createdAt: 1,
      });

      const { status } = await request(ctx.getHttpServer())
        .delete(`/takeout/${id}`)
        .set('Authorization', 'Bearer token');

      expect(status).toBe(200);
      expect(service.cancelImport).toHaveBeenCalledWith(authStub.user1, id);
    });
  });
});
