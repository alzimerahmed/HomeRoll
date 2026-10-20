<script lang="ts">
  import MenuOption from '$lib/components/shared-components/context-menu/MenuOption.svelte';
  import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
  import type { OnArchive } from '$lib/utils/actions';
  import { handleError } from '$lib/utils/handle-error';
  import { AssetVisibility, updateAssets } from '@immich/sdk';
  import { Button, toastManager } from '@immich/ui';
  import { mdiEyeOffOutline, mdiEyeOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface Props {
    onVisibilitySet: OnArchive;
    menuItem?: boolean;
    unhide?: boolean;
  }

  let { onVisibilitySet, menuItem = false, unhide = false }: Props = $props();
  let loading = $state(false);

  let text = $derived(unhide ? $t('unhide') : $t('hide'));
  let icon = $derived(unhide ? mdiEyeOutline : mdiEyeOffOutline);

  const setHiddenVisibility = async () => {
    const visibility = unhide ? AssetVisibility.Timeline : AssetVisibility.Hidden;
    const assetIds = assetMultiSelectManager
      .getOwnedAssets()
      .filter((asset) => asset.visibility !== visibility)
      .map(({ id }) => id);

    if (assetIds.length === 0) {
      return;
    }

    try {
      loading = true;
      await updateAssets({ assetBulkUpdateDto: { ids: assetIds, visibility } });
      toastManager.primary(
        unhide
          ? $t('unhidden_count', { values: { count: assetIds.length } })
          : $t('hidden_count', { values: { count: assetIds.length } }),
      );
      onVisibilitySet(assetIds, visibility);
    } catch (error) {
      handleError(error, $t('errors.unable_to_save_settings'));
    } finally {
      loading = false;
    }
  };
</script>

{#if menuItem}
  <MenuOption onClick={setHiddenVisibility} {text} {icon} />
{:else}
  <Button
    leadingIcon={icon}
    disabled={loading}
    size="medium"
    color="secondary"
    variant="ghost"
    onclick={setHiddenVisibility}
  >
    {text}
  </Button>
{/if}
