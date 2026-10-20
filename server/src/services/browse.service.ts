import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { LRUMap } from 'mnemonist';
import { mapAsset } from 'src/dtos/asset-response.dto.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { BrowseLabelAssetsDto, BrowseLabelAssetsResponseDto, BrowseLabelResponseDto } from 'src/dtos/browse.dto.js';
import { BrowseRepository } from 'src/repositories/browse.repository.js';
import { AssetSearchScope } from 'src/repositories/search.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { getMyPartnerIds } from 'src/utils/asset.util.js';
import { BROWSE_LABELS, BrowseLabel, getBrowseLabel } from 'src/utils/browse-labels.js';
import { isSmartSearchEnabled } from 'src/utils/misc.js';
import { decodeSearchCursor, encodeSearchCursor } from 'src/utils/search-cursor.js';

/**
 * Cosine-distance cutoff for label membership. CLIP text/image distances for
 * relevant matches typically sit in the 0.5-0.8 band; 0.7 balances recall and
 * precision and is deliberately a named constant for tuning.
 */
const BROWSE_LABEL_MAX_DISTANCE = 0.7;
/**
 * How long per-user label stats are cached. Computing them costs ~60 encode
 * + count round-trips, so results are memoized per user for six hours.
 */
const LABEL_STATS_TTL_MS = 6 * 60 * 60 * 1000;
/** Label embeddings are identical for every user (model + prompt) — cache them all. */
const EMBEDDING_CACHE_SIZE = 2 * BROWSE_LABELS.length;
const LABEL_CACHE_SIZE = 1000;

type LabelCacheEntry = { expiresAt: number; items: BrowseLabelResponseDto[] };

/**
 * Browsable PhotoPrism-style category taxonomy (FG-16): a curated set of CLIP
 * label prompts is encoded once and matched against `smart_search` embeddings.
 * Per-user results are cached in-process (LRU + TTL) — same pattern as the
 * search service embedding cache — since no shared cache repository exists.
 */
@Injectable()
export class BrowseService extends BaseService {
  @Inject(BrowseRepository)
  private readonly browseRepository!: BrowseRepository;

  private embeddingCache = new LRUMap<string, string>(EMBEDDING_CACHE_SIZE);
  private labelCache = new LRUMap<string, LabelCacheEntry>(LABEL_CACHE_SIZE);

  async getLabels(auth: AuthDto): Promise<BrowseLabelResponseDto[]> {
    const machineLearning = await this.getMachineLearningConfig();

    const cached = this.labelCache.get(auth.user.id);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.items;
    }

    const userIds = await this.getUserIdsToSearch(auth);
    const scope: AssetSearchScope = { userIds, lockedOwnerId: auth.user.id, viewingUserId: auth.user.id };

    const embeddings = await this.encodeLabelPrompts(machineLearning.clip.modelName);
    const items = await Promise.all(
      BROWSE_LABELS.map(async (label, index) => {
        const { count, previewAssetId } = await this.browseRepository.countLabelMatches(
          { embedding: embeddings[index], maxDistance: BROWSE_LABEL_MAX_DISTANCE },
          scope,
        );
        return { key: label.key, label: label.label, count, previewAssetId };
      }),
    );

    this.labelCache.set(auth.user.id, { expiresAt: Date.now() + LABEL_STATS_TTL_MS, items });
    return items;
  }

  async getLabelAssets(auth: AuthDto, key: string, dto: BrowseLabelAssetsDto): Promise<BrowseLabelAssetsResponseDto> {
    const label = getBrowseLabel(key);
    if (!label) {
      throw new NotFoundException(`Unknown browse label '${key}'`);
    }

    const machineLearning = await this.getMachineLearningConfig();
    const { offset } = decodeSearchCursor(dto.cursor);
    const embedding = await this.encodeLabelPrompt(machineLearning.clip.modelName, label);
    const userIds = await this.getUserIdsToSearch(auth);

    const { items, hasNextPage } = await this.browseRepository.searchLabelAssets(
      { take: dto.size, skip: offset },
      { embedding, maxDistance: BROWSE_LABEL_MAX_DISTANCE },
      { userIds, lockedOwnerId: auth.user.id, viewingUserId: auth.user.id },
    );

    return {
      count: items.length,
      items: items.map((asset) => mapAsset(asset, { auth })),
      nextCursor: hasNextPage ? encodeSearchCursor(offset + dto.size) : null,
    };
  }

  private async getMachineLearningConfig() {
    const { machineLearning } = await this.getConfig({ withCache: false });
    if (!isSmartSearchEnabled(machineLearning)) {
      throw new BadRequestException('Smart search is not enabled');
    }
    return machineLearning;
  }

  /** Sequential on purpose: ~60 parallel inference requests would bury the ML service. */
  private async encodeLabelPrompts(modelName: string): Promise<string[]> {
    const embeddings: string[] = [];
    for (const label of BROWSE_LABELS) {
      embeddings.push(await this.encodeLabelPrompt(modelName, label));
    }
    return embeddings;
  }

  private async encodeLabelPrompt(modelName: string, label: BrowseLabel): Promise<string> {
    const cacheKey = `${modelName}:${label.prompt}`;
    let embedding = this.embeddingCache.get(cacheKey);
    if (embedding) {
      return embedding;
    }

    try {
      embedding = await this.machineLearningRepository.encodeText(label.prompt, { modelName });
    } catch (error) {
      this.logger.warn(`Failed to encode browse label '${label.key}': ${error}`);
      throw new ServiceUnavailableException('Machine learning service is unavailable');
    }

    this.embeddingCache.set(cacheKey, embedding);
    return embedding;
  }

  private async getUserIdsToSearch(auth: AuthDto): Promise<string[]> {
    const partnerIds = await getMyPartnerIds({
      userId: auth.user.id,
      repository: this.partnerRepository,
      timelineEnabled: true,
    });
    return [auth.user.id, ...partnerIds];
  }
}
