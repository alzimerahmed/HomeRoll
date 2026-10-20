<script lang="ts">
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import ButtonContextMenu from '$lib/components/shared-components/context-menu/ButtonContextMenu.svelte';
  import EmptyPlaceholder from '$lib/components/shared-components/EmptyPlaceholder.svelte';
  import GalleryViewer from '$lib/components/shared-components/gallery-viewer/GalleryViewer.svelte';
  import ArchiveAction from '$lib/components/timeline/actions/ArchiveAction.svelte';
  import DeleteAssets from '$lib/components/timeline/actions/DeleteAssetsAction.svelte';
  import DownloadAction from '$lib/components/timeline/actions/DownloadAction.svelte';
  import FavoriteAction from '$lib/components/timeline/actions/FavoriteAction.svelte';
  import HideAction from '$lib/components/timeline/actions/HideAction.svelte';
  import SetVisibilityAction from '$lib/components/timeline/actions/SetVisibilityAction.svelte';
  import AssetSelectControlBar from '$lib/components/timeline/AssetSelectControlBar.svelte';
  import { AssetAction } from '$lib/constants';
  import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
  import type { Viewport } from '$lib/managers/timeline-manager/types';
  import { getAssetBulkActions } from '$lib/services/asset.service';
  import { handleError } from '$lib/utils/handle-error';
  import { toTimelineAsset } from '$lib/utils/timeline-util';
  import { getBrowseLabelAssets, type AssetResponseDto } from '@immich/sdk';
  import { ActionButton, CommandPaletteDefaultProvider, IconButton, LoadingSpinner } from '@immich/ui';
  import { mdiDotsVertical, mdiSelectAll } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  const viewport: Viewport = $state({ width: 0, height: 0 });
  let gridElement: HTMLElement | undefined = $state();
  let assets = $state<AssetResponseDto[]>(data.items);
  let nextCursor = $state<string | null>(data.nextCursor);
  let isLoading = $state(false);

  const removeAssets = (assetIds: string[]) => {
    const assetIdSet = new Set(assetIds);
    assets = assets.filter((asset) => !assetIdSet.has(asset.id));
    assetMultiSelectManager.clear();
  };

  const handleSelectAll = () => {
    assetMultiSelectManager.selectAssets(assets.map((asset) => toTimelineAsset(asset)));
  };

  const loadNextPage = async () => {
    if (!nextCursor || isLoading) {
      return;
    }
    isLoading = true;
    try {
      const page = await getBrowseLabelAssets({ key: data.key, cursor: nextCursor });
      assets.push(...page.items);
      nextCursor = page.nextCursor;
    } catch (error) {
      handleError(error, $t('loading_search_results_failed'));
    } finally {
      isLoading = false;
    }
  };
</script>

<UserPageLayout
  hideNavbar={assetMultiSelectManager.selectionActive}
  title={data.meta.title}
  description={$t('browse_label_assets_description')}
  scrollbar={false}
>
  <section
    class="m-4 mb-12 max-h-screen bg-immich-bg dark:bg-immich-dark-bg"
    bind:clientHeight={viewport.height}
    bind:clientWidth={viewport.width}
    bind:this={gridElement}
  >
    {#if data.loadError === 'disabled'}
      <EmptyPlaceholder title={$t('nothing_here_yet')} text={$t('browse_disabled_message')} class="mx-auto mt-10" />
    {:else if data.loadError}
      <EmptyPlaceholder title={$t('nothing_here_yet')} text={$t('browse_unavailable_message')} class="mx-auto mt-10" />
    {:else if assets.length > 0 || isLoading}
      <GalleryViewer
        {assets}
        assetInteraction={assetMultiSelectManager}
        onEndReached={loadNextPage}
        {viewport}
        removeAction={AssetAction.SET_VISIBILITY_HIDDEN}
        slidingWindowOffset={gridElement?.offsetTop ?? 0}
      />
      {#if isLoading}
        <div class="flex items-center justify-center py-8">
          <LoadingSpinner />
        </div>
      {/if}
    {:else}
      <EmptyPlaceholder title={$t('nothing_here_yet')} text={$t('browse_label_empty_message')} class="mx-auto mt-10" />
    {/if}
  </section>
</UserPageLayout>

{#if assetMultiSelectManager.selectionActive}
  <AssetSelectControlBar>
    {@const Actions = getAssetBulkActions($t)}
    <CommandPaletteDefaultProvider name={$t('assets')} actions={Object.values(Actions)} />
    <ActionButton action={Actions.CreateSharedLink} />
    <IconButton
      shape="round"
      color="secondary"
      variant="ghost"
      aria-label={$t('select_all')}
      icon={mdiSelectAll}
      onclick={handleSelectAll}
    />
    <ActionButton action={Actions.AddToAlbum} />
    {#if assetMultiSelectManager.isAllUserOwned}
      <FavoriteAction
        removeFavorite={assetMultiSelectManager.isAllFavorite}
        onFavorite={(ids, isFavorite) => {
          for (const id of ids) {
            const asset = assets.find((asset) => asset.id === id);
            if (asset) {
              asset.isFavorite = isFavorite;
            }
          }
        }}
      />
      <ButtonContextMenu icon={mdiDotsVertical} title={$t('menu')}>
        <DownloadAction menuItem />
        <ArchiveAction
          menuItem
          unarchive={assetMultiSelectManager.isAllArchived}
          onArchive={(ids) => {
            for (const id of ids) {
              const asset = assets.find((asset) => asset.id === id);
              if (asset) {
                asset.isArchived = !asset.isArchived;
              }
            }
            assetMultiSelectManager.clear();
          }}
        />
        <HideAction menuItem onVisibilitySet={removeAssets} />
        <SetVisibilityAction menuItem onVisibilitySet={removeAssets} />
        <DeleteAssets menuItem onAssetDelete={removeAssets} />
      </ButtonContextMenu>
    {:else}
      <DownloadAction />
    {/if}
  </AssetSelectControlBar>
{/if}
