import { Inject, Injectable } from '@nestjs/common';
import type { JobOf } from 'src/types.js';
import { OnJob } from 'src/decorators.js';
import { JobName, JobStatus, QueueName } from 'src/enum.js';
import { type QualityFacePayload } from 'src/repositories/machine-learning.repository.js';
import { QualityRepository } from 'src/repositories/quality.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { batched } from 'src/utils/misc.js';

/** Score weights for the overall ranking signal (sum to 1). */
const WEIGHTS = { blur: 0.45, exposure: 0.25, subject: 0.3 } as const;
/** Upper bound on per-job scoring work — the queue re-queues the rest. */
const MAX_ASSETS_PER_RUN = 5000;

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
    const items: { name: JobName.QualityScore; data: { id: string } }[] = [];
    for await (const assets of batched(this.qualityRepository.streamForQualityJob(force), 1000)) {
      for (const asset of assets) {
        items.push({ name: JobName.QualityScore, data: { id: asset.id } });
        queued++;
        if (queued >= MAX_ASSETS_PER_RUN) {
          break;
        }
      }
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
  async handleQualityScore({ id }: JobOf<JobName.QualityScore>): Promise<JobStatus> {
    return (await this.scoreAsset(id)) ? JobStatus.Success : JobStatus.Failed;
  }

  /** Stored overall scores for a set of assets (unscored assets are absent). */
  getOverallScores(assetIds: string[]): Promise<Map<string, number>> {
    return this.qualityRepository.getOverallByAssetIds(assetIds);
  }

  /**
   * Scores one asset and persists the result. Public so the memory-curation
   * service can score candidates lazily before ranking them.
   */
  async scoreAsset(id: string): Promise<boolean> {
    const { machineLearning } = await this.getConfig({ withCache: true });
    if (!machineLearning.enabled) {
      return false;
    }

    const asset = await this.qualityRepository.getForQualityJob(id);
    if (!asset || !asset.previewFile) {
      return false;
    }

    const faces = await this.qualityRepository.getFaces(id);
    const payload: QualityFacePayload[] = faces.map((face) => ({
      boundingBox: [face.boundingBoxX1, face.boundingBoxY1, face.boundingBoxX2, face.boundingBoxY2],
      score: Number(face.score),
    }));

    const signals = await this.machineLearningRepository.assessQuality(asset.previewFile, payload);
    const overall =
      signals.blurScore * WEIGHTS.blur +
      signals.exposureScore * WEIGHTS.exposure +
      signals.subjectScore * WEIGHTS.subject;

    await this.qualityRepository.upsert(id, {
      blur: signals.blurScore,
      exposure: signals.exposureScore,
      subject: signals.subjectScore,
      eyesOpen: signals.eyesOpenScore,
      overall,
    });

    return true;
  }
}
