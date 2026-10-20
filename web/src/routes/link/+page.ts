import { redirect } from '@sveltejs/kit';
import { OpenQueryParam } from '$lib/constants';
import { Route } from '$lib/route';
import type { PageLoad } from './$types';

enum LinkTarget {
  HOME = 'home',
  UNSUBSCRIBE = 'unsubscribe',
  VIEW_ASSET = 'view_asset',
}

export const load = (({ url }) => {
  const queryParams = url.searchParams;
  const target = queryParams.get('target') as LinkTarget;
  switch (target) {
    case LinkTarget.HOME: {
      return redirect(307, Route.photos());
    }

    case LinkTarget.UNSUBSCRIBE: {
      return redirect(307, Route.userSettings({ isOpen: OpenQueryParam.NOTIFICATIONS }));
    }

    case LinkTarget.VIEW_ASSET: {
      const id = queryParams.get('id');
      if (id) {
        return redirect(307, Route.viewAsset({ id }));
      }
      break;
    }
  }

  return redirect(307, Route.photos());
}) satisfies PageLoad;
