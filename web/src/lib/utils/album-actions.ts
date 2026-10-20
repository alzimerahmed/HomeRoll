import { goto } from '$app/navigation';
import AlbumMoveModal from '$lib/components/album-page/AlbumMoveModal.svelte';
import SmartAlbumModal from '$lib/components/album-page/SmartAlbumModal.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { Route } from '$lib/route';
import { handleUpdateAlbum, isAlbumEditor, isAlbumOwner } from '$lib/services/album.service';
import { handleError } from '$lib/utils/handle-error';
import { getFormatter } from '$lib/utils/i18n';
import { isSmartAlbum } from '$lib/utils/smart-album';
import {
  createAlbum,
  refreshSmartAlbum,
  updateAlbumInfo,
  type AlbumResponseDto,
} from '@immich/sdk';
import { modalManager, toastManager, type ActionItem } from '@immich/ui';
import {
  mdiAutoFix,
  mdiFolderMoveOutline,
  mdiFolderPlusOutline,
  mdiRefresh,
  mdiSwapHorizontal,
} from '@mdi/js';
import type { MessageFormatter } from 'svelte-i18n';

/**
 * Action handlers for the nested album hierarchy (FG-07) and smart albums
 * (FG-06). Kept next to `album.service.ts` semantics: handlers emit the same
 * `AlbumCreate`/`AlbumUpdate` events so every open view stays consistent.
 */

/** Opens the parent-album picker and reparents the album when confirmed. */
export const handleMoveAlbum = async (album: AlbumResponseDto) => {
  const parentId = await modalManager.show(AlbumMoveModal, { album });
  // `undefined` = cancelled, `null` = move to the root level.
  if (parentId === undefined || parentId === album.parentId) {
    return;
  }
  await handleUpdateAlbum(album, { parentId });
};

/** Creates an empty child album under `album` and opens it for naming. */
export const handleCreateChildAlbum = async (album: AlbumResponseDto) => {
  const $t = await getFormatter();
  try {
    const child = await createAlbum({ createAlbumDto: { albumName: '', parentId: album.id } });
    eventManager.emit('AlbumCreate', child);
    await goto(Route.viewAlbum(child));
  } catch (error) {
    handleError(error, $t('errors.failed_to_create_album'));
  }
};

/** Recomputes smart album membership via `POST /albums/{id}/refresh`. */
export const handleRefreshSmartAlbum = async (album: AlbumResponseDto) => {
  const $t = await getFormatter();
  try {
    const updated = await refreshSmartAlbum({ id: album.id });
    eventManager.emit('AlbumUpdate', updated);
    toastManager.primary($t('smart_album_refreshed'));
    return updated;
  } catch (error) {
    handleError(error, $t('errors.unable_to_refresh_smart_album'));
  }
};

/** Converts a smart album back to a manual album (`rules: null` freezes membership). */
export const handleConvertToManualAlbum = async (album: AlbumResponseDto) => {
  const $t = await getFormatter();
  const confirmed = await modalManager.showDialog({
    title: $t('convert_to_manual_album'),
    prompt: $t('convert_to_manual_album_prompt'),
    confirmText: $t('convert'),
  });
  if (!confirmed) {
    return;
  }

  try {
    const updated = await updateAlbumInfo({ id: album.id, updateAlbumDto: { rules: null } });
    eventManager.emit('AlbumUpdate', updated);
    toastManager.primary($t('album_info_updated'));
  } catch (error) {
    handleError(error, $t('errors.unable_to_update_album_info'));
  }
};

/** Opens the smart album editor for a new (undefined) or existing smart album. */
export const openSmartAlbumModal = (album?: AlbumResponseDto) => modalManager.show(SmartAlbumModal, { album });

/** Create flow for smart albums launched from the albums page toolbar. */
export const createSmartAlbumAndRedirect = async () => {
  const album = await openSmartAlbumModal();
  if (album) {
    await goto(Route.viewAlbum(album));
  }
};

/**
 * Extra context/menu actions for the album hierarchy. Visibility is gated via
 * `$if` — reparenting requires owner-level permission on the server.
 */
export const getAlbumHierarchyActions = ($t: MessageFormatter, album: AlbumResponseDto) => {
  const isOwned = isAlbumOwner(album);
  const isEditor = isAlbumEditor(album);

  const Move: ActionItem = {
    title: $t('move_album'),
    icon: mdiFolderMoveOutline,
    $if: () => isOwned,
    onAction: () => handleMoveAlbum(album),
  };

  const CreateChild: ActionItem = {
    title: $t('new_child_album'),
    icon: mdiFolderPlusOutline,
    $if: () => isEditor,
    onAction: () => handleCreateChildAlbum(album),
  };

  return { Move, CreateChild };
};

/**
 * Extra context/menu actions for smart albums: edit rules, manual refresh and
 * conversion back to a manual album.
 */
export const getSmartAlbumActions = ($t: MessageFormatter, album: AlbumResponseDto) => {
  const isOwned = isAlbumOwner(album);
  const isEditor = isAlbumEditor(album);
  const smart = isSmartAlbum(album);

  const EditRules: ActionItem = {
    title: $t('edit_rules'),
    icon: mdiAutoFix,
    $if: () => isOwned && smart,
    onAction: () => openSmartAlbumModal(album),
  };

  const Refresh: ActionItem = {
    title: $t('refresh_smart_album'),
    icon: mdiRefresh,
    $if: () => isEditor && smart,
    onAction: () => handleRefreshSmartAlbum(album),
  };

  const ConvertToManual: ActionItem = {
    title: $t('convert_to_manual_album'),
    icon: mdiSwapHorizontal,
    $if: () => isOwned && smart,
    onAction: () => handleConvertToManualAlbum(album),
  };

  return { EditRules, Refresh, ConvertToManual };
};
