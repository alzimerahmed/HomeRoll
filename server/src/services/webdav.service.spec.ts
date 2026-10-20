import { BadRequestException, MethodNotAllowedException, NotFoundException } from '@nestjs/common';
import { WebDavRepository } from 'src/repositories/webdav.repository.js';
import { DAV_ALBUMS, DAV_LIBRARIES, WebDavService } from 'src/services/webdav.service.js';
import { ImmichFileResponse } from 'src/utils/file.js';
import { factory } from 'test/small.factory.js';
import { ServiceMocks, automock, newTestService } from 'test/utils.js';

const auth = factory.auth();
const assetId = factory.uuid();
const libraryId = factory.uuid();
const albumId = factory.uuid();

const assetRow = {
  id: assetId,
  fileName: 'IMG_0001.jpg',
  originalPath: '/data/library/asset-1.jpg',
  checksum: Buffer.from('abc123', 'hex'),
  fileCreatedAt: new Date('2024-05-01T10:00:00Z'),
  fileModifiedAt: new Date('2024-05-02T10:00:00Z'),
  fileSize: '1024',
};

describe(WebDavService.name, () => {
  let sut: WebDavService;
  let mocks: ServiceMocks;
  const webdavRepository = automock(WebDavRepository, { strict: false });

  beforeEach(() => {
    ({ sut, mocks } = newTestService(WebDavService));
    Object.assign(sut, { webdavRepository });
    webdavRepository.resetAllMocks();
  });

  describe('propfind', () => {
    it('should return only the root collection at depth 0', async () => {
      const resources = await sut.propfind(auth, [], 0);
      expect(resources).toHaveLength(1);
      expect(resources[0]).toMatchObject({ segments: [], isCollection: true });
    });

    it('should return the root and top-level collections at depth 1', async () => {
      const resources = await sut.propfind(auth, [], 1);
      expect(resources).toHaveLength(3);
      expect(resources.map((r) => r.name)).toEqual(['webdav', DAV_LIBRARIES, DAV_ALBUMS]);
      expect(resources.every((r) => r.isCollection)).toBe(true);
    });

    it('should list libraries at depth 1', async () => {
      mocks.library.getAll.mockResolvedValue([
        { id: libraryId, name: 'My Library', createdAt: new Date(), updatedAt: new Date() },
      ] as never);
      const resources = await sut.propfind(auth, [DAV_LIBRARIES], 1);
      expect(resources).toHaveLength(2);
      expect(resources[0].segments).toEqual([DAV_LIBRARIES]);
      expect(resources[1]).toMatchObject({ name: 'My Library', segments: [DAV_LIBRARIES, 'My Library'] });
      expect(mocks.library.getAll).toHaveBeenCalled();
    });

    it('should list only the caller albums at depth 1', async () => {
      mocks.album.getAll.mockResolvedValue([
        { id: albumId, albumName: 'Vacation', createdAt: new Date(), updatedAt: new Date() },
      ] as never);
      const resources = await sut.propfind(auth, [DAV_ALBUMS], 1);
      expect(resources).toHaveLength(2);
      expect(resources[1]).toMatchObject({ name: 'Vacation', segments: [DAV_ALBUMS, 'Vacation'] });
      expect(mocks.album.getAll).toHaveBeenCalledWith(auth.user.id);
    });

    it('should list assets of a library collection at depth 1', async () => {
      mocks.library.getAll.mockResolvedValue([{ id: libraryId, name: 'My Library' }] as never);
      webdavRepository.getAssetsByLibraryId.mockResolvedValue([assetRow] as never);
      const resources = await sut.propfind(auth, [DAV_LIBRARIES, 'My Library'], 1);
      expect(resources).toHaveLength(2);
      expect(resources[1]).toMatchObject({
        name: 'IMG_0001.jpg',
        isCollection: false,
        size: 1024,
        mimeType: 'image/jpeg',
        etag: 'abc123',
        segments: [DAV_LIBRARIES, 'My Library', 'IMG_0001.jpg'],
      });
      expect(webdavRepository.getAssetsByLibraryId).toHaveBeenCalledWith(auth.user.id, libraryId);
    });

    it('should not list assets at depth 0', async () => {
      mocks.library.getAll.mockResolvedValue([{ id: libraryId, name: 'My Library' }] as never);
      const resources = await sut.propfind(auth, [DAV_LIBRARIES, 'My Library'], 0);
      expect(resources).toHaveLength(1);
      expect(webdavRepository.getAssetsByLibraryId).not.toHaveBeenCalled();
    });

    it('should resolve a file resource', async () => {
      mocks.library.getAll.mockResolvedValue([{ id: libraryId, name: 'My Library' }] as never);
      webdavRepository.getAssetsByLibraryId.mockResolvedValue([assetRow] as never);
      const resources = await sut.propfind(auth, [DAV_LIBRARIES, 'My Library', 'IMG_0001.jpg'], 1);
      expect(resources).toHaveLength(1);
      expect(resources[0].isCollection).toBe(false);
    });

    it('should reject traversal segments', async () => {
      await expect(sut.propfind(auth, ['..', 'etc'], 1)).rejects.toBeInstanceOf(BadRequestException);
      await expect(sut.propfind(auth, [DAV_LIBRARIES, '..'], 1)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should 404 on an unknown root collection', async () => {
      await expect(sut.propfind(auth, ['Secrets'], 1)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('should 404 on an unknown library name', async () => {
      mocks.library.getAll.mockResolvedValue([]);
      await expect(sut.propfind(auth, [DAV_LIBRARIES, 'Nope'], 1)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('should 404 on an unknown file name', async () => {
      mocks.library.getAll.mockResolvedValue([{ id: libraryId, name: 'My Library' }] as never);
      webdavRepository.getAssetsByLibraryId.mockResolvedValue([assetRow] as never);
      await expect(sut.propfind(auth, [DAV_LIBRARIES, 'My Library', 'other.jpg'], 1)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('should 404 on too-deep paths', async () => {
      await expect(sut.propfind(auth, [DAV_LIBRARIES, 'a', 'b', 'c'], 1)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('getFile', () => {
    it('should reject collection paths with 405', async () => {
      await expect(sut.getFile(auth, [])).rejects.toBeInstanceOf(MethodNotAllowedException);
      await expect(sut.getFile(auth, [DAV_LIBRARIES])).rejects.toBeInstanceOf(MethodNotAllowedException);
      mocks.library.getAll.mockResolvedValue([{ id: libraryId, name: 'My Library' }] as never);
      await expect(sut.getFile(auth, [DAV_LIBRARIES, 'My Library'])).rejects.toBeInstanceOf(
        MethodNotAllowedException,
      );
    });

    it('should 404 on unknown roots', async () => {
      await expect(sut.getFile(auth, ['Secrets', 'x', 'f.jpg'])).rejects.toBeInstanceOf(NotFoundException);
    });

    it('should 404 on traversal', async () => {
      await expect(sut.getFile(auth, [DAV_LIBRARIES, '..', 'f.jpg'])).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('should return a file response for an accessible asset', async () => {
      mocks.library.getAll.mockResolvedValue([{ id: libraryId, name: 'My Library' }] as never);
      webdavRepository.getAssetsByLibraryId.mockResolvedValue([assetRow] as never);
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetId]));

      const file = await sut.getFile(auth, [DAV_LIBRARIES, 'My Library', 'IMG_0001.jpg']);
      expect(file).toBeInstanceOf(ImmichFileResponse);
      expect(file.path).toBe(assetRow.originalPath);
      expect(file.fileName).toBe('IMG_0001.jpg');
      expect(file.contentType).toBe('image/jpeg');
    });

    it('should return a file in a shared album the caller is a member of', async () => {
      mocks.album.getAll.mockResolvedValue([{ id: albumId, albumName: 'Shared' }] as never);
      webdavRepository.getAssetsByAlbumId.mockResolvedValue([assetRow] as never);
      mocks.access.asset.checkAlbumAccess.mockResolvedValue(new Set([assetId]));

      const file = await sut.getFile(auth, [DAV_ALBUMS, 'Shared', 'IMG_0001.jpg']);
      expect(file.path).toBe(assetRow.originalPath);
      expect(webdavRepository.getAssetsByAlbumId).toHaveBeenCalledWith(auth.user.id, albumId);
    });

    it('should 404 when access is denied', async () => {
      mocks.library.getAll.mockResolvedValue([{ id: libraryId, name: 'My Library' }] as never);
      webdavRepository.getAssetsByLibraryId.mockResolvedValue([assetRow] as never);
      // all access checks return empty sets by default (asset owned by another user)
      await expect(sut.getFile(auth, [DAV_LIBRARIES, 'My Library', 'IMG_0001.jpg'])).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('should 404 when the file name does not exist', async () => {
      mocks.library.getAll.mockResolvedValue([{ id: libraryId, name: 'My Library' }] as never);
      webdavRepository.getAssetsByLibraryId.mockResolvedValue([assetRow] as never);
      await expect(sut.getFile(auth, [DAV_LIBRARIES, 'My Library', 'missing.jpg'])).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
