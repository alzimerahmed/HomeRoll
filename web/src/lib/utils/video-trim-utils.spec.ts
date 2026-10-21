import { describe, expect, it } from 'vitest';
import { clampTrimRange, formatTrimTime, isValidTrimRange } from '$lib/utils/video-trim-utils';

describe('clampTrimRange', () => {
  it('clamps to duration', () => {
    expect(clampTrimRange({ start: -1, end: 20 }, 10)).toEqual({ start: 0, end: 10 });
  });

  it('enforces a minimum gap', () => {
    expect(clampTrimRange({ start: 5, end: 5 }, 10)).toEqual({ start: 5, end: 5.1 });
    expect(clampTrimRange({ start: 9.95, end: 10 }, 10)).toEqual({ start: 9.9, end: 10 });
  });

  it('handles unknown duration (NaN) — collapses to a degenerate range that isValidTrimRange rejects', () => {
    expect(clampTrimRange({ start: 1, end: 2 }, Number.NaN)).toEqual({ start: 0, end: 0 });
    expect(isValidTrimRange(clampTrimRange({ start: 1, end: 2 }, Number.NaN), Number.NaN)).toBe(false);
  });
});

describe('isValidTrimRange', () => {
  it('accepts a normal range', () => {
    expect(isValidTrimRange({ start: 1, end: 4 }, 10)).toBe(true);
  });

  it('rejects inverted, zero-length, or out-of-bounds ranges', () => {
    expect(isValidTrimRange({ start: 4, end: 1 }, 10)).toBe(false);
    expect(isValidTrimRange({ start: 1, end: 1 }, 10)).toBe(false);
    expect(isValidTrimRange({ start: 1, end: 11 }, 10)).toBe(false);
    expect(isValidTrimRange({ start: -1, end: 4 }, 10)).toBe(false);
  });
});

describe('formatTrimTime', () => {
  it('formats seconds', () => {
    expect(formatTrimTime(0)).toBe('0:00.0');
    expect(formatTrimTime(65.42)).toBe('1:05.4');
    expect(formatTrimTime(3675.5)).toBe('1:01:15.5');
  });

  it('handles invalid input', () => {
    expect(formatTrimTime(Number.NaN)).toBe('0:00');
    expect(formatTrimTime(-3)).toBe('0:00');
  });
});
