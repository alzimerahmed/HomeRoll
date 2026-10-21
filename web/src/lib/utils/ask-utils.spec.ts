import { describe, expect, it } from 'vitest';
import { interpretationToChips, interpretationToSearchDto } from '$lib/utils/ask-utils';

const full = {
  query: 'sunset at the beach',
  city: 'Lisbon',
  country: 'Portugal',
  takenAfter: '2024-06-01T00:00:00.000Z',
  takenBefore: '2024-08-31T23:59:59.999Z',
  mediaType: 'IMAGE' as const,
  favorited: true,
  ocr: 'welcome',
};

describe('interpretationToSearchDto', () => {
  it('maps all populated fields', () => {
    expect(interpretationToSearchDto(full)).toEqual({
      query: 'sunset at the beach',
      city: 'Lisbon',
      country: 'Portugal',
      takenAfter: '2024-06-01T00:00:00.000Z',
      takenBefore: '2024-08-31T23:59:59.999Z',
      type: 'IMAGE',
      isFavorite: true,
      ocr: 'welcome',
    });
  });

  it('drops null fields', () => {
    const empty = Object.fromEntries(Object.keys(full).map((key) => [key, null]));
    expect(interpretationToSearchDto(empty as never)).toEqual({});
  });

  it('does not map favorited=false', () => {
    expect(interpretationToSearchDto({ ...full, favorited: false })).not.toHaveProperty('isFavorite');
  });
});

describe('interpretationToChips', () => {
  it('creates one chip per non-null field', () => {
    const chips = interpretationToChips(full);
    expect(chips.map((chip) => chip.key)).toEqual([
      'query',
      'city',
      'country',
      'takenAfter',
      'takenBefore',
      'type',
      'isFavorite',
      'ocr',
    ]);
  });

  it('returns no chips for an empty interpretation', () => {
    const empty = Object.fromEntries(Object.keys(full).map((key) => [key, null]));
    expect(interpretationToChips(empty as never)).toEqual([]);
  });
});
