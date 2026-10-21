import { vitest } from 'vitest';
import type { ServiceMocks } from 'test/utils.js';
import { JobName, JobStatus } from 'src/enum.js';
import { QualityRepository } from 'src/repositories/quality.repository.js';
import { QualityService } from 'src/services/quality.service.js';
import { automock, newTestService } from 'test/utils.js';

vitest.useFakeTimers();

describe(QualityService.name, () => {
  let sut: QualityService;
  let mocks: ServiceMocks;
  const qualityRepository = automock(QualityRepository, { strict: false });

  beforeEach(() => {
    ({ sut, mocks } = newTestService(QualityService));
    Object.assign(sut, { qualityRepository });
    qualityRepository.resetAllMocks();
    mocks.machineLearning.assessQualityBatch.mockResolvedValue([
      {
        blurScore: 0.8,
        exposureScore: 0.9,
        subjectScore: 0.5,
        eyesOpenScore: null,
      },
    ]);
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('handleQualityScore', () => {
    it('should score a batch and persist the weighted overall', async () => {
      qualityRepository.getForQualityJobBatch.mockResolvedValue([{ id: 'asset-1', previewFile: '/preview.jpg' }]);
      qualityRepository.getFacesForAssets.mockResolvedValue(
        new Map([
          ['asset-1', [{ boundingBoxX1: 0, boundingBoxY1: 0, boundingBoxX2: 100, boundingBoxY2: 100, score: 0.9 }]],
        ]),
      );

      await expect(sut.handleQualityScore({ assetIds: ['asset-1'] })).resolves.toBe(JobStatus.Success);

      expect(mocks.machineLearning.assessQualityBatch).toHaveBeenCalledWith([
        { imagePath: '/preview.jpg', faces: [{ boundingBox: [0, 0, 100, 100], score: 0.9 }] },
      ]);
      expect(qualityRepository.upsert).toHaveBeenCalledWith('asset-1', {
        blur: 0.8,
        exposure: 0.9,
        subject: 0.5,
        eyesOpen: null,
        overall: 0.8 * 0.45 + 0.9 * 0.25 + 0.5 * 0.3,
      });
    });

    it('should skip when no asset in the batch has a preview', async () => {
      qualityRepository.getForQualityJobBatch.mockResolvedValue([{ id: 'asset-1', previewFile: null }]);

      await expect(sut.handleQualityScore({ assetIds: ['asset-1'] })).resolves.toBe(JobStatus.Skipped);
      expect(mocks.machineLearning.assessQualityBatch).not.toHaveBeenCalled();
    });

    it('should reject when the ML service is down (transient — BullMQ retries)', async () => {
      qualityRepository.getForQualityJobBatch.mockResolvedValue([{ id: 'asset-1', previewFile: '/preview.jpg' }]);
      qualityRepository.getFacesForAssets.mockResolvedValue(new Map());
      mocks.machineLearning.assessQualityBatch.mockRejectedValue(new Error('ML down'));

      await expect(sut.handleQualityScore({ assetIds: ['asset-1'] })).rejects.toThrow('ML down');
    });
  });

  describe('handleQueueQuality', () => {
    it('should queue batched scoring jobs (50 assets per job)', async () => {
      qualityRepository.streamForQualityJob.mockReturnValue(
        (function* () {
          yield [{ id: 'a' }, { id: 'b' }];
        })() as never,
      );

      await expect(sut.handleQueueQuality({ force: false })).resolves.toBe(JobStatus.Success);

      expect(mocks.job.queueAll).toHaveBeenCalledWith([{ name: JobName.QualityScore, data: { assetIds: ['a', 'b'] } }]);
    });

    it('should skip when machine learning is disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ machineLearning: { enabled: false } });

      await expect(sut.handleQueueQuality({ force: false })).resolves.toBe(JobStatus.Skipped);
      expect(qualityRepository.streamForQualityJob).not.toHaveBeenCalled();
    });
  });
});
