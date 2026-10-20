<script lang="ts">
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import ButtonContextMenu from '$lib/components/shared-components/context-menu/ButtonContextMenu.svelte';
  import EmptyPlaceholder from '$lib/components/shared-components/EmptyPlaceholder.svelte';
  import GalleryViewer from '$lib/components/shared-components/gallery-viewer/GalleryViewer.svelte';
  import DeleteAssets from '$lib/components/timeline/actions/DeleteAssetsAction.svelte';
  import DownloadAction from '$lib/components/timeline/actions/DownloadAction.svelte';
  import FavoriteAction from '$lib/components/timeline/actions/FavoriteAction.svelte';
  import HideAction from '$lib/components/timeline/actions/HideAction.svelte';
  import AssetSelectControlBar from '$lib/components/timeline/AssetSelectControlBar.svelte';
  import { AssetAction } from '$lib/constants';
  import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
  import type { Viewport } from '$lib/managers/timeline-manager/types';
  import { getAssetBulkActions } from '$lib/services/asset.service';
  import { handleError } from '$lib/utils/handle-error';
  import { toTimelineAsset } from '$lib/utils/timeline-util';
  import { getHiddenAssets, type AssetResponseDto } from '@immich/sdk';
  import { ActionButton, CommandPaletteDefaultProvider, IconButton } from '@immich/ui';
  import { mdiDotsVertical, mdiSelectAll } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  const viewport: Viewport = $state({ width: 0, height: 0 });
  let hiddenGridElement: HTMLElement | undefined = $state();
  let assets = $state<AssetResponseDto[]>(data.assets);

  const removeAssets = (assetIds: string[]) => {
    const assetIdSet = new Set(assetIds);
    assets = assets.filter((asset) => !assetIdSet.has(asset.id));
    assetMultiSelectManager.clear();
  };

  const handleSelectAll = () => {
    assetMultiSelectManager.selectAssets(assets.map((asset) => toTimelineAsset(asset)));
  };

  const refresh = async () => {
    try {
      assets = await getHiddenAssets();
    } catch (error) {
      handleError(error, $t('errors.failed_to_load_hidden_assets'));
    }
  };
</script>

<UserPageLayout hideNavbar={assetMultiSelectManager.selectionActive} title={data.meta.title} scrollbar={false}>
  <section
    class="m-4 mb-12 max-h-screen bg-immich-bg dark:bg-immich-dark-bg"
    bind:clientHeight={viewport.height}
    bind:clientWidth={viewport.width}
    bind:this={hiddenGridElement}
  >
    {#if assets.length > 0}
      <GalleryViewer
        {assets}
        assetInteraction={assetMultiSelectManager}
        {viewport}
        removeAction={AssetAction.SET_VISIBILITY_TIMELINE}
        slidingWindowOffset={hiddenGridElement?.offsetTop ?? 0}
      />
    {:else}
      <EmptyPlaceholder
        title={$t('nothing_here_yet')}
        text={$t('no_hidden_assets_message')}
        class="mx-auto mt-10"
      />
    {/if}
  </section>
</UserPageLayout>

{#if assetMultiSelectManager.selectionActive}
  <AssetSelectControlBar>
    {@const Actions = getAssetBulkActions($t)}
    <CommandPaletteDefaultProvider name={$t('assets')} actions={Object.values(Actions)} />
    <HideAction unhide onVisibilitySet={removeAssets} />
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
      <DeleteAssets menuItem onAssetDelete={removeAssets} onUndoDelete={refresh} />
    </ButtonContextMenu>
  </AssetSelectControlBar>
{/if}
