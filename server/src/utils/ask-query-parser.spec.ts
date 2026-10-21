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
});
