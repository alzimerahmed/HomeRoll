<script lang="ts">
  import { Route } from '$lib/route';
  import type { AlbumResponseDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiChevronRight } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    ancestors: AlbumResponseDto[];
    currentName: string;
  };

  let { ancestors, currentName }: Props = $props();
</script>

<nav aria-label={$t('album_breadcrumb')} class="flex min-w-0 items-center gap-1 text-sm">
  <a href={Route.albums()} class="shrink-0 text-muted transition-colors hover:text-primary">
    {$t('albums')}
  </a>
  {#each ancestors as ancestor (ancestor.id)}
    <Icon icon={mdiChevronRight} size="16" class="shrink-0 text-muted" aria-hidden="true" />
    <a
      href={Route.viewAlbum(ancestor)}
      class="max-w-40 truncate text-muted transition-colors hover:text-primary"
      title={ancestor.albumName}
    >
      {ancestor.albumName || $t('unnamed_album')}
    </a>
  {/each}
  <Icon icon={mdiChevronRight} size="16" class="shrink-0 text-muted" aria-hidden="true" />
  <span class="max-w-60 truncate font-medium dark:text-white" aria-current="page">
    {currentName || $t('unnamed_album')}
  </span>
</nav>
