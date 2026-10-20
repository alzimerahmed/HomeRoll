import { getAlbumInfo, getAllAlbums } from '@immich/sdk';
import { authenticate } from '$lib/utils/auth';
import type { PageLoad } from './$types';

export const load = (async ({ params, url, depends }) => {
  await authenticate(url);

  depends('album:data');

  const album = await getAlbumInfo({ id: params.albumId });
  // All albums visible to the user — used to resolve the album's ancestor chain
  // for the breadcrumb (FG-07). Unresolvable ancestors are skipped gracefully.
  const albums = await getAllAlbums({});

  return {
    album,
    albums,
    meta: {
      title: album.albumName,
    },
  };
}) satisfies PageLoad;
