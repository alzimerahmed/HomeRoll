import { Inject, Injectable } from '@nestjs/common';
import { OnEvent, OnJob } from 'src/decorators.js';
import { JobName, JobStatus, QueueName } from 'src/enum.js';
import { MemoryRepository } from 'src/repositories/memory.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { QualityService } from 'src/services/quality.service.js';

/** Assets below this overall score are dropped from unsaved auto-memories. */
const CURATION_DROP_THRESHOLD = 0.15;
/** Never trim a memory below this many assets — an empty memory is worse than a blurry one. */
const MIN_MEMORY_ASSETS = 3;
/** Memories created within this window are curated; older ones are left alone. */
const CURATION_WINDOW_DAYS = 7;
/** How many memories per user are examined per run. */
const MAX_MEMORIES_PER_USER = 100;

/**
 * FG-12 (HomeRoll): memory curation quality pass.
 *
 * Runs after `MemoryGenerate` succeeds (listened via the `JobSuccess` event —
 * no upstream memory.service edit). For each user's recent unsaved memories it
 * lazily scores assets that lack an `asset_quality` row, then drops the
 * bottom-quality assets (blurry/blown-out shots) while keeping the memory
 * presentable. Saved memories and user-curated content are never touched.
 */
@Injectable()
export class MemoryCurationService extends BaseService {
  @Inject(QualityService)
  private readonly qualityService!: QualityService;

  @OnEvent({ name: 'JobSuccess' })
  async onJobSuccess({ job, response }: { job: { name: JobName }; response?: JobStatus }) {
    if (job.name !== JobName.MemoryGenerate || response !== JobStatus.Success) {
      return;
    }

    await this.jobRepository.queue({ name: JobName.MemoryCurate, data: {} });
  }

  @OnJob({ name: JobName.MemoryCurate, queue: QueueName.BackgroundTask })
  async handleMemoryCurate(): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: true });
    if (!machineLearning.enabled) {
      return JobStatus.Skipped;
    }

    const users = await this.userRepository.getList({ withDeleted: false });
    const cutoff = new Date(Date.now() - CURATION_WINDOW_DAYS * 24 * 3600 * 1000);

    for (const user of users) {
      try {
        await this.curateUser(user.id, cutoff);
      } catch (error: unknown) {
        this.logger.warn(
          `Memory curation failed for user ${user.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return JobStatus.Success;
  }

  private async curateUser(userId: string, cutoff: Date): Promise<void> {
    const memories = await this.memoryRepository.search(userId, {
      isSaved: false,
      size: MAX_MEMORIES_PER_USER,
      page: 1,
    });
    const recent = memories.filter((memory) => new Date(memory.createdAt) >= cutoff);
    if (recent.length === 0) {
      return;
    }

    for (const memory of recent) {
      const assetIds = (memory.assets ?? []).map(({ id }) => id);
      if (assetIds.length <= MIN_MEMORY_ASSETS) {
        continue;
      }

      const scores = await this.ensureScores(assetIds);
      if (!scores) {
        continue; // ML unavailable — leave the memory untouched rather than half-curate
      }

      const ranked = assetIds
        .map((id) => ({ id, overall: scores.get(id) ?? 0.5 }))
        .sort((a, b) => b.overall - a.overall);

      const droppable = ranked.filter(({ overall }) => overall < CURATION_DROP_THRESHOLD);
      const keepCount = Math.max(assetIds.length - droppable.length, MIN_MEMORY_ASSETS);
      const drop = ranked.slice(keepCount).map(({ id }) => id);
      if (drop.length > 0) {
        await this.memoryRepository.removeAssetIds(memory.id, drop);
        this.logger.debug(`Curated memory ${memory.id}: dropped ${drop.length} low-quality asset(s)`);
      }
    }
  }

  /**
   * Scores any candidate without an `asset_quality` row; null when ML is unavailable.
   * Per-asset failures are logged and skipped — one unscorable asset must not
   * silently drop the whole memory.
   */
  private async ensureScores(assetIds: string[]): Promise<Map<string, number> | null> {
    let scores = await this.qualityService.getOverallScores(assetIds);

    const missing = assetIds.filter((id) => !scores.has(id));
    if (missing.length > 0) {
      const scored = await this.qualityService.scoreAssets(missing);
      const failed = missing.filter((id) => !scored.has(id));
      if (failed.length > 0) {
        this.logger.warn(`Failed to score ${failed.length} asset(s); curation proceeds with the rest`);
      }
      scores = await this.qualityService.getOverallScores(assetIds);
    }

    return scores;
  }
}
