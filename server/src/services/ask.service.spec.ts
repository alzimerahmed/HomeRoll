import { BadRequestException } from '@nestjs/common';
import { vitest } from 'vitest';
import { AskService } from 'src/services/ask.service.js';
import { LlmService } from 'src/services/llm.service.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { type ServiceMocks, automock, newTestService } from 'test/utils.js';

vitest.useFakeTimers();

describe(AskService.name, () => {
  let sut: AskService;
  let mocks: ServiceMocks;
  const llmService = automock(LlmService, { strict: false });

  beforeEach(() => {
    ({ sut, mocks } = newTestService(AskService));
    Object.assign(sut, { llmService });
    mocks.partner.getAll.mockResolvedValue([]);
    mocks.machineLearning.encodeText.mockResolvedValue('[0.1, 0.2, 0.3]');
    mocks.search.searchSmart.mockResolvedValue({ hasNextPage: false, items: [] });
    llmService.getProvider.mockReturnValue(null);
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  it('should reject when smart search is disabled', async () => {
    mocks.systemMetadata.get.mockResolvedValue({ machineLearning: { enabled: false } });

    await expect(sut.ask(AuthFactory.create(), { query: 'dogs' })).rejects.toBeInstanceOf(BadRequestException);
    expect(mocks.machineLearning.encodeText).not.toHaveBeenCalled();
  });

  it('should return a structured answer when no LLM is configured', async () => {
    const auth = AuthFactory.create();

    const result = await sut.ask(auth, { query: 'dog photos from 2019' });

    expect(result.provider).toBe('structured');
    expect(result.answer).toContain('No matching assets');
    expect(result.interpretation).toMatchObject({
      mediaType: 'IMAGE',
      takenAfter: '2019-01-01T00:00:00.000Z',
      takenBefore: '2020-01-01T00:00:00.000Z',
    });
    expect(mocks.search.searchSmart).toHaveBeenCalledWith(
      { page: 1, size: 100 },
      expect.objectContaining({
        embedding: '[0.1, 0.2, 0.3]',
        takenAfter: new Date('2019-01-01T00:00:00.000Z'),
        type: 'IMAGE',
      }),
    );
  });

  it('should use the LLM provider when configured', async () => {
    llmService.getProvider.mockReturnValue({ chat: vitest.fn().mockResolvedValue('You have 3 dog photos from 2019.') });
    mocks.search.searchSmart.mockResolvedValue({
      hasNextPage: false,
      items: [
        {
          id: 'asset-1',
          type: 'IMAGE',
          localDateTime: new Date('2019-06-01T00:00:00Z'),
          exifInfo: { city: 'Berlin' },
          people: [],
        } as never,
      ],
    });

    const result = await sut.ask(AuthFactory.create(), { query: 'dog photos from 2019' });

    expect(result.provider).toBe('llm');
    expect(result.answer).toContain('dog');
    expect(result.total).toBe(1);
  });

  it('should fall back to the structured answer when the LLM call fails', async () => {
    llmService.getProvider.mockReturnValue({ chat: vitest.fn().mockRejectedValue(new Error('LLM down')) });

    const result = await sut.ask(AuthFactory.create(), { query: 'dogs' });

    expect(result.provider).toBe('structured');
  });

  it('should forward OCR filters', async () => {
    await sut.ask(AuthFactory.create(), { query: 'a sign that says OPEN' });

    expect(mocks.search.searchSmart).toHaveBeenCalledWith(
      { page: 1, size: 100 },
      expect.objectContaining({ ocr: 'OPEN' }),
    );
  });
});
