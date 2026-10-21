import { vitest } from 'vitest';
import type { ServiceMocks } from 'test/utils.js';
import { JobName, JobStatus } from 'src/enum.js';
import { MemoryCurationService } from 'src/services/memory-curation.service.js';
import { QualityService } from 'src/services/quality.service.js';
import { automock, newTestService } from 'test/utils.js';

vitest.useFakeTimers();

describe(MemoryCurationService.name, () => {
  let sut: MemoryCurationService;
  let mocks: ServiceMocks;
  const qualityService = automock(QualityService, { strict: false });

  beforeEach(() => {
    ({ sut, mocks } = newTestService(MemoryCurationService));
    Object.assign(sut, { qualityService });
    qualityService.resetAllMocks();
    qualityService.getOverallScores.mockResolvedValue(new Map());
    mocks.user.getList.mockResolvedValue([{ id: 'user-1' }] as never);
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('onJobSuccess', () => {
    it('should queue curation after memory generation succeeds', async () => {
      await sut.onJobSuccess({ job: { name: JobName.MemoryGenerate }, response: JobStatus.Success });

      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.MemoryCurate, data: {} });
    });

    it('should ignore other jobs and failures', async () => {
      await sut.onJobSuccess({ job: { name: JobName.MemoryGenerate }, response: JobStatus.Failed });
      await sut.onJobSuccess({ job: { name: JobName.SmartSearch }, response: JobStatus.Success });

      expect(mocks.job.queue).not.toHaveBeenCalled();
    });
  });

  describe('handleMemoryCurate', () => {
    it('should skip when machine learning is disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ machineLearning: { enabled: false } });

      await expect(sut.handleMemoryCurate()).resolves.toBe(JobStatus.Skipped);
      expect(mocks.memory.search).not.toHaveBeenCalled();
    });

    it('should not touch memories at or below the minimum asset count', async () => {
      mocks.memory.search.mockResolvedValue([
        { id: 'memory-1', createdAt: new Date(), assets: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
      ] as never);

      await expect(sut.handleMemoryCurate()).resolves.toBe(JobStatus.Success);
      expect(mocks.memory.removeAssetIds).not.toHaveBeenCalled();
    });

    it('should drop low-quality assets while keeping the minimum', async () => {
      mocks.memory.search.mockResolvedValue([
        {
          id: 'memory-1',
          createdAt: new Date(),
          assets: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }],
        },
      ] as never);
      qualityService.getOverallScores.mockResolvedValue(
        new Map([
          ['a', 0.9],
          ['b', 0.8],
          ['c', 0.7],
          ['d', 0.1],
          ['e', 0.05],
        ]),
      );

      await sut.handleMemoryCurate();

      expect(mocks.memory.removeAssetIds).toHaveBeenCalledWith('memory-1', ['d', 'e']);
    });

    it('should leave memories untouched when scoring is unavailable', async () => {
      mocks.memory.search.mockResolvedValue([
        { id: 'memory-1', createdAt: new Date(), assets: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] },
      ] as never);
      qualityService.getOverallScores.mockResolvedValue(new Map());
      qualityService.scoreAssets.mockResolvedValue(new Set());

      await sut.handleMemoryCurate();

      expect(mocks.memory.removeAssetIds).not.toHaveBeenCalled();
    });
  });
});
