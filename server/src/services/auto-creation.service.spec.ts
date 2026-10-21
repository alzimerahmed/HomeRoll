import { vitest } from 'vitest';
import { AutoCreationType, JobName, JobStatus } from 'src/enum.js';
import { AutoCreationRepository } from 'src/repositories/auto-creation.repository.js';
import { AutoCreationService } from 'src/services/auto-creation.service.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { automock, newTestService } from 'test/utils.js';
import type { ServiceMocks } from 'test/utils.js';

vitest.useFakeTimers();

describe(AutoCreationService.name, () => {
  let sut: AutoCreationService;
  let mocks: ServiceMocks;
  const autoCreationRepository = automock(AutoCreationRepository, { strict: false });

  beforeEach(() => {
    ({ sut, mocks } = newTestService(AutoCreationService));
    Object.assign(sut, { autoCreationRepository });
    autoCreationRepository.resetAllMocks();
    mocks.job.queue.mockResolvedValue();
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('run', () => {
    it('should queue a generation job', async () => {
      const auth = AuthFactory.create();

      const result = await sut.run(auth, { type: AutoCreationType.Collage });

      expect(result).toEqual({ albumId: null, assetId: null, type: AutoCreationType.Collage });
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.AutoCreationGenerate,
        data: { id: expect.any(String), ownerId: auth.user.id, type: AutoCreationType.Collage },
      });
    });
  });

  describe('handleAutoCreationGenerate', () => {
    it('should skip when there is no source material', async () => {
      autoCreationRepository.getRecentHighlights.mockResolvedValue([]);

      await expect(
        sut.handleAutoCreationGenerate({ id: 'job-1', ownerId: 'user-1', type: AutoCreationType.Collage }),
      ).resolves.toBe(JobStatus.Skipped);
    });

    it('should skip trips when no candidate clears the threshold', async () => {
      autoCreationRepository.getTripCandidates.mockResolvedValue([]);

      await expect(
        sut.handleAutoCreationGenerate({ id: 'job-1', ownerId: 'user-1', type: AutoCreationType.TripHighlights }),
      ).resolves.toBe(JobStatus.Skipped);
    });

    it('should create a trip album for a qualifying candidate', async () => {
      autoCreationRepository.getTripCandidates.mockResolvedValue([{ city: 'Rome', country: 'Italy', assetCount: 12 }]);
      autoCreationRepository.getAlbumByName.mockResolvedValue(undefined);
      autoCreationRepository.getAssetsForTrip.mockResolvedValue([{ id: 'asset-1' }, { id: 'asset-2' }] as never);
      mocks.album.create.mockResolvedValue({ id: 'album-1' } as never);

      await expect(
        sut.handleAutoCreationGenerate({ id: 'job-1', ownerId: 'user-1', type: AutoCreationType.TripHighlights }),
      ).resolves.toBe(JobStatus.Success);

      expect(mocks.album.create).toHaveBeenCalledWith(
        expect.objectContaining({ ownerId: 'user-1', albumName: 'Trip to Rome' }),
        ['asset-1', 'asset-2'],
        [{ userId: 'user-1', role: 'owner' }],
        'user-1',
      );
    });

    it('should not duplicate an existing trip album', async () => {
      autoCreationRepository.getTripCandidates.mockResolvedValue([{ city: 'Rome', country: 'Italy', assetCount: 12 }]);
      autoCreationRepository.getAlbumByName.mockResolvedValue({ id: 'album-1' } as never);

      await expect(
        sut.handleAutoCreationGenerate({ id: 'job-1', ownerId: 'user-1', type: AutoCreationType.TripHighlights }),
      ).resolves.toBe(JobStatus.Skipped);
      expect(mocks.album.create).not.toHaveBeenCalled();
    });
  });
});
