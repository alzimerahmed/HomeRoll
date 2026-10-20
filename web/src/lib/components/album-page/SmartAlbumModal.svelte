<script lang="ts">
  import AlbumParentSelect from '$lib/components/album-page/AlbumParentSelect.svelte';
  import SmartAlbumRulesEditor from '$lib/components/album-page/SmartAlbumRulesEditor.svelte';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import { AlbumType, createAlbum, updateAlbumInfo, type AlbumResponseDto, type SmartAlbumRulesDto } from '@immich/sdk';
  import { Field, FormModal, Input, Text } from '@immich/ui';
  import { mdiAutoFix } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    /** When set, edits that smart album (name, parent and rules); otherwise creates a new smart album. */
    album?: AlbumResponseDto;
    /** Resolves with the created/updated album, or `undefined` when cancelled. */
    onClose: (album?: AlbumResponseDto) => void;
  };

  let { album, onClose }: Props = $props();

  let albumName = $state(album?.albumName ?? '');
  let parentId = $state<string | null>(album?.parentId ?? null);
  let rules = $state<SmartAlbumRulesDto>({ ...album?.rules });
  let rulesValid = $state(false);

  const canSubmit = $derived(albumName.trim().length > 0 && rulesValid);

  const onSubmit = async () => {
    try {
      if (album) {
        const updated = await updateAlbumInfo({
          id: album.id,
          updateAlbumDto: { albumName: albumName.trim(), parentId, rules },
        });
        eventManager.emit('AlbumUpdate', updated);
        onClose(updated);
      } else {
        const created = await createAlbum({
          createAlbumDto: {
            albumName: albumName.trim(),
            parentId: parentId ?? undefined,
            albumType: AlbumType.Smart,
            rules,
          },
        });
        eventManager.emit('AlbumCreate', created);
        onClose(created);
      }
    } catch (error) {
      handleError(error, $t(album ? 'errors.unable_to_update_album_info' : 'errors.failed_to_create_album'));
    }
  };
</script>

<FormModal
  icon={mdiAutoFix}
  title={album ? $t('edit_smart_album') : $t('new_smart_album')}
  size="giant"
  onClose={() => onClose()}
  {onSubmit}
  disabled={!canSubmit}
  submitText={$t(album ? 'save' : 'create')}
>
  <div class="flex flex-col gap-4">
    <Field label={$t('name')} required>
      <Input bind:value={albumName} />
    </Field>

    <Field label={$t('parent_album')}>
      <AlbumParentSelect excludeAlbum={album} bind:parentId />
    </Field>

    <Field label={$t('smart_album_rules')} required>
      <Text size="small" color="muted" class="mb-1">{$t('smart_album_rules_description')}</Text>
      <SmartAlbumRulesEditor bind:rules bind:valid={rulesValid} />
    </Field>
  </div>
</FormModal>
