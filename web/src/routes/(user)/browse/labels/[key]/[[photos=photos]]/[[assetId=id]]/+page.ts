import { getBrowseLabelAssets, getBrowseLabels, isHttpError, type BrowseLabelAssetsResponseDto } from '@immich/sdk';
import { error } from '@sveltejs/kit';
import { authenticate } from '$lib/utils/auth';
import type { PageLoad } from './$types';

export type BrowseLabelPageError = 'disabled' | 'unreachable' | 'error' | undefined;

export const load = (async ({ params, url }) => {
  await authenticate(url);
  const key = params.key;

  let firstPage: BrowseLabelAssetsResponseDto | undefined;
  let loadError: BrowseLabelPageError;

  try {
    firstPage = await getBrowseLabelAssets({ key });
  } catch (error_) {
    if (isHttpError(error_) && error_.status === 404) {
      error(404, `Unknown browse label '${key}'`);
    }
    if (isHttpError(error_) && error_.status === 400) {
      loadError = 'disabled';
    } else if (isHttpError(error_) && error_.status === 503) {
      loadError = 'unreachable';
    } else {
      loadError = 'error';
      console.error('[browse] failed to load label assets', error_);
    }
  }

  // resolve the human-readable label name; fall back to the key when the
  // labels endpoint is unavailable — the grid still works
  let label: string | undefined;
  if (firstPage) {
    try {
      const labels = await getBrowseLabels();
      label = labels.find((item) => item.key === key)?.label;
    } catch {
      // keep the fallback title
    }
  }

  return {
    key,
    label,
    items: firstPage?.items ?? [],
    nextCursor: firstPage?.nextCursor ?? null,
    loadError,
    meta: {
      title: label ?? key,
    },
  };
}) satisfies PageLoad;
