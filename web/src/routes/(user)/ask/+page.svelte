<script lang="ts">
  import { goto } from '$app/navigation';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import EmptyPlaceholder from '$lib/components/shared-components/EmptyPlaceholder.svelte';
  import GalleryViewer from '$lib/components/shared-components/gallery-viewer/GalleryViewer.svelte';
  import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
  import { askHomeRoll, type AskResponseDto } from '$lib/services/homeroll-api';
  import { Route } from '$lib/route';
  import { interpretationToChips, interpretationToSearchDto, type AskChip } from '$lib/utils/ask-utils';
  import { handleError } from '$lib/utils/handle-error';
  import type { AssetResponseDto } from '@immich/sdk';
  import { Icon, LoadingSpinner } from '@immich/ui';
  import { mdiChatQuestionOutline, mdiMagnify, mdiSend } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  // the page scrolls the document, so the viewer's visible window is the
  // browser viewport — binding the (content-driven) section height here would
  // be circular and could stay 0
  const viewport: { width: number; height: number } = $state({ width: 0, height: 0 });
  $effect(() => {
    viewport.height = window.innerHeight;
  });

  let question = $state('');
  let isLoading = $state(false);
  let hasError = $state(false);
  let hasAsked = $state(false);
  let result: AskResponseDto | undefined = $state();
  let chips: AskChip[] = $state([]);
  let assets: AssetResponseDto[] = $state([]);

  const ask = async () => {
    const trimmed = question.trim();
    if (!trimmed || isLoading) {
      return;
    }

    isLoading = true;
    hasError = false;
    hasAsked = true;
    result = undefined;
    chips = [];
    assets = [];

    try {
      result = await askHomeRoll(trimmed);
      chips = interpretationToChips(result.interpretation);
      assets = result.assets;
    } catch (error) {
      hasError = true;
      handleError(error, $t('ask_failed'));
    } finally {
      isLoading = false;
    }
  };

  const onSearchTheseFilters = () => {
    if (!result) {
      return;
    }
    void goto(Route.search(interpretationToSearchDto(result.interpretation)));
  };

  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      void ask();
    }
  };
</script>

<UserPageLayout title={data.meta.title} description={$t('ask_description')}>
  <section class="mx-auto w-full max-w-3xl px-4">
    <form
      class="flex items-center gap-2 rounded-xl border border-subtle bg-subtle p-2"
      onsubmit={(event) => {
        event.preventDefault();
        void ask();
      }}
    >
      <label class="sr-only" for="ask-input">{$t('ask')}</label>
      <Icon icon={mdiChatQuestionOutline} class="ms-2 shrink-0 text-primary" size="24" aria-hidden />
      <input
        id="ask-input"
        type="text"
        class="w-full bg-transparent px-2 py-2 text-base outline-none placeholder:text-subtle"
        placeholder={$t('ask_placeholder')}
        autocomplete="off"
        bind:value={question}
        onkeydown={onKeydown}
      />
      <button
        type="submit"
        class="flex shrink-0 items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-light disabled:opacity-50 dark:bg-immich-dark-primary dark:text-immich-dark-gray"
        disabled={isLoading || question.trim().length === 0}
      >
        {#if isLoading}
          <LoadingSpinner size="tiny" />
        {:else}
          <Icon icon={mdiSend} size="18" aria-hidden />
        {/if}
        <span class="hidden sm:inline">{$t('ask')}</span>
      </button>
    </form>
  </section>

  <section class="mx-auto mt-6 w-full max-w-7xl px-4">
    {#if isLoading}
      <div class="flex flex-col items-center justify-center py-16" role="status">
        <LoadingSpinner size="giant" />
        <p class="mt-4 text-sm text-subtle">{$t('ask_thinking')}</p>
      </div>
    {:else if hasError}
      <EmptyPlaceholder title={$t('error')} text={$t('ask_failed')} class="mx-auto mt-10" />
    {:else if result}
      <div class="rounded-xl border border-subtle bg-subtle p-4">
        <p class="text-base">{$t('ask_answer')}</p>
        <p class="mt-1 text-xs text-subtle">
          {$t(result.provider === 'llm' ? 'ask_provider_llm' : 'ask_provider_structured')}
        </p>
        <p class="mt-1 text-sm text-subtle">
          {$t('ask_results_count', { values: { total: result.total, shown: result.assets.length } })}
        </p>
        {#if chips.length > 0}
          <div class="mt-3 flex flex-wrap items-center gap-2">
            {#each chips as chip (chip.key)}
              <span
                class="inline-flex items-center gap-1 rounded-full bg-primary/10 px-3 py-1 text-xs text-primary ring-1 ring-primary/15 dark:bg-immich-dark-primary/15 dark:text-immich-dark-primary dark:ring-immich-dark-primary/20"
              >
                <span class="font-medium">{$t(chip.label)}</span>
                <span class="max-w-40 truncate">{chip.value}</span>
              </span>
            {/each}
            <button
              type="button"
              class="inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs text-primary outline-offset-2 outline-primary hover:underline focus-visible:outline-2 dark:text-immich-dark-primary dark:outline-immich-dark-primary"
              onclick={onSearchTheseFilters}
            >
              <Icon icon={mdiMagnify} size="14" aria-hidden />
              {$t('ask_open_in_search')}
            </button>
          </div>
        {/if}
      </div>

      {#if assets.length > 0}
        <section class="mt-4" bind:clientWidth={viewport.width}>
          <GalleryViewer bind:assets assetInteraction={assetMultiSelectManager} {viewport} showArchiveIcon={true} />
        </section>
      {:else}
        <EmptyPlaceholder title={$t('no_results')} text={$t('no_results_description')} class="mx-auto mt-10" />
      {/if}
    {:else if hasAsked}
      <EmptyPlaceholder title={$t('no_results')} text={$t('no_results_description')} class="mx-auto mt-10" />
    {:else}
      <EmptyPlaceholder title={$t('ask')} text={$t('ask_hint')} class="mx-auto mt-10" />
    {/if}
  </section>
</UserPageLayout>
