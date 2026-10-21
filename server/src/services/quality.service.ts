import { Inject, Injectable } from '@nestjs/common';
import type { JobOf } from 'src/types.js';
import { OnJob } from 'src/decorators.js';
import { JobName, JobStatus, QueueName } from 'src/enum.js';
import { QualityRepository } from 'src/repositories/quality.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { batched } from 'src/utils/misc.js';

/** Score weights for the overall ranking signal (sum to 1). */
const WEIGHTS = { blur: 0.45, exposure: 0.25, subject: 0.3 } as const;
/** Upper bound on per-job scoring work — the queue re-queues the rest. */
const MAX_ASSETS_PER_RUN = 5000;
/** Assets per BullMQ job and per ML HTTP request — amortizes job ops and transport. */
const QUALITY_BATCH_SIZE = 50;

/**
 * FG-12 (HomeRoll): image quality signals for memory curation.
 *
 * Scores every image asset once via the ML service's `/quality` endpoint
 * (blur/exposure/subject) and persists the result in `asset_quality`. The
 * memory-curation service consumes the stored `overall` score to rank and trim
 * auto-generated memories. The row's existence is the "scored" marker — no
 * `asset_job_status` column needed.
 */
@Injectable()
export class QualityService extends BaseService {
  @Inject(QualityRepository)
  private readonly qualityRepository!: QualityRepository;

  @OnJob({ name: JobName.QualityScoreQueueAll, queue: QueueName.BackgroundTask })
  async handleQueueQuality({ force }: JobOf<JobName.QualityScoreQueueAll>): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: true });
    if (!machineLearning.enabled) {
      return JobStatus.Skipped;
    }

    if (force) {
      await this.qualityRepository.deleteAll();
    }

    let queued = 0;
    const items: { name: JobName.QualityScore; data: { assetIds: string[] } }[] = [];
    for await (const assets of batched(this.qualityRepository.streamForQualityJob(force), QUALITY_BATCH_SIZE)) {
      items.push({ name: JobName.QualityScore, data: { assetIds: assets.map(({ id }) => id) } });
      queued += assets.length;
      if (queued >= MAX_ASSETS_PER_RUN) {
        break;
      }
    }

    await this.jobRepository.queueAll(items);
    if (queued >= MAX_ASSETS_PER_RUN) {
      // a large backlog cannot starve other jobs — continue in a follow-up sweep
      await this.jobRepository.queue({ name: JobName.QualityScoreQueueAll, data: { force: false } });
    }

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.QualityScore, queue: QueueName.BackgroundTask })
  async handleQualityScore({ assetIds }: JobOf<JobName.QualityScore>): Promise<JobStatus> {
    // Per-asset failure isolation: permanently unscorable assets (no preview) are
    // skipped, transient ML failures propagate so BullMQ retries the batch
    const scored = await this.scoreAssets(assetIds);
    return scored.size > 0 ? JobStatus.Success : JobStatus.Skipped;
  }

  /** Stored overall scores for a set of assets (unscored assets are absent). */
  getOverallScores(assetIds: string[]): Promise<Map<string, number>> {
    return this.qualityRepository.getOverallByAssetIds(assetIds);
  }

  /**
   * Scores a batch of assets and persists the results. Public so the
   * memory-curation service can score candidates lazily before ranking them.
   * Returns the ids that were successfully scored.
   */
  async scoreAssets(ids: string[]): Promise<Set<string>> {
    const { machineLearning } = await this.getConfig({ withCache: true });
    if (!machineLearning.enabled) {
      return new Set();
    }

    const assets = await this.qualityRepository.getForQualityJobBatch(ids);
    const scorable = assets.filter((asset) => asset.previewFile);
    if (scorable.length === 0) {
      return new Set();
    }

    const facesByAsset = await this.qualityRepository.getFacesForAssets(scorable.map(({ id }) => id));
    const signals = await this.machineLearningRepository.assessQualityBatch(
      scorable.map(({ id, previewFile }) => ({
        imagePath: previewFile!,
        faces: (facesByAsset.get(id) ?? []).map((face) => ({
          boundingBox: [face.boundingBoxX1, face.boundingBoxY1, face.boundingBoxX2, face.boundingBoxY2],
          // detection confidence is not persisted on asset_face — every stored
          // face is already an ML detection, so treat them as full-confidence
          score: 1,
        })),
      })),
    );

    const scored = new Set<string>();
    for (let index = 0; index < scorable.length; index++) {
      const asset = scorable[index]!;
      const item = signals[index];
      if (!item) {
        continue;
      }
      const overall =
        item.blurScore * WEIGHTS.blur + item.exposureScore * WEIGHTS.exposure + item.subjectScore * WEIGHTS.subject;
      await this.qualityRepository.upsert(asset.id, {
        blur: item.blurScore,
        exposure: item.exposureScore,
        subject: item.subjectScore,
        eyesOpen: item.eyesOpenScore,
        overall,
      });
      scored.add(asset.id);
    }

    return scored;
  }
}
