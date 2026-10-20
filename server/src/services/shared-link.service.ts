import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PostgresError } from 'postgres';
import { SharedLink } from 'src/database.js';
import { AssetIdErrorReason, AssetIdsResponseDto } from 'src/dtos/asset-ids.response.dto.js';
import { AssetIdsDto } from 'src/dtos/asset.dto.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import {
  SharedLinkCreateDto,
  SharedLinkEditDto,
  SharedLinkFeedDto,
  SharedLinkLoginDto,
  SharedLinkResponseDto,
  SharedLinkSearchDto,
  mapSharedLink,
} from 'src/dtos/shared-link.dto.js';
import { AssetType, Permission, SharedLinkType } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { asDateTimeString } from 'src/utils/date.js';
import { FeedFormat, FeedItem, buildAtomFeed, buildRssFeed } from 'src/utils/feed.js';
import { OpenGraphTags, findOrFail, getExternalDomain } from 'src/utils/misc.js';

/** Maximum number of items included in a shared-link feed. */
export const SHARED_LINK_FEED_ITEM_LIMIT = 50;

@Injectable()
export class SharedLinkService extends BaseService {
  async getAll(auth: AuthDto, { id, albumId }: SharedLinkSearchDto): Promise<SharedLinkResponseDto[]> {
    return this.sharedLinkRepository
      .getAll({ userId: auth.user.id, id, albumId })

      .then((links) => links.map((link) => mapSharedLink(link, { auth })));
  }

  async login(auth: AuthDto, dto: SharedLinkLoginDto) {
    if (!auth.sharedLink) {
      throw new ForbiddenException();
    }

    const sharedLink = await this.findOrFail(auth.user.id, auth.sharedLink.id);
    const { id, password } = sharedLink;

    if (!password) {
      throw new BadRequestException('Shared link is not password protected');
    }

    if (password !== dto.password) {
      throw new UnauthorizedException('Invalid password');
    }

    return {
      sharedLink: await this.mapWithAlbumMetadata(sharedLink, { auth }),
      token: this.asToken({ id, password }),
    };
  }

  async getMine(auth: AuthDto, authTokens: string[]) {
    if (!auth.sharedLink) {
      throw new ForbiddenException();
    }

    const sharedLink = await this.findOrFail(auth.user.id, auth.sharedLink.id);
    const { id, password } = sharedLink;

    if (password && !authTokens.includes(this.asToken({ id, password }))) {
      throw new UnauthorizedException('Password required');
    }

    return this.mapWithAlbumMetadata(sharedLink, { auth });
  }

  async get(auth: AuthDto, id: string): Promise<SharedLinkResponseDto> {
    const sharedLink = await this.findOrFail(auth.user.id, id);
    return this.mapWithAlbumMetadata(sharedLink, { auth });
  }

  async create(auth: AuthDto, dto: SharedLinkCreateDto): Promise<SharedLinkResponseDto> {
    switch (dto.type) {
      case SharedLinkType.Album: {
        if (!dto.albumId) {
          throw new BadRequestException('Invalid albumId');
        }
        await this.requireAccess({ auth, permission: Permission.AlbumShare, ids: [dto.albumId] });
        break;
      }

      case SharedLinkType.Individual: {
        if (!dto.assetIds || dto.assetIds.length === 0) {
          throw new BadRequestException('Invalid assetIds');
        }

        await this.requireAccess({ auth, permission: Permission.AssetShare, ids: dto.assetIds });

        break;
      }
    }

    try {
      const sharedLink = await this.sharedLinkRepository.create({
        key: this.cryptoRepository.randomBytes(50),
        userId: auth.user.id,
        type: dto.type,
        albumId: dto.albumId || null,
        assetIds: dto.assetIds,
        description: dto.description || null,
        password: dto.password,
        expiresAt: dto.expiresAt || null,
        allowUpload: dto.allowUpload ?? true,
        allowDownload: dto.showMetadata !== false && (dto.allowDownload ?? true),
        showExif: dto.showMetadata ?? true,
        slug: dto.slug || null,
      });

      return mapSharedLink(sharedLink, { auth });
    } catch (error) {
      this.handleError(error);
    }
  }

  private handleError(error: unknown): never {
    if ((error as PostgresError).constraint_name === 'shared_link_slug_uq') {
      this.logger.debug('Shared link with this slug already exists');
      throw new BadRequestException('Failed to save shared link');
    }
    throw error;
  }

  async update(auth: AuthDto, id: string, dto: SharedLinkEditDto) {
    await this.findOrFail(auth.user.id, id);
    try {
      const sharedLink = await this.sharedLinkRepository.update({
        id,
        userId: auth.user.id,
        description: dto.description,
        password: dto.password,
        expiresAt: dto.expiresAt,
        allowUpload: dto.allowUpload,
        allowDownload: dto.allowDownload,
        showExif: dto.showMetadata,
        slug: dto.slug || null,
      });
      return mapSharedLink(sharedLink, { auth });
    } catch (error) {
      this.handleError(error);
    }
  }

  async remove(auth: AuthDto, id: string): Promise<void> {
    const sharedLink = await this.findOrFail(auth.user.id, id);
    await this.sharedLinkRepository.remove(sharedLink.id);
  }

  // TODO: replace `userId` with permissions and access control checks
  private findOrFail(userId: string, id: string) {
    return findOrFail(() => this.sharedLinkRepository.get(userId, id), 'Shared link');
  }

  async addAssets(auth: AuthDto, id: string, dto: AssetIdsDto): Promise<AssetIdsResponseDto[]> {
    const sharedLink = await this.findOrFail(auth.user.id, id);
    if (sharedLink.type !== SharedLinkType.Individual) {
      throw new BadRequestException('Invalid shared link type');
    }

    const existingAssetIds = new Set(sharedLink.assets.map((asset) => asset.id));
    const notPresentAssetIds = dto.assetIds.filter((assetId) => !existingAssetIds.has(assetId));
    const allowedAssetIds = await this.checkAccess({
      auth,
      permission: Permission.AssetShare,
      ids: notPresentAssetIds,
    });

    const results: AssetIdsResponseDto[] = [];
    for (const assetId of dto.assetIds) {
      const hasAsset = existingAssetIds.has(assetId);
      if (hasAsset) {
        results.push({ assetId, success: false, error: AssetIdErrorReason.DUPLICATE });
        continue;
      }

      const hasAccess = allowedAssetIds.has(assetId);
      if (!hasAccess) {
        results.push({ assetId, success: false, error: AssetIdErrorReason.NO_PERMISSION });
        continue;
      }

      results.push({ assetId, success: true });
    }

    await this.sharedLinkRepository.update({
      ...sharedLink,
      assetIds: results.filter(({ success }) => success).map(({ assetId }) => assetId),
    });

    return results;
  }

  async removeAssets(auth: AuthDto, id: string, dto: AssetIdsDto): Promise<AssetIdsResponseDto[]> {
    const sharedLink = await this.findOrFail(auth.user.id, id);

    if (sharedLink.type !== SharedLinkType.Individual) {
      throw new BadRequestException('Invalid shared link type');
    }

    const removedAssetIds = await this.sharedLinkAssetRepository.remove(id, dto.assetIds);

    const results: AssetIdsResponseDto[] = [];
    for (const assetId of dto.assetIds) {
      const wasRemoved = removedAssetIds.includes(assetId);
      if (!wasRemoved) {
        results.push({ assetId, success: false, error: AssetIdErrorReason.NOT_FOUND });
        continue;
      }

      results.push({ assetId, success: true });
      sharedLink.assets = sharedLink.assets.filter((asset) => asset.id !== assetId);
    }

    await this.sharedLinkRepository.update(sharedLink);

    return results;
  }

  /**
   * RSS/Atom feed for a shared link (FG-08). The share key in the path is the
   * credential — this route is public and the key is validated here. Feeds are
   * unavailable for password-protected links (RSS readers cannot complete the
   * cookie login), expired links, and unknown keys; all of these 404 to avoid
   * leaking link existence.
   */
  async getFeed(
    key: string,
    { format }: SharedLinkFeedDto,
    defaultDomain?: string,
  ): Promise<{ format: FeedFormat; xml: string }> {
    const keyBytes = Buffer.from(key, key.length === 100 ? 'hex' : 'base64url');
    const row = await this.sharedLinkRepository.getByKey(keyBytes);
    if (!row || (row.expiresAt && new Date(row.expiresAt) <= new Date()) || row.password) {
      throw new NotFoundException('Shared link feed not found');
    }

    const sharedLink = await this.sharedLinkRepository.get(row.userId, row.id);
    if (!sharedLink) {
      throw new NotFoundException('Shared link feed not found');
    }

    const { server } = await this.getConfig({ withCache: true });
    const domain = getExternalDomain(server, defaultDomain);
    const keyParam = sharedLink.key.toString('base64url');

    const items = await this.getFeedItems(sharedLink, domain, keyParam);

    const title = sharedLink.album ? sharedLink.album.albumName : sharedLink.description || 'Public Share';
    const link = sharedLink.slug ? `${domain}/s/${sharedLink.slug}` : `${domain}/share/${keyParam}`;

    const channel = {
      title,
      description: sharedLink.description || `${items.length} shared photos & videos`,
      link,
      selfLink: `${domain}/api/shared-links/${keyParam}/feed?format=${format}`,
      updatedAt: items[0]?.updatedAt ?? new Date(),
    };

    return { format, xml: format === 'rss' ? buildRssFeed(channel, items) : buildAtomFeed(channel, items) };
  }

  private async getFeedItems(sharedLink: SharedLink, domain: string, keyParam: string): Promise<FeedItem[]> {
    const toItem = (asset: {
      id: string;
      type: AssetType;
      originalFileName: string;
      fileCreatedAt: Date | string;
      updatedAt?: Date | string | null;
      createdAt?: Date | string;
      description?: string | null;
    }): FeedItem => {
      const thumbnailUrl = `${domain}/api/assets/${asset.id}/thumbnail?key=${keyParam}`;
      const description = sharedLink.showExif && asset.description ? asset.description : undefined;
      // `showExif=false` must strip originalFileName too (isMetadataHidden contract) — generic title
      const title = sharedLink.showExif
        ? asset.description || asset.originalFileName
        : asset.type === AssetType.Video
          ? 'Video'
          : 'Photo';

      return {
        id: asset.id,
        title,
        link: sharedLink.allowDownload ? `${domain}/api/assets/${asset.id}/original?key=${keyParam}` : thumbnailUrl,
        publishedAt: new Date(asset.fileCreatedAt),
        updatedAt: new Date(asset.updatedAt ?? asset.fileCreatedAt),
        description,
        enclosureUrl: thumbnailUrl,
        enclosureType: 'image/webp',
      };
    };

    if (sharedLink.type === SharedLinkType.Album && sharedLink.albumId) {
      const assets = await this.sharedLinkRepository.getFeedAssets(sharedLink.albumId, SHARED_LINK_FEED_ITEM_LIMIT);
      return assets.map((asset) => toItem(asset));
    }

    // individual links: assets come back ordered by fileCreatedAt asc — take the newest N
    return sharedLink.assets
      .slice(-SHARED_LINK_FEED_ITEM_LIMIT)
      .toReversed()
      .map((asset) => toItem({ ...asset, description: asset.exifInfo?.description }));
  }

  async getMetadataTags(auth: AuthDto, defaultDomain?: string): Promise<null | OpenGraphTags> {
    if (!auth.sharedLink || auth.sharedLink.password) {
      return null;
    }

    const config = await this.getConfig({ withCache: true });
    const sharedLink = await this.findOrFail(auth.sharedLink.userId, auth.sharedLink.id);
    const assetId = sharedLink.album?.albumThumbnailAssetId || sharedLink.assets[0]?.id;
    const [albumMetadata] = sharedLink.album ? await this.albumRepository.getMetadataForIds([sharedLink.album.id]) : [];
    const assetCount = sharedLink.assets.length > 0 ? sharedLink.assets.length : albumMetadata?.assetCount || 0;
    const imagePath = assetId
      ? `/api/assets/${assetId}/thumbnail?key=${sharedLink.key.toString('base64url')}`
      : '/feature-panel.png';

    return {
      title: sharedLink.album ? sharedLink.album.albumName : 'Public Share',
      description: sharedLink.description || `${assetCount} shared photos & videos`,
      imageUrl: new URL(imagePath, getExternalDomain(config.server, defaultDomain)).href,
    };
  }

  private async mapWithAlbumMetadata(sharedLink: SharedLink, { auth }: { auth: AuthDto }) {
    const response = mapSharedLink(sharedLink, { auth });
    if (response.album) {
      const [metadata] = await this.albumRepository.getMetadataForIds([response.album.id]);
      response.album.startDate = asDateTimeString(metadata?.startDate ?? undefined);
      response.album.endDate = asDateTimeString(metadata?.endDate ?? undefined);
      response.album.assetCount = metadata?.assetCount ?? 0;
    }

    return response;
  }

  private asToken(sharedLink: { id: string; password: string }) {
    return this.cryptoRepository.hashSha256(`${sharedLink.id}-${sharedLink.password}`).toString('base64');
  }
}
