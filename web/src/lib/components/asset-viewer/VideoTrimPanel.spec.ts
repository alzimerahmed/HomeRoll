import { render, screen } from '@testing-library/svelte';
import VideoTrimPanel from '$lib/components/asset-viewer/VideoTrimPanel.svelte';
import { clampTrimRange, formatTrimTime, isValidTrimRange } from '$lib/utils/video-trim-utils';

vi.mock('$lib/services/homeroll-api', () => ({
  trimVideo: vi.fn().mockResolvedValue({ assetId: 'new-asset' }),
}));

const makeVideo = (duration: number) =>
  ({
    duration,
    readyState: HTMLMediaElement.HAVE_METADATA,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    currentTime: 0,
    paused: true,
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
  }) as unknown as HTMLVideoElement;

describe('VideoTrimPanel', () => {
  it('renders the trim controls with a11y labels', () => {
    render(VideoTrimPanel, {
      props: { video: makeVideo(60), assetId: 'asset-1', onClose: () => {} },
    });

    expect(screen.getByLabelText('Trim start')).toBeDefined();
    expect(screen.getByLabelText('Trim end')).toBeDefined();
    expect(screen.getByRole('dialog', { name: 'Trim video' })).toBeDefined();
  });
});

describe('trim utils (shared with the panel)', () => {
  it('clamps ranges into the valid window', () => {
    expect(clampTrimRange({ start: -5, end: 999 }, 60)).toEqual({ start: 0, end: 60 });
  });

  it('validates ranges', () => {
    expect(isValidTrimRange({ start: 2, end: 10 }, 60)).toBe(true);
    expect(isValidTrimRange({ start: 10, end: 2 }, 60)).toBe(false);
  });

  it('formats timestamps', () => {
    expect(formatTrimTime(61.25)).toBe('1:01.2');
  });
});
