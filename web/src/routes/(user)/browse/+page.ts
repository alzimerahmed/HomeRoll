import { getBrowseLabels, isHttpError, type BrowseLabelResponseDto } from '@immich/sdk';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export type BrowseLabelsError = 'disabled' | 'unreachable' | 'error' | undefined;

export const load = (async ({ url }) => {
  await authenticate(url);
  const $t = await getFormatter();

  let labels: BrowseLabelResponseDto[] = [];
  let loadError: BrowseLabelsError;

  try {
    labels = await getBrowseLabels();
  } catch (error) {
    if (isHttpError(error) && error.status === 400) {
      // smart search / machine learning is disabled
      loadError = 'disabled';
    } else if (isHttpError(error) && error.status === 503) {
      // machine learning service is unreachable
      loadError = 'unreachable';
    } else {
      loadError = 'error';
      console.error('[browse] failed to load labels', error);
    }
  }

  return {
    // populated labels first; keep the curated taxonomy order for the rest
    labels: [...labels].sort((a, b) => b.count - a.count),
    loadError,
    meta: {
      title: $t('browse'),
    },
  };
}) satisfies PageLoad;
