/** Clamp helpers for the video trim range selection (FG-15). */

export interface TrimRange {
  start: number;
  end: number;
}

/** Clamps a trim range to the video duration and keeps start ≤ end (with a minimum gap). */
export const clampTrimRange = (range: TrimRange, duration: number, minGap = 0.1): TrimRange => {
  const max = Number.isFinite(duration) && duration > 0 ? duration : 0;
  let start = Math.min(Math.max(range.start, 0), max);
  let end = Math.min(Math.max(range.end, 0), max);
  if (end - start < minGap) {
    if (start + minGap <= max) {
      end = Math.min(start + minGap, max);
    } else {
      start = Math.max(end - minGap, 0);
    }
  }
  return { start, end };
};

/** True when the range is a valid, non-degenerate selection. */
export const isValidTrimRange = (range: TrimRange, duration: number): boolean => {
  return (
    Number.isFinite(range.start) &&
    Number.isFinite(range.end) &&
    range.start >= 0 &&
    range.end > range.start &&
    range.end <= duration
  );
};

/** Formats seconds as an `h:mm:ss.d`-style timestamp for trim labels. */
export const formatTrimTime = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '0:00';
  }
  const total = Math.floor(seconds);
  const tenths = Math.floor((seconds - total) * 10);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
  const ss = String(secs).padStart(2, '0');
  return `${hours > 0 ? `${hours}:` : ''}${mm}:${ss}.${tenths}`;
};
