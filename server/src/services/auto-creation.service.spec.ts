import { vitest } from 'vitest';
import type { ServiceMocks } from 'test/utils.js';
import { AutoCreationType } from 'src/dtos/auto-creation.dto.js';
import { JobName, JobStatus } from 'src/enum.js';
import { AutoCreationRepository } from 'src/repositories/auto-creation.repository.js';
import { AutoCreationService } from 'src/services/auto-creation.service.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { automock, newTestService } from 'test/utils.js';

// generated-media renderers write real files — stub them so the dedupe tests
// exercise the service logic, not sharp/ffmpeg
vitest.mock('src/utils/collage.js', () => ({ createCollage: vitest.fn().mockResolvedValue(undefined) }));
vitest.mock('src/utils/animation.js', () => ({ createAnimation: vitest.fn().mockResolvedValue(undefined) }));

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

      expect(result).toEqual({ type: AutoCreationType.Collage });
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

    it('should cap trip album creation at three per run', async () => {
      autoCreationRepository.getTripCandidates.mockResolvedValue(
        ['Rome', 'Paris', 'Tokyo', 'Oslo'].map((city) => ({ city, country: 'X', assetCount: 9 })),
      );
      autoCreationRepository.getAlbumByName.mockResolvedValue(undefined);
      autoCreationRepository.getAssetsForTrip.mockResolvedValue([{ id: 'asset-1' }] as never);
      mocks.album.create.mockResolvedValue({ id: 'album-1' } as never);

      await expect(
        sut.handleAutoCreationGenerate({ id: 'job-1', ownerId: 'user-1', type: AutoCreationType.TripHighlights }),
      ).resolves.toBe(JobStatus.Success);
      expect(mocks.album.create).toHaveBeenCalledTimes(3);
    });
  });

  describe('generated-asset dedupe', () => {
    const highlight = { id: 'asset-9', originalPath: '/uploads/src.jpg', fileCreatedAt: new Date('2024-01-01') };

    beforeEach(() => {
      autoCreationRepository.getRecentHighlights.mockResolvedValue([highlight] as never);
      autoCreationRepository.getPreviewPaths.mockResolvedValue(new Map() as never);
      mocks.storage.stat.mockResolvedValue({ size: 128 } as never);
      mocks.storage.readFile.mockResolvedValue(Buffer.from('rendered-collage'));
      mocks.asset.create.mockResolvedValue({
        id: 'asset-new',
        ownerId: 'user-1',
        originalFileName: 'Auto collage.jpg',
      } as never);
    });

    it('should reuse the existing asset when the checksum collides (idempotent re-run)', async () => {
      autoCreationRepository.getAssetByChecksum.mockResolvedValue({ id: 'asset-existing' } as never);

      await expect(
        sut.handleAutoCreationGenerate({ id: 'job-1', ownerId: 'user-1', type: AutoCreationType.Collage }),
      ).resolves.toBe(JobStatus.Success);

      // no duplicate asset row and the just-rendered temp file is removed
      expect(mocks.asset.create).not.toHaveBeenCalled();
      expect(mocks.event.emit).not.toHaveBeenCalled();
      expect(mocks.storage.unlink).toHaveBeenCalled();
    });

    it('should clean up the rendered file when generation fails', async () => {
      const { createCollage } = await import('src/utils/collage.js');
      vitest.mocked(createCollage).mockRejectedValueOnce(new Error('render failed'));
      autoCreationRepository.getAssetByChecksum.mockResolvedValue(undefined);

      await expect(
        sut.handleAutoCreationGenerate({ id: 'job-1', ownerId: 'user-1', type: AutoCreationType.Collage }),
      ).rejects.toThrow('render failed');
      expect(mocks.storage.unlink).toHaveBeenCalled();
    });

    it('should create a new asset for fresh output', async () => {
      autoCreationRepository.getAssetByChecksum.mockResolvedValue(undefined);

      await expect(
        sut.handleAutoCreationGenerate({ id: 'job-1', ownerId: 'user-1', type: AutoCreationType.Collage }),
      ).resolves.toBe(JobStatus.Success);

      expect(mocks.asset.create).toHaveBeenCalledWith(
        expect.objectContaining({ ownerId: 'user-1', originalFileName: 'Auto collage.jpg' }),
      );
      expect(mocks.event.emit).toHaveBeenCalledWith('AssetCreate', expect.anything());
      expect(mocks.job.queue).toHaveBeenCalledWith(expect.objectContaining({ name: JobName.AssetExtractMetadata }));
    });
  });
});
