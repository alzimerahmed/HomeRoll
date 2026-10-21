import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AskDto, AskResponseDto } from 'src/dtos/ask.dto.js';
import { type MapAsset, mapAsset } from 'src/dtos/asset-response.dto.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { AssetType } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { LlmService } from 'src/services/llm.service.js';
import { parseAskQuery } from 'src/utils/ask-query-parser.js';
import { getMyPartnerIds } from 'src/utils/asset.util.js';
import { isSmartSearchEnabled } from 'src/utils/misc.js';

/** Hard cap on assets returned. */
const MAX_ASSETS = 500;
/** How many asset summaries the LLM sees. */
const LLM_CONTEXT_ASSETS = 40;
/** How many assets the response carries — search may match more, the payload stays bounded. */
const MAX_RESPONSE_ASSETS = 100;
/** Per-user ask rate limit: a token bucket of RATE_BURST requests refilling RATE_PER_MINUTE/minute. */
const RATE_BURST = 10;
const RATE_PER_MINUTE = 10;
/** Idle buckets are pruned once the map grows past this many users. */
const RATE_BUCKET_PRUNE_THRESHOLD = 1000;

const SYSTEM_PROMPT = [
  "You are Ask HomeRoll, an assistant that answers questions about a user's personal photo library.",
  'You are given a structured interpretation of the question and a list of matching photos/videos with their metadata.',
  "Answer in the user's language in 1-3 short sentences. Reference concrete details (places, dates, people counts, text found in photos).",
  'Never invent assets, dates or places that are not in the context. If the context does not answer the question, say so.',
  "Never reveal file paths, server details, or other users' information.",
].join(' ');

interface AskCandidate {
  id: string;
  asset: ReturnType<typeof mapAsset>;
  summary: string;
}

/**
 * FG-13 (HomeRoll): "Ask HomeRoll" conversational search.
 *
 * Pipeline: heuristic NL parsing (`utils/ask-query-parser.ts`) → structured
 * filters + CLIP text embedding → merged candidate set from the smart-search
 * vector index, EXIF metadata filters and OCR text index → answer composed by
 * the configured LLM provider (OpenAI-compatible endpoint via env vars) or, in
 * the no-LLM default, a deterministic structured summary. Ownership semantics
 * match smart search exactly (own + partner-timeline assets, locked excluded).
 */
@Injectable()
export class AskService extends BaseService {
  @Inject(LlmService)
  private readonly llmService!: LlmService;

  /** Per-user token bucket (in-process; single API instance is the norm for this deployment). */
  #rateBuckets = new Map<string, { tokens: number; refilledAt: number }>();

  async ask(auth: AuthDto, dto: AskDto): Promise<AskResponseDto> {
    const { machineLearning } = await this.getConfig({ withCache: true });
    if (!isSmartSearchEnabled(machineLearning)) {
      throw new BadRequestException('Smart search is not enabled');
    }

    this.consumeRateToken(auth.user.id);
    const parsed = parseAskQuery(dto.query);
    const userIds = await this.getUserIdsToSearch(auth);

    const embedding = await this.machineLearningRepository
      .encodeText(parsed.query ?? dto.query, { modelName: machineLearning.clip.modelName })
      .catch((error: unknown) => {
        this.logger.warn(`Ask embedding failed: ${error instanceof Error ? error.message : String(error)}`);
        throw new ServiceUnavailableException('Machine learning service is unavailable');
      });

    // one vector search carries the CLIP ranking; EXIF/OCR filters ride along in
    // the same query via the shared search builder
    const size = Math.min(dto.size ?? 100, MAX_ASSETS);
    const { items, hasNextPage } = await this.searchRepository.searchSmart(
      { page: 1, size },
      {
        embedding,
        userIds,
        visibility: 'not-locked',
        city: parsed.city ?? undefined,
        country: parsed.country ?? undefined,
        takenAfter: parsed.takenAfter ? new Date(parsed.takenAfter) : undefined,
        takenBefore: parsed.takenBefore ? new Date(parsed.takenBefore) : undefined,
        type: parsed.mediaType as AssetType | undefined,
        isFavorite: parsed.favorited ?? undefined,
        ocr: parsed.ocr ?? undefined,
        withExif: true,
      },
    );

    // paginationHelper splices `items` to `size` and reports the overflow via
    // `hasNextPage` — report an honest lower bound ("at least N") rather than
    // the page-limited count
    const total = hasNextPage ? size + 1 : items.length;
    const candidates = this.toCandidates(items);
    const provider = this.llmService.getProvider();

    if (provider) {
      try {
        const answer = await provider.chat(SYSTEM_PROMPT, this.buildContext(dto.query, parsed, candidates));
        return {
          answer,
          provider: 'llm',
          interpretation: this.toInterpretation(parsed),
          assets: candidates.slice(0, MAX_RESPONSE_ASSETS).map(({ asset }) => asset),
          total,
        };
      } catch (error: unknown) {
        this.logger.warn(
          `Ask LLM provider failed, falling back to structured answer: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return {
      answer: this.structuredAnswer(dto.query, parsed, total, hasNextPage, candidates),
      provider: 'structured',
      interpretation: this.toInterpretation(parsed),
      assets: candidates.slice(0, MAX_RESPONSE_ASSETS).map(({ asset }) => asset),
      total,
    };
  }

  /**
   * Token-bucket rate limit: each user gets a burst of RATE_BURST requests that
   * refill linearly to RATE_PER_MINUTE per minute. Deliberately in-process and
   * dependency-free — the API is single-instance in this deployment; a shared
   * Redis limiter is only needed if the API ever scales horizontally.
   */
  private consumeRateToken(userId: string): void {
    if (this.#rateBuckets.size > RATE_BUCKET_PRUNE_THRESHOLD) {
      const stale = Date.now() - (RATE_BURST / RATE_PER_MINUTE) * 60_000;
      for (const [id, bucket] of this.#rateBuckets) {
        if (bucket.refilledAt < stale) {
          this.#rateBuckets.delete(id);
        }
      }
    }

    const now = Date.now();
    const bucket = this.#rateBuckets.get(userId) ?? { tokens: RATE_BURST, refilledAt: now };
    const tokens = Math.min(RATE_BURST, bucket.tokens + ((now - bucket.refilledAt) / 60_000) * RATE_PER_MINUTE);
    if (tokens < 1) {
      throw new HttpException('Too many ask requests — slow down a little', HttpStatus.TOO_MANY_REQUESTS);
    }
    this.#rateBuckets.set(userId, { tokens: tokens - 1, refilledAt: now });
  }

  private toCandidates(items: MapAsset[]): AskCandidate[] {
    return items.map((asset) => ({
      id: asset.id,
      asset: mapAsset(asset),
      summary: this.summarizeAsset(asset),
    }));
  }

  private summarizeAsset(asset: {
    id: string;
    type: AssetType;
    fileCreatedAt?: Date;
    localDateTime?: Date;
    exifInfo?: {
      city?: string | null;
      state?: string | null;
      country?: string | null;
      description?: string | null;
      make?: string | null;
      model?: string | null;
    } | null;
    people?: { name?: string | null }[];
  }): string {
    const parts: string[] = [];
    const date = asset.localDateTime ?? asset.fileCreatedAt;
    if (date) {
      parts.push(new Date(date).toISOString().slice(0, 10));
    }
    const exif = asset.exifInfo;
    const place = [exif?.city, exif?.state, exif?.country].filter(Boolean).join(', ');
    if (place) {
      parts.push(place);
    }
    if (asset.type === AssetType.Video) {
      parts.push('video');
    }
    if (exif?.description) {
      parts.push(`description: ${exif.description}`);
    }
    const people = (asset.people ?? []).map(({ name }) => name).filter(Boolean);
    if (people.length > 0) {
      parts.push(`people: ${people.join(', ')}`);
    }
    return parts.join(' | ');
  }

  private buildContext(query: string, parsed: ReturnType<typeof parseAskQuery>, candidates: AskCandidate[]): string {
    const lines = candidates
      .slice(0, LLM_CONTEXT_ASSETS)
      .map(({ summary }, index) => `${index + 1}. ${summary || '(no metadata)'}`);
    return [
      `Question: ${query}`,
      `Parsed filters: ${JSON.stringify(parsed)}`,
      `Matching assets (${candidates.length} total, showing ${lines.length}):`,
      ...lines,
    ].join('\n');
  }

  private structuredAnswer(
    query: string,
    parsed: ReturnType<typeof parseAskQuery>,
    total: number,
    hasMore: boolean,
    candidates: AskCandidate[],
  ): string {
    if (total === 0) {
      return `No matching assets found for "${query}".`;
    }

    const scope: string[] = [];
    if (parsed.city) {
      scope.push(`in ${parsed.city}`);
    }
    if (parsed.takenAfter) {
      scope.push(`since ${parsed.takenAfter.slice(0, 10)}`);
    }
    if (parsed.takenBefore) {
      scope.push(`before ${parsed.takenBefore.slice(0, 10)}`);
    }
    if (parsed.mediaType) {
      scope.push(parsed.mediaType === 'VIDEO' ? 'videos' : 'photos');
    }
    if (parsed.favorited) {
      scope.push('favorites');
    }
    if (parsed.ocr) {
      scope.push(`containing the text "${parsed.ocr}"`);
    }

    const qualifier = scope.length > 0 ? ` ${scope.join(' ')}` : '';
    const sample = candidates[0]?.summary;
    const suffix = sample ? ` Best match: ${sample}.` : '';
    const count = hasMore ? `${total}+` : String(total);
    return `Found ${count} matching asset${total === 1 ? '' : 's'}${qualifier}.${suffix}`;
  }

  private toInterpretation(parsed: ReturnType<typeof parseAskQuery>) {
    return {
      query: parsed.query,
      city: parsed.city,
      country: parsed.country,
      takenAfter: parsed.takenAfter,
      takenBefore: parsed.takenBefore,
      mediaType: parsed.mediaType ?? undefined,
      favorited: parsed.favorited,
      ocr: parsed.ocr,
    };
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
