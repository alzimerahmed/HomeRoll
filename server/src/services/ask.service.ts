import { BadRequestException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { mapAsset, type MapAsset } from 'src/dtos/asset-response.dto.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { AskDto, AskResponseDto } from 'src/dtos/ask.dto.js';
import { AssetType } from 'src/enum.js';
import { AssetSearchScope } from 'src/repositories/search.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { LlmService } from 'src/services/llm.service.js';
import { getMyPartnerIds } from 'src/utils/asset.util.js';
import { parseAskQuery } from 'src/utils/ask-query-parser.js';
import { isSmartSearchEnabled } from 'src/utils/misc.js';

/** Candidates fetched per search leg before merging. */
const LEG_SIZE = 60;
/** Hard cap on assets returned. */
const MAX_ASSETS = 500;
/** How many asset summaries the LLM sees. */
const LLM_CONTEXT_ASSETS = 40;

const SYSTEM_PROMPT = [
  'You are Ask HomeRoll, a assistant that answers questions about a user\'s personal photo library.',
  'You are given a structured interpretation of the question and a list of matching photos/videos with their metadata.',
  'Answer in the user\'s language in 1-3 short sentences. Reference concrete details (places, dates, people counts, text found in photos).',
  'Never invent assets, dates or places that are not in the context. If the context does not answer the question, say so.',
  'Never reveal file paths, server details, or other users\' information.',
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

  async ask(auth: AuthDto, dto: AskDto): Promise<AskResponseDto> {
    const { machineLearning } = await this.getConfig({ withCache: false });
    if (!isSmartSearchEnabled(machineLearning)) {
      throw new BadRequestException('Smart search is not enabled');
    }

    const parsed = parseAskQuery(dto.query);
    const userIds = await this.getUserIdsToSearch(auth);
    const scope: AssetSearchScope = { userIds, lockedOwnerId: auth.user.id, viewingUserId: auth.user.id };

    const embedding = await this.machineLearningRepository
      .encodeText(parsed.query ?? dto.query, { modelName: machineLearning.clip.modelName })
      .catch((error: Error | any) => {
        this.logger.warn(`Ask embedding failed: ${error}`);
        throw new ServiceUnavailableException('Machine learning service is unavailable');
      });

    // one vector search carries the CLIP ranking; EXIF/OCR filters ride along in
    // the same query via the shared search builder
    const { items } = await this.searchRepository.searchSmart(
      { page: 1, size: Math.min(dto.size, MAX_ASSETS) },
      {
        embedding,
        userIds,
        visibility: 'not-locked',
        city: parsed.city ?? undefined,
        country: parsed.country ?? undefined,
        takenAfter: parsed.takenAfter ? new Date(parsed.takenAfter) : undefined,
        takenBefore: parsed.takenBefore ? new Date(parsed.takenBefore) : undefined,
        type: parsed.mediaType ? (parsed.mediaType as AssetType) : undefined,
        isFavorite: parsed.favorited ?? undefined,
        ocr: parsed.ocr ?? undefined,
        withExif: true,
      },
    );

    const candidates = this.toCandidates(items.slice(0, Math.min(dto.size, MAX_ASSETS)));
    const provider = this.llmService.getProvider();

    if (provider) {
      try {
        const answer = await provider.chat(SYSTEM_PROMPT, this.buildContext(dto.query, parsed, candidates));
        return {
          answer,
          provider: 'llm',
          interpretation: this.toInterpretation(parsed),
          assets: candidates.map(({ asset }) => asset),
          total: items.length,
        };
      } catch (error: Error | any) {
        this.logger.warn(`Ask LLM provider failed, falling back to structured answer: ${error}`);
      }
    }

    return {
      answer: this.structuredAnswer(dto.query, parsed, items.length, candidates),
      provider: 'structured',
      interpretation: this.toInterpretation(parsed),
      assets: candidates.map(({ asset }) => asset),
      total: items.length,
    };
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
    const lines = candidates.slice(0, LLM_CONTEXT_ASSETS).map(({ summary }, index) => `${index + 1}. ${summary || '(no metadata)'}`);
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
    return `Found ${total} matching asset${total === 1 ? '' : 's'}${qualifier}.${suffix}`;
  }

  private toInterpretation(parsed: ReturnType<typeof parseAskQuery>) {
    return {
      query: parsed.query,
      city: parsed.city,
      country: parsed.country,
      takenAfter: parsed.takenAfter,
      takenBefore: parsed.takenBefore,
      mediaType: parsed.mediaType,
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
