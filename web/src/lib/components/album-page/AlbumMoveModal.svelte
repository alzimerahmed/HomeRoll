<script lang="ts">
  import AlbumParentSelect from '$lib/components/album-page/AlbumParentSelect.svelte';
  import type { AlbumResponseDto } from '@immich/sdk';
  import { Field, FormModal } from '@immich/ui';
  import { mdiFolderMoveOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    album: AlbumResponseDto;
    /** Resolves with the new parent ID, `null` for the root level, or `undefined` when cancelled. */
    onClose: (parentId?: string | null) => void;
  };

  let { album, onClose }: Props = $props();

  let parentId: string | null = $state(album.parentId);

  const onSubmit = () => {
    onClose(parentId === album.parentId ? undefined : parentId);
  };
</script>

<FormModal
  icon={mdiFolderMoveOutline}
  title={$t('move_album')}
  size="small"
  onClose={() => onClose()}
  {onSubmit}
  submitText={$t('move')}
>
  <Field label={$t('parent_album')}>
    <AlbumParentSelect excludeAlbum={album} bind:parentId />
  </Field>
</FormModal>
