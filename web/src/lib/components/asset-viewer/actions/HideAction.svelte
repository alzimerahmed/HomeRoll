<script lang="ts">
  import MenuOption from '$lib/components/shared-components/context-menu/MenuOption.svelte';
  import { AssetAction } from '$lib/constants';
  import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
  import { handleError } from '$lib/utils/handle-error';
  import { AssetVisibility, updateAssets } from '@immich/sdk';
  import { toastManager } from '@immich/ui';
  import { mdiEyeOffOutline, mdiEyeOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import type { OnAction, PreAction } from './action';

  interface Props {
    asset: TimelineAsset;
    onAction: OnAction;
    preAction: PreAction;
  }

  let { asset, onAction, preAction }: Props = $props();
  const isHidden = asset.visibility === AssetVisibility.Hidden;
  const type = isHidden ? AssetAction.SET_VISIBILITY_TIMELINE : AssetAction.SET_VISIBILITY_HIDDEN;
  const visibility = isHidden ? AssetVisibility.Timeline : AssetVisibility.Hidden;

  const toggleHiddenVisibility = async () => {
    try {
      preAction({ type, asset });

      await updateAssets({
        assetBulkUpdateDto: {
          ids: [asset.id],
          visibility,
        },
      });

      toastManager.primary(
        isHidden ? $t('unhidden_count', { values: { count: 1 } }) : $t('hidden_count', { values: { count: 1 } }),
      );
      onAction({ type, asset });
    } catch (error) {
      handleError(error, $t('errors.unable_to_save_settings'));
    }
  };
</script>

<MenuOption
  onClick={() => toggleHiddenVisibility()}
  text={isHidden ? $t('unhide') : $t('hide')}
  icon={isHidden ? mdiEyeOutline : mdiEyeOffOutline}
/>
