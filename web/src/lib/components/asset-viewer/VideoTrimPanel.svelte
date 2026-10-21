<script lang="ts">
  import { trimVideo } from '$lib/services/homeroll-api';
  import { clampTrimRange, formatTrimTime, isValidTrimRange, type TrimRange } from '$lib/utils/video-trim-utils';
  import { handleError } from '$lib/utils/handle-error';
  import { Button, Icon, toastManager } from '@immich/ui';
  import { mdiContentSave, mdiPlay, mdiPause } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface Props {
    /** The live <video> element (or hls-video native element) to trim. */
    video: HTMLVideoElement;
    assetId: string;
    onClose: () => void;
  }

  let { video, assetId, onClose }: Props = $props();

  let duration = $state(0);
  let range: TrimRange = $state({ start: 0, end: 0 });
  let isSaving = $state(false);
  let isPreviewing = $state(false);
  let startSlider: HTMLInputElement | undefined = $state();

  // Esc closes the dialog; focus lands on the start slider when it opens
  $effect(() => {
    startSlider?.focus();
  });

  const onWindowKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };

  const onLoadedMetadata = () => {
    duration = video.duration;
    range = clampTrimRange({ start: 0, end: duration }, duration);
  };

  $effect(() => {
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
      onLoadedMetadata();
    } else {
      video.addEventListener('loadedmetadata', onLoadedMetadata, { once: true });
      return () => video.removeEventListener('loadedmetadata', onLoadedMetadata);
    }
  });

  const setStart = (event: Event) => {
    const value = Number((event.currentTarget as HTMLInputElement).value);
    range = clampTrimRange({ start: value, end: range.end }, duration);
    video.currentTime = range.start;
  };

  const setEnd = (event: Event) => {
    const value = Number((event.currentTarget as HTMLInputElement).value);
    range = clampTrimRange({ start: range.start, end: value }, duration);
    video.currentTime = range.end;
  };

  const previewRange = async () => {
    if (isPreviewing) {
      isPreviewing = false;
      video.pause();
      return;
    }

    isPreviewing = true;
    video.currentTime = range.start;
    try {
      await video.play();
    } catch {
      // autoplay refused — preview just won't run
      isPreviewing = false;
      return;
    }

    const onTimeUpdate = () => {
      if (!isPreviewing || video.currentTime >= range.end) {
        video.pause();
        video.removeEventListener('timeupdate', onTimeUpdate);
        isPreviewing = false;
      }
    };
    video.addEventListener('timeupdate', onTimeUpdate);
  };

  const save = async () => {
    if (!isValidTrimRange(range, duration) || isSaving) {
      toastManager.warning($t('trim_invalid_range'));
      return;
    }

    isSaving = true;
    try {
      await trimVideo(assetId, { startSeconds: range.start, endSeconds: range.end });
      toastManager.primary($t('trim_requested'));
      onClose();
    } catch (error) {
      handleError(error, $t('trim_unavailable'));
    } finally {
      isSaving = false;
    }
  };

  const reset = () => {
    range = clampTrimRange({ start: 0, end: duration }, duration);
  };
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div
  class="absolute inset-x-4 bottom-24 z-10 mx-auto max-w-xl rounded-xl border border-subtle bg-subtle p-4 shadow-lg"
  role="dialog"
  aria-label={$t('trim_video')}
>
  <h2 class="mb-3 text-sm font-medium">{$t('trim_video')}</h2>

  <div class="flex flex-col gap-3">
    <label class="flex items-center gap-2 text-xs text-subtle">
      <span class="w-14 shrink-0 font-mono tabular-nums">{formatTrimTime(range.start)}</span>
      <input
        bind:this={startSlider}
        type="range"
        class="w-full"
        min="0"
        max={duration}
        step="0.1"
        value={range.start}
        onchange={setStart}
        aria-label={$t('trim_start')}
      />
    </label>

    <label class="flex items-center gap-2 text-xs text-subtle">
      <span class="w-14 shrink-0 font-mono tabular-nums">{formatTrimTime(range.end)}</span>
      <input
        type="range"
        class="w-full"
        min="0"
        max={duration}
        step="0.1"
        value={range.end}
        onchange={setEnd}
        aria-label={$t('trim_end')}
      />
    </label>

    <p class="font-mono text-xs tabular-nums text-subtle">
      {$t('trim_duration', { values: { duration: formatTrimTime(range.end - range.start) } })}
    </p>

    <div class="flex items-center justify-end gap-2">
      <Button size="small" shape="round" variant="ghost" onclick={reset}>{$t('reset')}</Button>
      <Button size="small" shape="round" variant="ghost" leadingIcon={isPreviewing ? mdiPause : mdiPlay} onclick={() => void previewRange()}>
        {isPreviewing ? $t('stop_preview') : $t('trim_preview')}
      </Button>
      <Button size="small" shape="round" leadingIcon={mdiContentSave} loading={isSaving} onclick={() => void save()}>
        {$t('save_trimmed_copy')}
      </Button>
      <Button size="small" shape="round" variant="ghost" onclick={onClose}>{$t('cancel')}</Button>
    </div>
  </div>
</div>
