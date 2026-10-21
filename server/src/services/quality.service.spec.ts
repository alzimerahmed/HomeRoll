import { vitest } from 'vitest';
import { JobName, JobStatus } from 'src/enum.js';
import { QualityRepository } from 'src/repositories/quality.repository.js';
import { QualityService } from 'src/services/quality.service.js';
import { automock, newTestService } from 'test/utils.js';
import type { ServiceMocks } from 'test/utils.js';

vitest.useFakeTimers();

describe(QualityService.name, () => {
  let sut: QualityService;
  let mocks: ServiceMocks;
  const qualityRepository = automock(QualityRepository, { strict: false });

  beforeEach(() => {
    ({ sut, mocks } = newTestService(QualityService));
    Object.assign(sut, { qualityRepository });
    qualityRepository.resetAllMocks();
    mocks.machineLearning.assessQuality.mockResolvedValue({
      blurScore: 0.8,
      exposureScore: 0.9,
      subjectScore: 0.5,
      eyesOpenScore: null,
    });
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('handleQualityScore', () => {
    it('should score an asset and persist the weighted overall', async () => {
      qualityRepository.getForQualityJob.mockResolvedValue({ id: 'asset-1', previewFile: '/preview.jpg' });
      qualityRepository.getFaces.mockResolvedValue([
        { boundingBoxX1: 0, boundingBoxY1: 0, boundingBoxX2: 100, boundingBoxY2: 100, score: 0.9 },
      ]);

      await expect(sut.handleQualityScore({ id: 'asset-1' })).resolves.toBe(JobStatus.Success);

      expect(mocks.machineLearning.assessQuality).toHaveBeenCalledWith('/preview.jpg', [
        { boundingBox: [0, 0, 100, 100], score: 0.9 },
      ]);
      expect(qualityRepository.upsert).toHaveBeenCalledWith('asset-1', {
        blur: 0.8,
        exposure: 0.9,
        subject: 0.5,
        eyesOpen: null,
        overall: 0.8 * 0.45 + 0.9 * 0.25 + 0.5 * 0.3,
      });
    });

    it('should skip when the asset has no preview', async () => {
      qualityRepository.getForQualityJob.mockResolvedValue({ id: 'asset-1', previewFile: null });

      await expect(sut.handleQualityScore({ id: 'asset-1' })).resolves.toBe(JobStatus.Skipped);
      expect(mocks.machineLearning.assessQuality).not.toHaveBeenCalled();
    });

    it('should reject when the ML service is down (transient — BullMQ retries)', async () => {
      qualityRepository.getForQualityJob.mockResolvedValue({ id: 'asset-1', previewFile: '/preview.jpg' });
      qualityRepository.getFaces.mockResolvedValue([]);
      mocks.machineLearning.assessQuality.mockRejectedValue(new Error('ML down'));

      await expect(sut.handleQualityScore({ id: 'asset-1' })).rejects.toThrow('ML down');
    });
  });

  describe('handleQueueQuality', () => {
    it('should queue a scoring job per unscored asset', async () => {
      qualityRepository.streamForQualityJob.mockReturnValue(
        (async function* () {
          yield [{ id: 'a' }, { id: 'b' }];
        })() as never,
      );

      await expect(sut.handleQueueQuality({ force: false })).resolves.toBe(JobStatus.Success);

      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.QualityScore, data: { id: 'a' } },
        { name: JobName.QualityScore, data: { id: 'b' } },
      ]);
    });

    it('should skip when machine learning is disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ machineLearning: { enabled: false } });

      await expect(sut.handleQueueQuality({ force: false })).resolves.toBe(JobStatus.Skipped);
      expect(qualityRepository.streamForQualityJob).not.toHaveBeenCalled();
    });
  });
});
