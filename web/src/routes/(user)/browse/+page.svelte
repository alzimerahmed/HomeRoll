<script lang="ts">
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import EmptyPlaceholder from '$lib/components/shared-components/EmptyPlaceholder.svelte';
  import { Route } from '$lib/route';
  import { getAssetMediaUrl } from '$lib/utils';
  import { AssetMediaSize } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiLabelOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();
</script>

<UserPageLayout title={data.meta.title} description={$t('browse_description')}>
  {#if data.loadError === 'disabled'}
    <EmptyPlaceholder title={$t('nothing_here_yet')} text={$t('browse_disabled_message')} class="mx-auto mt-10" />
  {:else if data.loadError}
    <EmptyPlaceholder title={$t('nothing_here_yet')} text={$t('browse_unavailable_message')} class="mx-auto mt-10" />
  {:else if data.labels.length === 0}
    <EmptyPlaceholder title={$t('nothing_here_yet')} text={$t('browse_empty_message')} class="mx-auto mt-10" />
  {:else}
    <ul class="grid grid-auto-fill-28 gap-4 p-2 md:grid-auto-fill-36">
      {#each data.labels as label (label.key)}
        <li>
          <a
            href={Route.browseLabel({ key: label.key })}
            class="group relative block overflow-hidden rounded-xl border border-subtle bg-subtle focus-visible:outline-2 focus-visible:outline-primary"
            draggable="false"
          >
            <div class="aspect-square w-full overflow-hidden">
              {#if label.previewAssetId}
                <img
                  src={getAssetMediaUrl({ id: label.previewAssetId, size: AssetMediaSize.Thumbnail })}
                  alt=""
                  loading="lazy"
                  class="size-full object-cover brightness-90 transition-[filter] duration-200 ease-out group-hover:brightness-100 group-focus-visible:brightness-100"
                />
              {:else}
                <div class="flex size-full items-center justify-center text-subtle">
                  <Icon icon={mdiLabelOutline} size="48" aria-hidden />
                </div>
              {/if}
            </div>
            <div class="absolute inset-x-0 bottom-0 bg-linear-to-t from-black/70 to-transparent px-3 pt-8 pb-2">
              <p class="truncate text-sm font-medium text-white">{label.label}</p>
              <p class="font-mono text-xs text-white/80 tabular-nums">
                {$t('assets_count', { values: { count: label.count } })}
              </p>
            </div>
          </a>
        </li>
      {/each}
    </ul>
  {/if}
</UserPageLayout>
