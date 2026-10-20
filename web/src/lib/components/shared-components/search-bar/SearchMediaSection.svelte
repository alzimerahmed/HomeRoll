<script lang="ts">
  import { MediaType } from '$lib/constants';
  import { Text } from '@immich/ui';
  import { t } from 'svelte-i18n';
  import { searchManager } from '$lib/managers/search-manager.svelte';
  import { AssetOrientation } from '@immich/sdk';
  import SearchButton from './SearchButton.svelte';

  let filteredMedia = $derived(searchManager.filter.mediaType);
  let filteredOrientation = $derived(searchManager.filter.orientation);

  const orientations = [
    { value: AssetOrientation.Landscape, label: 'orientation_landscape' },
    { value: AssetOrientation.Portrait, label: 'orientation_portrait' },
    { value: AssetOrientation.Square, label: 'orientation_square' },
  ] as const;

  const toggleOrientation = (value: AssetOrientation) => {
    searchManager.filter.orientation = filteredOrientation === value ? undefined : value;
  };
</script>

<div id="media-type-selection">
  <fieldset>
    <Text class="pb-5">{$t('media_type_description')}</Text>

    <div class="flex flex-wrap gap-2">
      <SearchButton
        checked
        active={filteredMedia === MediaType.All}
        onclick={() => (searchManager.filter.mediaType = MediaType.All)}
      >
        {$t('all')}
      </SearchButton>
      <SearchButton
        checked
        active={filteredMedia === MediaType.Image}
        onclick={() => (searchManager.filter.mediaType = MediaType.Image)}
      >
        {$t('image')}
      </SearchButton>
      <SearchButton
        checked
        active={filteredMedia === MediaType.Video}
        onclick={() => (searchManager.filter.mediaType = MediaType.Video)}
      >
        {$t('video')}
      </SearchButton>
    </div>
  </fieldset>
</div>

<div id="media-orientation-selection" class="pt-5">
  <fieldset>
    <Text class="pb-5">{$t('orientation')}</Text>

    <div class="flex flex-wrap gap-2">
      {#each orientations as orientation (orientation.value)}
        <SearchButton
          checked
          active={filteredOrientation === orientation.value}
          onclick={() => toggleOrientation(orientation.value)}
        >
          {$t(orientation.label)}
        </SearchButton>
      {/each}
    </div>
  </fieldset>
</div>
