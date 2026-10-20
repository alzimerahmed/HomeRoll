import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { vitest } from 'vitest';
import { BrowseRepository } from 'src/repositories/browse.repository.js';
import { BrowseService } from 'src/services/browse.service.js';
import { BROWSE_LABELS } from 'src/utils/browse-labels.js';
import { encodeSearchCursor } from 'src/utils/search-cursor.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { newUuid } from 'test/small.factory.js';
import { ServiceMocks, automock, newTestService } from 'test/utils.js';

vitest.useFakeTimers();

describe(BrowseService.name, () => {
  let sut: BrowseService;
  let mocks: ServiceMocks;
  const browseRepository = automock(BrowseRepository, { strict: false });

  beforeEach(() => {
    ({ sut, mocks } = newTestService(BrowseService));
    Object.assign(sut, { browseRepository });
    browseRepository.resetAllMocks();
    mocks.partner.getAll.mockResolvedValue([]);
    mocks.machineLearning.encodeText.mockResolvedValue('[0.1, 0.2, 0.3]');
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('getLabels', () => {
    it('should return an entry per curated label', async () => {
      const auth = AuthFactory.create();
      const previewAssetId = newUuid();
      browseRepository.countLabelMatches.mockResolvedValue({ count: 3, previewAssetId });

      const items = await sut.getLabels(auth);

      expect(items).toHaveLength(BROWSE_LABELS.length);
      expect(items[0]).toEqual({
        key: BROWSE_LABELS[0].key,
        label: BROWSE_LABELS[0].label,
        count: 3,
        previewAssetId,
      });
      expect(mocks.machineLearning.encodeText).toHaveBeenCalledTimes(BROWSE_LABELS.length);
      expect(mocks.machineLearning.encodeText).toHaveBeenCalledWith(
        BROWSE_LABELS[0].prompt,
        expect.objectContaining({ modelName: expect.any(String) }),
      );
      expect(browseRepository.countLabelMatches).toHaveBeenCalledTimes(BROWSE_LABELS.length);
      expect(browseRepository.countLabelMatches).toHaveBeenCalledWith(
        { embedding: '[0.1, 0.2, 0.3]', maxDistance: expect.any(Number) },
        expect.objectContaining({ userIds: [auth.user.id], lockedOwnerId: auth.user.id }),
      );
    });

    it('should return a null preview when a label has no matches', async () => {
      const auth = AuthFactory.create();
      browseRepository.countLabelMatches.mockResolvedValue({ count: 0, previewAssetId: null });

      const items = await sut.getLabels(auth);

      expect(items[0]).toEqual({
        key: BROWSE_LABELS[0].key,
        label: BROWSE_LABELS[0].label,
        count: 0,
        previewAssetId: null,
      });
    });

    it('should serve the second call from the cache', async () => {
      const auth = AuthFactory.create();
      browseRepository.countLabelMatches.mockResolvedValue({ count: 1, previewAssetId: null });

      await sut.getLabels(auth);
      await sut.getLabels(auth);

      expect(mocks.machineLearning.encodeText).toHaveBeenCalledTimes(BROWSE_LABELS.length);
      expect(browseRepository.countLabelMatches).toHaveBeenCalledTimes(BROWSE_LABELS.length);
    });

    it('should recompute counts after the TTL while reusing embeddings', async () => {
      const auth = AuthFactory.create();
      browseRepository.countLabelMatches.mockResolvedValue({ count: 1, previewAssetId: null });

      await sut.getLabels(auth);
      vitest.setSystemTime(Date.now() + 7 * 60 * 60 * 1000);
      await sut.getLabels(auth);

      // embeddings are cached permanently (model + prompt), counts expire
      expect(mocks.machineLearning.encodeText).toHaveBeenCalledTimes(BROWSE_LABELS.length);
      expect(browseRepository.countLabelMatches).toHaveBeenCalledTimes(2 * BROWSE_LABELS.length);
    });

    it('should not cache results when encoding fails', async () => {
      const auth = AuthFactory.create();
      mocks.machineLearning.encodeText.mockRejectedValue(new Error('ML down'));

      await expect(sut.getLabels(auth)).rejects.toBeInstanceOf(ServiceUnavailableException);

      mocks.machineLearning.encodeText.mockResolvedValue('[0.1, 0.2, 0.3]');
      browseRepository.countLabelMatches.mockResolvedValue({ count: 1, previewAssetId: null });
      await expect(sut.getLabels(auth)).resolves.toHaveLength(BROWSE_LABELS.length);
    });

    it('should raise a BadRequestException if machine learning is disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ machineLearning: { enabled: false } });

      await expect(sut.getLabels(AuthFactory.create())).rejects.toThrowError(
        new BadRequestException('Smart search is not enabled'),
      );
      expect(browseRepository.countLabelMatches).not.toHaveBeenCalled();
    });

    it('should raise a BadRequestException if smart search is disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ machineLearning: { clip: { enabled: false } } });

      await expect(sut.getLabels(AuthFactory.create())).rejects.toThrowError(
        new BadRequestException('Smart search is not enabled'),
      );
    });
  });

  describe('getLabelAssets', () => {
    it('should reject an unknown label key', async () => {
      await expect(sut.getLabelAssets(AuthFactory.create(), 'nope', { size: 250 })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(browseRepository.searchLabelAssets).not.toHaveBeenCalled();
      expect(mocks.machineLearning.encodeText).not.toHaveBeenCalled();
    });

    it('should reject an invalid cursor', async () => {
      await expect(
        sut.getLabelAssets(AuthFactory.create(), 'beach', { size: 250, cursor: '???' }),
      ).rejects.toThrowError(new BadRequestException('Invalid cursor'));
    });

    it('should return the page and a next cursor', async () => {
      const auth = AuthFactory.create();
      browseRepository.searchLabelAssets.mockResolvedValue({ hasNextPage: true, items: [] });

      const result = await sut.getLabelAssets(auth, 'beach', { size: 250 });

      expect(result).toEqual({ count: 0, items: [], nextCursor: encodeSearchCursor(250) });
      expect(browseRepository.searchLabelAssets).toHaveBeenCalledWith(
        { take: 250, skip: 0 },
        { embedding: '[0.1, 0.2, 0.3]', maxDistance: expect.any(Number) },
        expect.objectContaining({ userIds: [auth.user.id], lockedOwnerId: auth.user.id }),
      );
      expect(mocks.machineLearning.encodeText).toHaveBeenCalledWith(
        'a photo of a beach',
        expect.objectContaining({ modelName: expect.any(String) }),
      );
    });

    it('should resume from the cursor offset', async () => {
      const auth = AuthFactory.create();
      browseRepository.searchLabelAssets.mockResolvedValue({ hasNextPage: false, items: [] });

      const result = await sut.getLabelAssets(auth, 'beach', { size: 100, cursor: encodeSearchCursor(300) });

      expect(result.nextCursor).toBeNull();
      expect(browseRepository.searchLabelAssets).toHaveBeenCalledWith(
        { take: 100, skip: 300 },
        expect.anything(),
        expect.anything(),
      );
    });

    it('should degrade to a 503-style error when the ML service is down', async () => {
      mocks.machineLearning.encodeText.mockRejectedValue(new Error('ML down'));

      await expect(sut.getLabelAssets(AuthFactory.create(), 'beach', { size: 250 })).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(browseRepository.searchLabelAssets).not.toHaveBeenCalled();
    });

    it('should raise a BadRequestException if machine learning is disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ machineLearning: { enabled: false } });

      await expect(sut.getLabelAssets(AuthFactory.create(), 'beach', { size: 250 })).rejects.toThrowError(
        new BadRequestException('Smart search is not enabled'),
      );
    });
  });
});
