import { BadRequestException, Inject, Injectable, MethodNotAllowedException, NotFoundException } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { CacheControl, Permission } from 'src/enum.js';
import { WebDavRepository } from 'src/repositories/webdav.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { ImmichFileResponse } from 'src/utils/file.js';
import { mimeTypes } from 'src/utils/mime-types.js';
import { DavDepth, DavResource, assignDavNames } from 'src/utils/webdav.js';

export const DAV_LIBRARIES = 'Libraries';
export const DAV_ALBUMS = 'Albums';
const DAV_ROOTS = [DAV_LIBRARIES, DAV_ALBUMS] as const;
type DavRoot = (typeof DAV_ROOTS)[number];

const isDavRoot = (segment: string | undefined): segment is DavRoot =>
  (DAV_ROOTS as readonly string[]).includes(segment ?? '');

type MaybeDate = Date | string | number | null | undefined;
type DatedItem = { createdAt?: MaybeDate; updatedAt?: MaybeDate };
type DavCollectionEntry<T extends DatedItem = DatedItem> = { id: string; name: string; item: T };

type DavAssetRow = Awaited<ReturnType<WebDavRepository['getAssetsByLibraryId']>>[number];

const asDate = (value: MaybeDate): Date | undefined => (value ? new Date(value) : undefined);

/**
 * Read-only WebDAV tree (FG-09):
 *
 *   /                     -> root collection
 *   /Libraries            -> all libraries (library names are already visible
 *                            to every authenticated user via GET /libraries)
 *   /Libraries/<name>     -> assets in that library owned by the caller
 *   /Albums               -> albums the caller owns or is a member of
 *   /Albums/<name>        -> assets in that album
 *   /<root>/<dir>/<file>  -> the asset's original file (GET/HEAD)
 *
 * Extends BaseService per upstream convention. The dedicated WebDavRepository
 * cannot ride the BaseService constructor (56 positional deps shared with
 * test/newTestService), so it is property-injected — standard NestJS
 * property-based injection.
 */
@Injectable()
export class WebDavService extends BaseService {
  @Inject(WebDavRepository)
  private readonly webdavRepository!: WebDavRepository;

  /**
   * Resolve a DAV path into resources for a PROPFIND response.
   * The returned array always contains the requested resource first,
   * followed by its children when `depth` is 1.
   */
  async propfind(auth: AuthDto, segments: string[], depth: DavDepth): Promise<DavResource[]> {
    this.assertSafeSegments(segments);
    const [rootName, collectionName, fileName] = segments;

    if (segments.length === 0) {
      const resources: DavResource[] = [this.collectionResource([], 'webdav')];
      if (depth === 1) {
        for (const root of DAV_ROOTS) {
          resources.push(this.collectionResource([root], root));
        }
      }
      return resources;
    }

    if (segments.length > 3 || !isDavRoot(rootName)) {
      throw new NotFoundException();
    }

    if (segments.length === 1) {
      const resources: DavResource[] = [this.collectionResource([rootName], rootName)];
      if (depth === 1) {
        for (const { name, item } of await this.listCollections(auth, rootName)) {
          resources.push(this.collectionResource([rootName, name], name, item));
        }
      }
      return resources;
    }

    const collections = await this.listCollections(auth, rootName);

    const collection = collections.find(({ name }) => name === collectionName);
    if (!collection) {
      throw new NotFoundException();
    }

    if (segments.length === 2) {
      const resources: DavResource[] = [
        this.collectionResource([rootName, collection.name], collection.name, collection.item),
      ];
      if (depth === 1) {
        resources.push(...(await this.listAssets(auth, rootName, collection)));
      }
      return resources;
    }

    const assets = await this.listAssets(auth, rootName, collection);
    const match = assets.find(({ name }) => name === fileName);
    if (!match) {
      throw new NotFoundException();
    }
    return [match];
  }

  /**
   * Resolve a DAV path to a streamable file for GET/HEAD.
   * Throws NotFoundException for missing/other-user resources and
   * MethodNotAllowedException for collections.
   */
  async getFile(auth: AuthDto, segments: string[]): Promise<ImmichFileResponse> {
    this.assertSafeSegments(segments);
    const [rootName, collectionName, fileName] = segments;

    if (segments.length === 0 || (segments.length < 3 && isDavRoot(rootName))) {
      // a valid collection path — not a file
      throw new MethodNotAllowedException('Cannot GET a WebDAV collection');
    }
    if (segments.length !== 3 || !isDavRoot(rootName)) {
      throw new NotFoundException();
    }

    const collection = await this.findCollection(auth, rootName, collectionName!);
    if (!collection) {
      throw new NotFoundException();
    }

    const assets = await this.listAssets(auth, rootName, collection);
    const match = assets.find(({ name }) => name === fileName);
    if (!match?.id || !match.path) {
      throw new NotFoundException();
    }

    // defense in depth: the listing queries are already auth-scoped, but
    // download permission is verified against the access layer as well.
    const allowed = await this.checkAccess({ auth, permission: Permission.AssetDownload, ids: [match.id] });
    if (!allowed.has(match.id)) {
      throw new NotFoundException();
    }

    return new ImmichFileResponse({
      path: match.path,
      fileName: match.name,
      contentType: match.mimeType ?? 'application/octet-stream',
      cacheControl: CacheControl.PrivateWithCache,
    });
  }

  private assertSafeSegments(segments: string[]) {
    if (segments.some((segment) => segment === '..' || segment.includes('\u{0}'))) {
      throw new BadRequestException('Invalid path');
    }
  }

  private collectionResource(segments: string[], name: string, item?: DatedItem): DavResource {
    return {
      segments,
      name,
      isCollection: true,
      createdAt: asDate(item?.createdAt),
      modifiedAt: asDate(item?.updatedAt ?? item?.createdAt),
    };
  }

  private async findCollection(auth: AuthDto, root: DavRoot, name: string): Promise<DavCollectionEntry | undefined> {
    const collections = await this.listCollections(auth, root);
    return collections.find((entry) => entry.name === name);
  }

  /**
   * Display-name-assigned collections for a DAV root.
   * - Libraries: only the caller's own libraries (GET /libraries is admin-only upstream;
   *   library names can leak mount paths/usernames, so they stay owner-scoped here);
   *   assets inside remain owner-scoped.
   * - Albums: albums where the caller is a member (owned or shared) — same
   *   scope as `albumRepository.getAll(ownerId)`.
   */
  private async listCollections(auth: AuthDto, root: DavRoot): Promise<DavCollectionEntry[]> {
    let raw: { id: string; name: string; item: DatedItem }[];
    if (root === DAV_LIBRARIES) {
      const libraries = await this.libraryRepository.getAll();
      raw = libraries
        .filter((library) => library.ownerId === auth.user.id)
        .map((library) => ({ id: library.id, name: library.name, item: library }));
    } else {
      const albums = await this.albumRepository.getAll(auth.user.id);
      raw = albums.map((album) => ({ id: album.id, name: album.albumName, item: album }));
    }

    return assignDavNames(raw).map(({ item, name }) => ({ id: item.id, name, item: item.item }));
  }

  private async listAssets(auth: AuthDto, root: DavRoot, collection: DavCollectionEntry): Promise<DavResource[]> {
    const assets =
      root === DAV_LIBRARIES
        ? await this.webdavRepository.getAssetsByLibraryId(auth.user.id, collection.id)
        : await this.webdavRepository.getAssetsByAlbumId(auth.user.id, collection.id);

    return assignDavNames(assets.map((asset) => ({ id: asset.id, name: asset.fileName, asset }))).map(
      ({ item, name }) => this.assetResource(item.asset, root, collection.name, name),
    );
  }

  private assetResource(asset: DavAssetRow, root: DavRoot, collectionName: string, name: string): DavResource {
    return {
      id: asset.id,
      path: asset.originalPath,
      segments: [root, collectionName, name],
      name,
      isCollection: false,
      size: asset.fileSize === null || asset.fileSize === undefined ? undefined : Number(asset.fileSize),
      mimeType: mimeTypes.lookup(asset.originalPath),
      etag: asset.checksum?.toString('hex'),
      createdAt: asDate(asset.fileCreatedAt),
      modifiedAt: asDate(asset.fileModifiedAt),
    };
  }
}
