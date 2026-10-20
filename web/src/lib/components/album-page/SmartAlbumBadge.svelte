<script lang="ts">
  import { Icon } from '@immich/ui';
  import { mdiAutoFix } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    /** Icon-only variant for dense surfaces like cover cards and tree rows. */
    iconOnly?: boolean;
  };

  let { iconOnly = false }: Props = $props();
</script>

<span
  class="inline-flex shrink-0 items-center gap-1 rounded-full border border-subtle bg-subtle px-2 py-0.5 text-xs font-medium text-primary"
  title={$t('smart_album')}
>
  <Icon icon={mdiAutoFix} size="14" aria-hidden="true" />
  {#if !iconOnly}
    <span>{$t('smart_album')}</span>
  {/if}
</span>
