import { getHiddenAssets, type AssetResponseDto } from '@immich/sdk';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ url }) => {
  await authenticate(url);
  const $t = await getFormatter();

  let assets: AssetResponseDto[] = [];
  try {
    assets = await getHiddenAssets();
  } catch (error) {
    console.error('[hidden] failed to load hidden assets', error);
  }

  return {
    assets,
    meta: {
      title: $t('hidden'),
    },
  };
}) satisfies PageLoad;
