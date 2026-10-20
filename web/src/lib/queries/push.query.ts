import { getPushSubscriptions, getVapidPublicKey } from '@immich/sdk';
import { queryOptions } from '@tanstack/svelte-query';

export const getVapidPublicKeyQuery = () =>
  queryOptions({
    queryKey: ['push', 'vapid-public-key'],
    queryFn: ({ signal }) => getVapidPublicKey({ signal }),
    staleTime: 0,
  });

export const getPushSubscriptionsQuery = () =>
  queryOptions({
    queryKey: ['push', 'subscriptions'],
    queryFn: ({ signal }) => getPushSubscriptions({ signal }),
    staleTime: 0,
  });
