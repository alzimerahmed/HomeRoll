<script lang="ts">
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import { AutoCreationType, runAutoCreation } from '$lib/services/homeroll-api';
  import { Route } from '$lib/route';
  import { handleError } from '$lib/utils/handle-error';
  import { Button, Icon, toastManager } from '@immich/ui';
  import {
    mdiAnimationOutline,
    mdiCheckCircleOutline,
    mdiCollage,
    mdiMapMarkerRadiusOutline,
  } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  interface CreationCard {
    type: AutoCreationType;
    icon: string;
    titleKey: string;
    descriptionKey: string;
  }

  const cards: CreationCard[] = [
    {
      type: AutoCreationType.Collage,
      icon: mdiCollage,
      titleKey: 'collage',
      descriptionKey: 'auto_creations_collage_description',
    },
    {
      type: AutoCreationType.Animation,
      icon: mdiAnimationOutline,
      titleKey: 'animation',
      descriptionKey: 'auto_creations_animation_description',
    },
    {
      type: AutoCreationType.TripHighlights,
      icon: mdiMapMarkerRadiusOutline,
      titleKey: 'trip_highlights',
      descriptionKey: 'auto_creations_trip_description',
    },
  ];

  let running: AutoCreationType | null = $state(null);
  /** Queued creation types — presence is all the UI needs (honest shape, see anti-vibe audit M4). */
  let queued: Set<AutoCreationType> = $state(new Set());

  const run = async (card: CreationCard) => {
    if (running) {
      return;
    }

    running = card.type;
    try {
      await runAutoCreation(card.type);
      queued = new Set(queued).add(card.type);
      toastManager.primary($t('auto_creations_queued', { values: { type: $t(card.titleKey) } }));
    } catch (error) {
      handleError(error, $t('auto_creations_failed'));
    } finally {
      running = null;
    }
  };
</script>

<UserPageLayout title={data.meta.title} description={$t('auto_creations_description')}>
  <div class="mx-auto w-full max-w-3xl px-4">
    <p class="mb-4 text-sm text-subtle">{$t('auto_creations_hint')}</p>

    <ul class="grid gap-4 sm:grid-cols-3">
      {#each cards as card (card.type)}
        <li class="flex flex-col rounded-xl border border-subtle bg-subtle p-4">
          <Icon icon={card.icon} class="mb-3 text-primary" size="32" aria-hidden />
          <h2 class="text-base font-medium">{$t(card.titleKey)}</h2>
          <p class="mt-1 grow text-sm text-subtle">{$t(card.descriptionKey)}</p>

          <div class="mt-4">
            <Button
              size="small"
              shape="round"
              loading={running === card.type}
              onclick={() => run(card)}
              disabled={running !== null}
              aria-label={$t('auto_creations_run', { values: { type: $t(card.titleKey) } })}
            >
              {$t('auto_creations_run', { values: { type: $t(card.titleKey) } })}
            </Button>
          </div>

          {#if queued.has(card.type)}
            <p class="mt-3 flex items-center gap-1 text-sm text-subtle" aria-live="polite">
              <Icon icon={mdiCheckCircleOutline} size="14" aria-hidden />
              {$t('auto_creations_result_hint')}
            </p>
          {/if}
        </li>
      {/each}
    </ul>

    <div class="mt-4 flex flex-wrap gap-4 text-sm">
      <a class="text-[#774A0C] hover:underline dark:text-immich-dark-primary" href={Route.archive()}>{$t('archive')}</a>
      <a class="text-[#774A0C] hover:underline dark:text-immich-dark-primary" href={Route.albums()}>{$t('albums')}</a>
    </div>
  </div>
</UserPageLayout>
