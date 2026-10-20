import type { LoginResponseDto } from '@immich/sdk';
import { createUserDto } from 'src/fixtures.js';
import { app, utils } from 'src/utils.js';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

// The WebDAV controller is @ApiExcludeController'd — e2e is the only coverage that
// the wildcard route actually receives DAV methods through the real middleware stack.
describe('/webdav', () => {
  let admin: LoginResponseDto;
  let nonAdmin: LoginResponseDto;

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup({ onboarding: false });
    nonAdmin = await utils.userSetup(admin.accessToken, createUserDto.user1);
  });

  describe('OPTIONS /webdav', () => {
    it('should advertise DAV capabilities', async () => {
      const { status, headers } = await request(app)
        .options('/api/webdav/')
        .set('Authorization', `Bearer ${admin.accessToken}`);

      expect(status).toBe(204);
      expect(headers['dav']).toContain('1');
      expect(headers['allow']).toContain('PROPFIND');
    });
  });

  describe('PROPFIND /webdav', () => {
    it('should return a multistatus response for the root', async () => {
      const { status, text, headers } = await request(app)
        .propfind('/api/webdav/')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .set('Depth', '1');

      expect(status).toBe(207);
      expect(headers['content-type']).toContain('application/xml');
      expect(text).toContain('D:multistatus');
      expect(text).toContain('Libraries');
      expect(text).toContain('Albums');
    });

    it('should reject unauthenticated requests', async () => {
      const { status } = await request(app).propfind('/api/webdav/').set('Depth', '1');
      expect(status).toBe(401);
    });

    it('should reject Depth: infinity', async () => {
      const { status } = await request(app)
        .propfind('/api/webdav/')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .set('Depth', 'infinity');
      expect(status).toBe(403);
    });

    it('should scope libraries to the authenticated user', async () => {
      const library = await utils.createLibrary(admin.accessToken, {
        name: 'admin-lib',
        ownerId: admin.userId,
        importPaths: [],
      });
      expect(library.id).toBeTruthy();

      const { status, text } = await request(app)
        .propfind('/api/webdav/Libraries')
        .set('Authorization', `Bearer ${nonAdmin.accessToken}`)
        .set('Depth', '1');

      expect(status).toBe(207);
      expect(text).not.toContain('admin-lib');
    });
  });

  describe('GET /webdav', () => {
    it('should serve asset bytes through an album path', async () => {
      const asset = await utils.createAsset(admin.accessToken, {
        assetData: { filename: 'dav-test.png' },
      });
      await utils.createAlbum(admin.accessToken, {
        albumName: 'dav-album',
        assetIds: [asset.id],
      });

      const { status, body } = await request(app)
        .get(`/api/webdav/Albums/${encodeURIComponent('dav-album')}/dav-test.png`)
        .set('Authorization', `Bearer ${admin.accessToken}`);

      expect(status).toBe(200);
      expect(body.length).toBeGreaterThan(0);
    });

    it('should reject path traversal', async () => {
      const { status } = await request(app)
        .get('/api/webdav/Libraries/..%2F..%2Fetc')
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect([400, 404]).toContain(status);
    });
  });

  describe('write methods', () => {
    it('should reject PUT', async () => {
      const { status } = await request(app)
        .put('/api/webdav/Libraries/x')
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(status).toBe(405);
    });
  });
});
