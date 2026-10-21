import { parseAskQuery } from 'src/utils/ask-query-parser.js';

describe('parseAskQuery', () => {
  it('extracts year, media type and free text', () => {
    expect(parseAskQuery('Show me my dog photos from 2019')).toMatchObject({
      takenAfter: '2019-01-01T00:00:00.000Z',
      takenBefore: '2020-01-01T00:00:00.000Z',
      mediaType: 'IMAGE',
      query: 'dog',
    });
  });

  it('extracts videos and favorites', () => {
    expect(parseAskQuery('favorite videos of the beach')).toMatchObject({
      mediaType: 'VIDEO',
      favorited: true,
    });
  });

  it('extracts OCR text', () => {
    expect(parseAskQuery('a sign that says "OPEN" in the city')).toMatchObject({
      ocr: 'OPEN',
    });
  });

  it('extracts a capitalized place', () => {
    expect(parseAskQuery('photos in Paris')).toMatchObject({
      city: 'Paris',
    });
  });

  it('does not treat lowercase prepositional objects as places', () => {
    const parsed = parseAskQuery('photos at the beach');
    expect(parsed.city).toBeNull();
  });

  it('handles relative ranges', () => {
    const parsed = parseAskQuery('photos from last year');
    expect(parsed.takenAfter).not.toBeNull();
    expect(parsed.query).toBeNull();
  });

  it('rolls the year forward for winter ranges', () => {
    const parsed = parseAskQuery('photos from last winter');
    expect(parsed.takenAfter).toMatch(/-12-01T00:00:00\.000Z$/);
    expect(parsed.takenBefore).toMatch(/-03-01T00:00:00\.000Z$/);
    expect(new Date(parsed.takenBefore!).getTime()).toBeGreaterThan(new Date(parsed.takenAfter!).getTime());
  });

  it('keeps the remainder as the CLIP query', () => {
    expect(parseAskQuery('sunset over mountains')).toMatchObject({
      query: 'sunset over mountains',
      city: null,
      takenAfter: null,
    });
  });

  it('returns null query for fully structured questions', () => {
    expect(parseAskQuery('favorite videos in 2021')).toMatchObject({
      query: null,
      mediaType: 'VIDEO',
      favorited: true,
    });
  });

  it('combines month and explicit year', () => {
    expect(parseAskQuery('photos in June 2023')).toMatchObject({
      takenAfter: '2023-06-01T00:00:00.000Z',
      takenBefore: '2023-07-01T00:00:00.000Z',
    });
  });

  it('handles "back in <year>"', () => {
    expect(parseAskQuery('trips back in 2018')).toMatchObject({
      takenAfter: '2018-01-01T00:00:00.000Z',
      takenBefore: '2019-01-01T00:00:00.000Z',
    });
  });

  it('bounds yesterday to a single day', () => {
    const parsed = parseAskQuery('photos from yesterday');
    expect(parsed.takenAfter).not.toBeNull();
    expect(parsed.takenBefore).not.toBeNull();
    const span = new Date(parsed.takenBefore!).getTime() - new Date(parsed.takenAfter!).getTime();
    expect(span).toBe(24 * 60 * 60 * 1000);
  });

  it('extracts multi-word places', () => {
    expect(parseAskQuery('photos in New York')).toMatchObject({ city: 'New York' });
  });

  it('extracts OCR text after "with the words"', () => {
    expect(parseAskQuery('photos with the words EXIT')).toMatchObject({ ocr: 'EXIT' });
  });

  it('returns an empty parse for empty input', () => {
    expect(parseAskQuery('')).toMatchObject({
      query: null,
      city: null,
      takenAfter: null,
      mediaType: null,
      favorited: null,
      ocr: null,
    });
  });

  it('falls back to the raw remainder when every token is filler', () => {
    // 'show me all of my' are all filler words; the parser keeps the remainder
    // rather than returning a null query — documented fallback behavior
    const parsed = parseAskQuery('show me all of my photos');
    expect(parsed.mediaType).toBe('IMAGE');
    expect(parsed.query).toBe('show me all of my');
  });

  it('does not treat a bare lowercase monthless season word as a date', () => {
    const parsed = parseAskQuery('winter coats in the snow');
    expect(parsed.takenAfter).toBeNull();
  });
});
