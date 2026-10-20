import { BadRequestException, ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { AssetIdErrorReason } from 'src/dtos/asset-ids.response.dto.js';
import { mapSharedLink } from 'src/dtos/shared-link.dto.js';
import { SharedLinkType } from 'src/enum.js';
import { SharedLinkService } from 'src/services/shared-link.service.js';
import { AlbumFactory } from 'test/factories/album.factory.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { SharedLinkFactory } from 'test/factories/shared-link.factory.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { sharedLinkStub } from 'test/fixtures/shared-link.stub.js';
import { getForSharedLink } from 'test/mappers.js';
import { factory } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const authRow = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'link-1',
    userId: 'user-1',
    albumId: null,
    expiresAt: null,
    password: null,
    showExif: true,
    allowUpload: true,
    allowDownload: true,
    user: { id: 'user-1' },
    ...overrides,
  }) as never;

describe(SharedLinkService.name, () => {
  let sut: SharedLinkService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(SharedLinkService));
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  const feedCall = (key = 'link-key', format = 'atom') =>
    sut.getFeed(key, { format } as never, 'https://homeroll.test');

  describe('getAll', () => {
    it('should return all shared links for a user', async () => {
      const [sharedLink1, sharedLink2] = [SharedLinkFactory.create(), SharedLinkFactory.create()];
      mocks.sharedLink.getAll.mockResolvedValue([getForSharedLink(sharedLink1), getForSharedLink(sharedLink2)]);
      await expect(sut.getAll(authStub.user1, {})).resolves.toEqual(
        [getForSharedLink(sharedLink1), getForSharedLink(sharedLink2)].map((link) =>
          mapSharedLink(link, { auth: authStub.user1 }),
        ),
      );
      expect(mocks.sharedLink.getAll).toHaveBeenCalledWith({ userId: authStub.user1.user.id });
    });
  });

  describe('getMine', () => {
    it('should only work for a public user', async () => {
      await expect(sut.getMine(authStub.admin, [])).rejects.toBeInstanceOf(ForbiddenException);
      expect(mocks.sharedLink.get).not.toHaveBeenCalled();
    });

    it('should return the shared link for the public user', async () => {
      const authDto = authStub.adminSharedLink;
      const sharedLink = SharedLinkFactory.create();
      mocks.sharedLink.get.mockResolvedValue(getForSharedLink(sharedLink));
      await expect(sut.getMine(authDto, [])).resolves.toEqual(
        mapSharedLink(getForSharedLink(sharedLink), { auth: authDto }),
      );
      expect(mocks.sharedLink.get).toHaveBeenCalledWith(authDto.user.id, authDto.sharedLink?.id);
    });

    it('should not return metadata', async () => {
      const authDto = factory.auth({
        sharedLink: {
          showExif: false,
          allowDownload: true,
          allowUpload: true,
        },
      });
      mocks.sharedLink.get.mockResolvedValue(
        getForSharedLink(
          SharedLinkFactory.from({ showExif: false })
            .asset({}, (builder) => builder.exif())
            .build(),
        ),
      );
      const response = await sut.getMine(authDto, []);
      expect(response.assets[0]).toMatchObject({ hasMetadata: false });
      expect(mocks.sharedLink.get).toHaveBeenCalledWith(authDto.user.id, authDto.sharedLink?.id);
    });

    it('should throw an error for a request without a shared link auth token', async () => {
      const authDto = authStub.adminSharedLink;
      mocks.sharedLink.get.mockResolvedValue(sharedLinkStub.passwordRequired);
      await expect(sut.getMine(authDto, [])).rejects.toBeInstanceOf(UnauthorizedException);
      expect(mocks.sharedLink.get).toHaveBeenCalledWith(authDto.user.id, authDto.sharedLink?.id);
    });

    it('should accept a valid shared link auth token', async () => {
      const sharedLink = SharedLinkFactory.create({ password: '123' });
      mocks.sharedLink.get.mockResolvedValue(getForSharedLink(sharedLink));
      const secret = Buffer.from('auth-token-123');
      mocks.crypto.hashSha256.mockReturnValue(secret);
      await expect(sut.getMine(authStub.adminSharedLink, [secret.toString('base64')])).resolves.toBeDefined();
      expect(mocks.sharedLink.get).toHaveBeenCalledWith(
        authStub.adminSharedLink.user.id,
        authStub.adminSharedLink.sharedLink?.id,
      );
    });
  });

  describe('get', () => {
    it('should throw an error for an invalid shared link', async () => {
      mocks.sharedLink.get.mockResolvedValue(void 0);

      await expect(sut.get(authStub.user1, 'missing-id')).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.sharedLink.get).toHaveBeenCalledWith(authStub.user1.user.id, 'missing-id');
      expect(mocks.sharedLink.update).not.toHaveBeenCalled();
    });

    it('should get a shared link by id', async () => {
      const sharedLink = SharedLinkFactory.create();
      mocks.sharedLink.get.mockResolvedValue(getForSharedLink(sharedLink));
      await expect(sut.get(authStub.user1, sharedLink.id)).resolves.toEqual(
        mapSharedLink(getForSharedLink(sharedLink), { auth: authStub.user1 }),
      );
      expect(mocks.sharedLink.get).toHaveBeenCalledWith(authStub.user1.user.id, sharedLink.id);
    });
  });

  describe('create', () => {
    it('should not allow an album shared link without an albumId', async () => {
      await expect(sut.create(authStub.admin, { type: SharedLinkType.Album, assetIds: [] })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('should not allow non-owners to create album shared links', async () => {
      await expect(
        sut.create(authStub.admin, { type: SharedLinkType.Album, assetIds: [], albumId: 'album-1' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should not allow individual shared links with no assets', async () => {
      await expect(
        sut.create(authStub.admin, { type: SharedLinkType.Individual, assetIds: [] }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should require asset ownership to make an individual shared link', async () => {
      await expect(
        sut.create(authStub.admin, { type: SharedLinkType.Individual, assetIds: ['asset-1'] }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should create an album shared link', async () => {
      const album = AlbumFactory.from().asset().build();
      const sharedLink = SharedLinkFactory.from().album(album).build();
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.sharedLink.create.mockResolvedValue(getForSharedLink(sharedLink));

      await sut.create(authStub.admin, { type: SharedLinkType.Album, albumId: album.id });

      expect(mocks.access.album.checkOwnerAccess).toHaveBeenCalledWith(authStub.admin.user.id, new Set([album.id]));
      expect(mocks.sharedLink.create).toHaveBeenCalledWith({
        type: SharedLinkType.Album,
        userId: authStub.admin.user.id,
        albumId: album.id,
        allowDownload: true,
        allowUpload: true,
        description: null,
        expiresAt: null,
        slug: null,
        showExif: true,
        key: Buffer.from('random-bytes', 'utf8'),
      });
    });

    it('should create an individual shared link', async () => {
      const asset = AssetFactory.create();
      const sharedLink = SharedLinkFactory.from()
        .asset(asset, (builder) => builder.exif())
        .build();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.sharedLink.create.mockResolvedValue(getForSharedLink(sharedLink));

      await sut.create(authStub.admin, {
        type: SharedLinkType.Individual,
        assetIds: [asset.id],
        showMetadata: true,
        allowDownload: true,
        allowUpload: true,
      });

      expect(mocks.access.asset.checkOwnerAccess).toHaveBeenCalledWith(
        authStub.admin.user.id,
        new Set([asset.id]),
        false,
      );
      expect(mocks.sharedLink.create).toHaveBeenCalledWith({
        type: SharedLinkType.Individual,
        userId: authStub.admin.user.id,
        albumId: null,
        allowDownload: true,
        slug: null,
        allowUpload: true,
        assetIds: [asset.id],
        description: null,
        expiresAt: null,
        showExif: true,
        key: Buffer.from('random-bytes', 'utf8'),
      });
    });

    it('should create a shared link with allowDownload set to false when showMetadata is false', async () => {
      const asset = AssetFactory.create();
      const sharedLink = SharedLinkFactory.from({ allowDownload: false })
        .asset(asset, (builder) => builder.exif())
        .build();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.sharedLink.create.mockResolvedValue(getForSharedLink(sharedLink));

      await sut.create(authStub.admin, {
        type: SharedLinkType.Individual,
        assetIds: [asset.id],
        showMetadata: false,
        allowDownload: true,
        allowUpload: true,
      });

      expect(mocks.access.asset.checkOwnerAccess).toHaveBeenCalledWith(
        authStub.admin.user.id,
        new Set([asset.id]),
        false,
      );
      expect(mocks.sharedLink.create).toHaveBeenCalledWith({
        type: SharedLinkType.Individual,
        userId: authStub.admin.user.id,
        albumId: null,
        allowDownload: false,
        allowUpload: true,
        assetIds: [asset.id],
        description: null,
        expiresAt: null,
        showExif: false,
        slug: null,
        key: Buffer.from('random-bytes', 'utf8'),
      });
    });
  });

  describe('update', () => {
    it('should throw an error for an invalid shared link', async () => {
      mocks.sharedLink.get.mockResolvedValue(void 0);

      await expect(sut.update(authStub.user1, 'missing-id', {})).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.sharedLink.get).toHaveBeenCalledWith(authStub.user1.user.id, 'missing-id');
      expect(mocks.sharedLink.update).not.toHaveBeenCalled();
    });

    it('should update a shared link', async () => {
      const sharedLink = SharedLinkFactory.create();
      mocks.sharedLink.get.mockResolvedValue(getForSharedLink(sharedLink));
      mocks.sharedLink.update.mockResolvedValue(getForSharedLink(sharedLink));

      await sut.update(authStub.user1, sharedLinkStub.valid.id, { allowDownload: false });

      expect(mocks.sharedLink.get).toHaveBeenCalledWith(authStub.user1.user.id, sharedLinkStub.valid.id);
      expect(mocks.sharedLink.update).toHaveBeenCalledWith({
        id: sharedLinkStub.valid.id,
        slug: null,
        userId: authStub.user1.user.id,
        allowDownload: false,
      });
    });
  });

  describe('remove', () => {
    it('should throw an error for an invalid shared link', async () => {
      mocks.sharedLink.get.mockResolvedValue(void 0);

      await expect(sut.remove(authStub.user1, 'missing-id')).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.sharedLink.get).toHaveBeenCalledWith(authStub.user1.user.id, 'missing-id');
      expect(mocks.sharedLink.update).not.toHaveBeenCalled();
    });

    it('should remove a key', async () => {
      const sharedLink = SharedLinkFactory.create();
      mocks.sharedLink.get.mockResolvedValue(getForSharedLink(sharedLink));
      mocks.sharedLink.remove.mockResolvedValue();

      await sut.remove(authStub.user1, sharedLink.id);

      expect(mocks.sharedLink.get).toHaveBeenCalledWith(authStub.user1.user.id, sharedLink.id);
      expect(mocks.sharedLink.remove).toHaveBeenCalledWith(sharedLink.id);
    });
  });

  describe('addAssets', () => {
    it('should not work on album shared links', async () => {
      const sharedLink = SharedLinkFactory.from().album().build();
      mocks.sharedLink.get.mockResolvedValue(getForSharedLink(sharedLink));

      await expect(sut.addAssets(authStub.admin, 'link-1', { assetIds: ['asset-1'] })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('should add assets to a shared link', async () => {
      const asset = AssetFactory.create();
      const sharedLink = SharedLinkFactory.from()
        .asset(asset, (builder) => builder.exif())
        .build();
      const newAsset = AssetFactory.create();
      mocks.sharedLink.get.mockResolvedValue(getForSharedLink(sharedLink));
      mocks.sharedLink.create.mockResolvedValue(getForSharedLink(sharedLink));
      mocks.sharedLink.update.mockResolvedValue(getForSharedLink(sharedLink));
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([newAsset.id]));

      await expect(
        sut.addAssets(authStub.admin, sharedLink.id, { assetIds: [asset.id, 'asset-2', newAsset.id] }),
      ).resolves.toEqual([
        { assetId: asset.id, success: false, error: AssetIdErrorReason.DUPLICATE },
        { assetId: 'asset-2', success: false, error: AssetIdErrorReason.NO_PERMISSION },
        { assetId: newAsset.id, success: true },
      ]);

      expect(mocks.access.asset.checkOwnerAccess).toHaveBeenCalledTimes(1);
      expect(mocks.sharedLink.update).toHaveBeenCalled();
      expect(mocks.sharedLink.update).toHaveBeenCalledWith({
        ...getForSharedLink(sharedLink),
        slug: null,
        assetIds: [newAsset.id],
      });
    });
  });

  describe('removeAssets', () => {
    it('should not work on album shared links', async () => {
      const sharedLink = SharedLinkFactory.from().album().build();
      mocks.sharedLink.get.mockResolvedValue(getForSharedLink(sharedLink));

      await expect(sut.removeAssets(authStub.admin, sharedLink.id, { assetIds: ['asset-1'] })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('should remove assets from a shared link', async () => {
      const asset = AssetFactory.create();
      const sharedLink = SharedLinkFactory.from()
        .asset(asset, (builder) => builder.exif())
        .build();
      mocks.sharedLink.get.mockResolvedValue(getForSharedLink(sharedLink));
      mocks.sharedLink.create.mockResolvedValue(getForSharedLink(sharedLink));
      mocks.sharedLink.update.mockResolvedValue(getForSharedLink(sharedLink));
      mocks.sharedLinkAsset.remove.mockResolvedValue([asset.id]);

      await expect(
        sut.removeAssets(authStub.admin, sharedLink.id, { assetIds: [asset.id, 'asset-2'] }),
      ).resolves.toEqual([
        { assetId: asset.id, success: true },
        { assetId: 'asset-2', success: false, error: AssetIdErrorReason.NOT_FOUND },
      ]);

      expect(mocks.sharedLinkAsset.remove).toHaveBeenCalledWith(sharedLink.id, [asset.id, 'asset-2']);
      expect(mocks.sharedLink.update).toHaveBeenCalledWith(expect.objectContaining({ assets: [] }));
    });
  });

  describe('getMetadataTags', () => {
    it('should return null when auth is not a shared link', async () => {
      await expect(sut.getMetadataTags(authStub.admin)).resolves.toBe(null);

      expect(mocks.sharedLink.get).not.toHaveBeenCalled();
    });

    it('should return null when shared link has a password', async () => {
      const auth = factory.auth({ user: {}, sharedLink: { password: 'password' } });

      await expect(sut.getMetadataTags(auth)).resolves.toBe(null);

      expect(mocks.sharedLink.get).not.toHaveBeenCalled();
    });

    it('should return metadata tags', async () => {
      const sharedLink = SharedLinkFactory.from({ description: null })
        .asset({}, (builder) => builder.exif())
        .build();
      mocks.sharedLink.get.mockResolvedValue(getForSharedLink(sharedLink));

      await expect(sut.getMetadataTags(authStub.adminSharedLink)).resolves.toEqual({
        description: '1 shared photos & videos',
        imageUrl: `http://localhost:2283/api/assets/${sharedLink.assets[0].id}/thumbnail?key=${sharedLink.key.toString('base64url')}`,
        title: 'Public Share',
      });

      expect(mocks.sharedLink.get).toHaveBeenCalled();
    });

    it('should return metadata tags with a default image path if the asset id is not set', async () => {
      mocks.sharedLink.get.mockResolvedValue({ ...sharedLinkStub.individual, album: null, assets: [] });
      await expect(sut.getMetadataTags(authStub.adminSharedLink)).resolves.toEqual({
        description: '0 shared photos & videos',
        imageUrl: `http://localhost:2283/feature-panel.png`,
        title: 'Public Share',
      });

      expect(mocks.sharedLink.get).toHaveBeenCalled();
    });
  });

  describe('getFeed', () => {
    it('404s when the key is unknown', async () => {
      mocks.sharedLink.getByKey.mockResolvedValue(undefined);

      await expect(feedCall()).rejects.toThrow(NotFoundException);
      expect(mocks.sharedLink.get).not.toHaveBeenCalled();
    });

    it('404s when the link is expired', async () => {
      mocks.sharedLink.getByKey.mockResolvedValue(authRow({ expiresAt: new Date('2000-01-01') }));

      await expect(feedCall()).rejects.toThrow(NotFoundException);
    });

    it('404s when the link is password-protected', async () => {
      mocks.sharedLink.getByKey.mockResolvedValue(authRow({ password: 'password' }));

      await expect(feedCall()).rejects.toThrow(NotFoundException);
    });

    it('builds an atom feed for an individual shared link', async () => {
      const sharedLink = SharedLinkFactory.from({ description: null })
        .asset({}, (builder) => builder.exif())
        .build();
      mocks.sharedLink.getByKey.mockResolvedValue(authRow());
      mocks.sharedLink.get.mockResolvedValue(getForSharedLink(sharedLink) as never);

      const { format, xml } = await feedCall(sharedLink.key.toString('base64url'));

      const keyParam = sharedLink.key.toString('base64url');
      expect(format).toBe('atom');
      expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
      expect(xml).toContain('<title>Public Share</title>');
      expect(xml).toContain(`<link href="https://homeroll.test/share/${keyParam}" />`);
      expect(xml).toContain(`https://homeroll.test/api/shared-links/${keyParam}/feed?format=atom`);
      expect(xml).toContain(`https://homeroll.test/api/assets/${sharedLink.assets[0].id}/original?key=${keyParam}`);
      expect(xml).toContain('rel="enclosure"');
    });

    it('honors showMetadata/allowDownload flags', async () => {
      const asset = AssetFactory.from({ originalFileName: 'IMG_0001.jpg' }).exif().build();
      const sharedLink = {
        ...getForSharedLink(SharedLinkFactory.from({ showExif: false, allowDownload: false }).asset().build()),
        showExif: false,
        allowDownload: false,
        assets: [{ ...asset, exifInfo: { description: 'secret location' } }],
      };
      mocks.sharedLink.getByKey.mockResolvedValue(authRow({ showExif: false, allowDownload: false }));
      mocks.sharedLink.get.mockResolvedValue(sharedLink as never);

      const keyParam = sharedLink.key.toString('base64url');
      const { xml } = await feedCall(keyParam);

      // exif text stripped: title and file name are metadata and must not leak
      expect(xml).toContain('<title>Photo</title>');
      expect(xml).not.toContain('IMG_0001.jpg');
      expect(xml).not.toContain('secret location');
      // no download links when allowDownload is off
      expect(xml).not.toContain('/original?key=');
      expect(xml).toContain(`/thumbnail?key=${keyParam}`);
    });

    it('builds an rss feed for an album shared link', async () => {
      const album = AlbumFactory.from({ albumName: 'Vacation' }).build();
      const sharedLink = getForSharedLink(SharedLinkFactory.from({ type: SharedLinkType.Album }).album().build());
      mocks.sharedLink.getByKey.mockResolvedValue(authRow({ albumId: album.id }));
      mocks.sharedLink.get.mockResolvedValue({ ...sharedLink, album } as never);
      mocks.sharedLink.getFeedAssets.mockResolvedValue([
        {
          id: 'asset-1',
          originalFileName: 'IMG_0001.jpg',
          fileCreatedAt: new Date('2024-05-01T10:00:00Z'),
          createdAt: new Date('2024-05-01T10:00:00Z'),
          updatedAt: new Date('2024-05-01T10:00:00Z'),
          type: 'IMAGE',
          description: 'A sunny beach',
        },
      ] as never);

      const { format, xml } = await feedCall('link-key', 'rss');

      expect(format).toBe('rss');
      expect(xml).toContain('<rss version="2.0"');
      expect(xml).toContain('<title>Vacation</title>');
      expect(xml).toContain('<title>A sunny beach</title>');
      expect(xml).toContain('<pubDate>Wed, 01 May 2024 10:00:00 GMT</pubDate>');
      expect(mocks.sharedLink.getFeedAssets).toHaveBeenCalled();
    });

    it('builds an empty feed for a link without assets', async () => {
      const sharedLink = getForSharedLink(SharedLinkFactory.create());
      mocks.sharedLink.getByKey.mockResolvedValue(authRow());
      mocks.sharedLink.get.mockResolvedValue({ ...sharedLink, assets: [] } as never);

      const { xml } = await feedCall();
      expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
      expect(xml).not.toContain('<entry>');
    });
  });
});
