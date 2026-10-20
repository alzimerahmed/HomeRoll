import { getHiddenAssets } from '@immich/sdk';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ url }) => {
  await authenticate(url);
  const assets = await getHiddenAssets();
  const $t = await getFormatter();

  return {
    assets,
    meta: {
      title: $t('hidden'),
    },
  };
}) satisfies PageLoad;
