<script lang="ts">
  import Combobox, { type ComboBoxOption } from '$lib/components/shared-components/Combobox.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import { buildAlbumTree, getAlbumDescendantIds, type AlbumTreeNode } from '$lib/utils/album-tree';
  import { getAllAlbums, type AlbumResponseDto } from '@immich/sdk';
  import { LoadingSpinner } from '@immich/ui';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    /** The album being moved/edited — it and its descendants are excluded from the options. */
    excludeAlbum?: AlbumResponseDto;
    /** Current parent selection; `null` = root level. */
    parentId?: string | null;
    /** Pre-fetched album list; owned albums are loaded otherwise. */
    albums?: AlbumResponseDto[];
  };

  let { excludeAlbum, parentId = $bindable(null), albums: prefetchedAlbums }: Props = $props();

  const NO_PARENT_VALUE = '';

  let albums = $state<AlbumResponseDto[]>([]);
  let loading = $state(true);
  let selectedOption: ComboBoxOption | undefined = $state();

  onMount(async () => {
    try {
      albums = prefetchedAlbums ?? (await getAllAlbums({ isOwned: true }));
    } catch (error) {
      handleError(error, $t('errors.unable_to_get_albums'));
    } finally {
      loading = false;
    }
  });

  const options = $derived.by((): ComboBoxOption[] => {
    const excludedIds = excludeAlbum ? getAlbumDescendantIds(excludeAlbum.id, albums) : new Set<string>();
    if (excludeAlbum) {
      excludedIds.add(excludeAlbum.id);
    }

    const result: ComboBoxOption[] = [{ label: $t('album_parent_none'), value: NO_PARENT_VALUE }];
    const flatten = (nodes: AlbumTreeNode[], depth: number) => {
      for (const node of nodes) {
        if (!excludedIds.has(node.album.id)) {
          result.push({
            label: `${'— '.repeat(depth)}${node.album.albumName || $t('unnamed_album')}`,
            value: node.album.id,
          });
          flatten(node.children, depth + 1);
        }
      }
    };
    flatten(buildAlbumTree(albums), 0);
    return result;
  });

  let selectionInitialized = false;
  $effect(() => {
    if (!selectionInitialized && !loading) {
      selectionInitialized = true;
      selectedOption = options.find((option) => option.value === (parentId ?? NO_PARENT_VALUE)) ?? options[0];
    }
  });

  const handleSelect = (option?: ComboBoxOption) => {
    parentId = option && option.value !== NO_PARENT_VALUE ? option.value : null;
  };
</script>

{#if loading}
  <div class="flex justify-center p-2">
    <LoadingSpinner />
  </div>
{:else}
  <Combobox
    label={$t('parent_album')}
    hideLabel
    {options}
    bind:selectedOption
    placeholder={$t('search_albums')}
    onSelect={handleSelect}
  />
{/if}
