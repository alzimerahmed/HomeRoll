import { MethodNotAllowedException, NotFoundException } from '@nestjs/common';
import request from 'supertest';
import { WebDavController } from 'src/controllers/webdav.controller.js';
import { CacheControl } from 'src/enum.js';
import { WebDavService } from 'src/services/webdav.service.js';
import { ImmichFileResponse } from 'src/utils/file.js';
import { ControllerContext, controllerSetup, mockBaseService } from 'test/utils.js';

describe(WebDavController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(WebDavService);

  // supertest implements every method in the `methods` package (incl. WebDAV
  // verbs) at runtime, but @types only declares the HTTP/1.1 ones.
  const dav = (method: string, path: string) => (request(ctx.getHttpServer()) as any)[method](path);

  beforeAll(async () => {
    ctx = await controllerSetup(WebDavController, [{ provide: WebDavService, useValue: service }]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    ctx.reset();
  });

  describe('OPTIONS', () => {
    it('should advertise DAV compliance and allowed methods', async () => {
      const { status, headers } = await request(ctx.getHttpServer()).options('/webdav');
      expect(status).toBe(200);
      expect(headers['dav']).toBe('1, 2');
      expect(headers['allow']).toContain('PROPFIND');
      expect(headers['allow']).toContain('GET');
      expect(headers['allow']).toContain('LOCK');
    });
  });

  describe('PROPFIND', () => {
    it('should return 207 multi-status with XML', async () => {
      service.propfind.mockResolvedValue([
        { segments: [], name: 'webdav', isCollection: true },
        { segments: ['Libraries'], name: 'Libraries', isCollection: true },
      ]);

      const { status, headers, text } = await dav('propfind', '/webdav').set('Depth', '1');

      expect(status).toBe(207);
      expect(headers['content-type']).toContain('application/xml');
      expect(text).toContain('<D:multistatus xmlns:D="DAV:">');
      expect(text).toContain('<D:href>/webdav/</D:href>');
      expect(text).toContain('<D:href>/webdav/Libraries/</D:href>');
      expect(service.propfind).toHaveBeenCalledWith(undefined, [], 1);
    });

    it('should go through the auth guard', async () => {
      service.propfind.mockResolvedValue([{ segments: [], name: 'webdav', isCollection: true }]);
      await dav('propfind', '/webdav').set('Depth', '0');
      expect(ctx.authenticate).toHaveBeenCalled();
    });

    it('should pass depth 0 to the service', async () => {
      service.propfind.mockResolvedValue([{ segments: [], name: 'webdav', isCollection: true }]);
      await dav('propfind', '/webdav').set('Depth', '0');
      expect(service.propfind).toHaveBeenCalledWith(undefined, [], 0);
    });

    it('should default a missing Depth header to 1', async () => {
      service.propfind.mockResolvedValue([{ segments: [], name: 'webdav', isCollection: true }]);
      await dav('propfind', '/webdav');
      expect(service.propfind).toHaveBeenCalledWith(undefined, [], 1);
    });

    it('should reject Depth: infinity with 403', async () => {
      const { status } = await dav('propfind', '/webdav').set('Depth', 'infinity');
      expect(status).toBe(403);
      expect(service.propfind).not.toHaveBeenCalled();
    });

    it('should reject an invalid Depth header with 400', async () => {
      const { status } = await dav('propfind', '/webdav').set('Depth', '2');
      expect(status).toBe(400);
    });

    it('should split wildcard paths into segments', async () => {
      service.propfind.mockResolvedValue([
        { segments: ['Libraries', 'My Library', 'a.jpg'], name: 'a.jpg', isCollection: false },
      ]);
      const { status, text } = await dav('propfind', '/webdav/Libraries/My%20Library/a.jpg').set(
        'Depth',
        '0',
      );
      expect(status).toBe(207);
      expect(service.propfind).toHaveBeenCalledWith(undefined, ['Libraries', 'My Library', 'a.jpg'], 0);
      expect(text).toContain('/webdav/Libraries/My%20Library/a.jpg');
    });

    it('should propagate service errors', async () => {
      service.propfind.mockRejectedValue(new NotFoundException());
      const { status } = await dav('propfind', '/webdav/nope').set('Depth', '1');
      expect(status).toBe(404);
    });
  });

  describe('GET/HEAD', () => {
    const file = () =>
      new ImmichFileResponse({
        path: import.meta.filename,
        fileName: 'webdav.controller.spec.ts',
        contentType: 'text/plain',
        cacheControl: CacheControl.PrivateWithCache,
      });

    it('should stream a file', async () => {
      service.getFile.mockResolvedValue(file());
      const { status, headers } = await request(ctx.getHttpServer()).get(
        '/webdav/Libraries/My%20Library/a.txt',
      );
      expect(status).toBe(200);
      expect(headers['content-type']).toContain('text/plain');
      expect(service.getFile).toHaveBeenCalledWith(undefined, ['Libraries', 'My Library', 'a.txt']);
    });

    it('should honor Range requests', async () => {
      service.getFile.mockResolvedValue(file());
      const { status, headers } = await request(ctx.getHttpServer())
        .get('/webdav/Libraries/My%20Library/a.txt')
        .set('Range', 'bytes=0-9');
      expect(status).toBe(206);
      expect(headers['content-range']).toContain('bytes 0-9');
    });

    it('should respond to HEAD without a body', async () => {
      service.getFile.mockResolvedValue(file());
      const { status, text } = await request(ctx.getHttpServer()).head(
        '/webdav/Libraries/My%20Library/a.txt',
      );
      expect(status).toBe(200);
      expect(text ?? '').toBe('');
    });

    it('should return 405 for collection paths', async () => {
      service.getFile.mockRejectedValue(new MethodNotAllowedException());
      const { status, headers } = await request(ctx.getHttpServer()).get('/webdav/Libraries');
      expect(status).toBe(405);
      expect(headers['allow']).toContain('PROPFIND');
    });

    it('should return 404 for missing files', async () => {
      service.getFile.mockRejectedValue(new NotFoundException());
      const { status } = await request(ctx.getHttpServer()).get('/webdav/Libraries/x/missing.jpg');
      expect(status).toBe(404);
    });
  });

  describe('LOCK/UNLOCK', () => {
    it('should answer LOCK with a lockdiscovery body and token', async () => {
      const { status, headers, text } = await dav('lock', '/webdav/a.jpg');
      expect(status).toBe(200);
      expect(headers['lock-token']).toContain('opaquelocktoken:');
      expect(text).toContain('<D:lockdiscovery>');
      expect(text).toContain('<D:activelock>');
    });

    it('should answer UNLOCK with 204', async () => {
      const { status } = await dav('unlock', '/webdav/a.jpg');
      expect(status).toBe(204);
    });
  });

  describe('write methods', () => {
    it.each(['put', 'delete', 'mkcol', 'proppatch', 'copy', 'move'])('should return 405 for %s', async (method) => {
      const { status, headers } = await dav(method, '/webdav/x');
      expect(status).toBe(405);
      expect(headers['allow']).toContain('PROPFIND');
    });
  });
});
