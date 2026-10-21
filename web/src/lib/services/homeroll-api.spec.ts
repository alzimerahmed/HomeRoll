import { vitest } from 'vitest';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { askHomeRoll, AutoCreationType, runAutoCreation, trimVideo } from '$lib/services/homeroll-api';

vitest.mock('@immich/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@immich/sdk')>();
  return {
    ...actual,
    getBaseUrl: vitest.fn().mockReturnValue(''),
  };
});

const okResponse = (body: unknown) =>
  ({
    ok: true,
    json: vitest.fn().mockResolvedValue(body),
  }) as unknown as Response;

const fetchMock = vitest.fn();
vitest.stubGlobal('fetch', fetchMock);

beforeEach(() => {
  fetchMock.mockReset();
  // non-shared-link context: no extra query params
  Object.defineProperty(authManager, 'params', { value: {}, configurable: true });
});

describe('homeroll-api', () => {
  describe('askHomeRoll', () => {
    it('posts the query with the default size cap', async () => {
      fetchMock.mockResolvedValue(
        okResponse({ answer: 'a', provider: 'structured', interpretation: {}, assets: [], total: 0 }),
      );

      await askHomeRoll('dogs in paris');

      expect(fetchMock).toHaveBeenCalledWith('/ask', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'dogs in paris', size: 100 }),
      });
    });
  });

  describe('runAutoCreation', () => {
    it('posts the creation type', async () => {
      fetchMock.mockResolvedValue(okResponse({ type: 'collage' }));

      await runAutoCreation(AutoCreationType.Collage);

      expect(fetchMock).toHaveBeenCalledWith('/auto-creations/run', expect.objectContaining({ method: 'POST' }));
      expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({ type: 'collage' });
    });
  });

  describe('trimVideo (FG-15, ADR-021)', () => {
    it('posts a { startSeconds, endSeconds } payload to /videos/:id/trim', async () => {
      fetchMock.mockResolvedValue(okResponse({ assetId: 'new-asset' }));

      const result = await trimVideo('asset-1', { startSeconds: 1.5, endSeconds: 9.75 });

      expect(fetchMock).toHaveBeenCalledWith('/videos/asset-1/trim', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startSeconds: 1.5, endSeconds: 9.75 }),
      });
      expect(result).toEqual({ assetId: 'new-asset' });
    });

    it('surfaces non-2xx as an error carrying the status (404 until the endpoint lands)', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 404 } as Response);

      await expect(trimVideo('asset-1', { startSeconds: 0, endSeconds: 5 })).rejects.toMatchObject({
        name: 'HomerollApiError',
        status: 404,
      });
    });
  });

  describe('shared-link params', () => {
    it('appends authManager params to the request URL', async () => {
      Object.defineProperty(authManager, 'params', { value: { key: 'shared-key' }, configurable: true });
      fetchMock.mockResolvedValue(okResponse({}));

      await runAutoCreation(AutoCreationType.Animation);

      expect(fetchMock).toHaveBeenCalledWith('/auto-creations/run?key=shared-key', expect.anything());
    });
  });
});
