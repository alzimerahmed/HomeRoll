import { findSidecarJson, getSidecarCandidates, getSidecarMediaName, matchSidecar, parseTakeoutJson } from 'src/utils/takeout-json.js';

describe('takeout json utils', () => {
  describe('getSidecarMediaName', () => {
    it('should strip the supplemental metadata suffix', () => {
      expect(getSidecarMediaName('IMG_1234.jpg.supplemental-metadata.json')).toBe('IMG_1234.jpg');
    });

    it('should strip a truncated supplemental suffix', () => {
      expect(getSidecarMediaName('IMG_1234.jpg.supplemental-metada.json')).toBe('IMG_1234.jpg');
      expect(getSidecarMediaName('IMG_1234.jpg.supplemental-.json')).toBe('IMG_1234.jpg');
    });

    it('should handle plain .json sidecars', () => {
      expect(getSidecarMediaName('IMG_1234.jpg.json')).toBe('IMG_1234.jpg');
    });

    it('should return null for non-json files', () => {
      expect(getSidecarMediaName('IMG_1234.jpg')).toBeNull();
    });
  });

  describe('getSidecarCandidates', () => {
    it('should include the standard and plain variants', () => {
      expect(getSidecarCandidates('IMG_1234.jpg')).toEqual([
        'IMG_1234.jpg.supplemental-metadata.json',
        'IMG_1234.jpg.json',
      ]);
    });

    it('should include a truncated candidate for long names', () => {
      const name = `${'x'.repeat(60)}.jpg`;
      expect(getSidecarCandidates(name)).toContain(`${'x'.repeat(46)}.json`);
    });

    it('should include the duplicate-numbering variant', () => {
      expect(getSidecarCandidates('IMG_1234(1).jpg')).toContain('IMG_1234.jpg(1).json');
    });
  });

  describe('matchSidecar', () => {
    it('should match the standard naming scheme', () => {
      expect(matchSidecar('IMG_1234.jpg', 'IMG_1234.jpg.supplemental-metadata.json')).toBe(true);
    });

    it('should match duplicate-numbered media', () => {
      expect(matchSidecar('IMG_1234(1).jpg', 'IMG_1234(1).jpg.supplemental-metadata.json')).toBe(true);
    });

    it('should match truncated sidecar names by prefix', () => {
      const media = `${'x'.repeat(60)}.jpg`;
      expect(matchSidecar(media, `${'x'.repeat(46)}.json`)).toBe(true);
    });

    it('should not match unrelated files', () => {
      expect(matchSidecar('IMG_1234.jpg', 'IMG_5678.jpg.supplemental-metadata.json')).toBe(false);
      // a short prefix is not treated as a truncated name
      expect(matchSidecar('IMG_1234.jpg', 'IMG.json')).toBe(false);
    });
  });

  describe('findSidecarJson', () => {
    it('should find the matching sidecar among directory entries', () => {
      const jsons = new Set(['other.jpg.supplemental-metadata.json', 'IMG_1234.jpg.supplemental-metadata.json']);
      expect(findSidecarJson('IMG_1234.jpg', jsons)).toBe('IMG_1234.jpg.supplemental-metadata.json');
    });

    it('should return undefined when there is no sidecar', () => {
      expect(findSidecarJson('IMG_1234.jpg', new Set(['other.jpg.json']))).toBeUndefined();
      expect(findSidecarJson('IMG_1234.jpg', [])).toBeUndefined();
    });
  });

  describe('parseTakeoutJson', () => {
    it('should parse a complete sidecar', () => {
      const metadata = parseTakeoutJson({
        title: 'My Photo.jpg',
        description: 'at the beach',
        photoTakenTime: { timestamp: '1600000000', formatted: 'Sep 13, 2020' },
        geoData: { latitude: 10.5, longitude: -20.25, altitude: 15 },
        geoDataExif: { latitude: 0, longitude: 0, altitude: 0 },
        people: [{ name: 'Alice' }, { name: 'Bob' }],
      });

      expect(metadata).toEqual({
        title: 'My Photo.jpg',
        description: 'at the beach',
        takenAt: new Date(1_600_000_000_000),
        geo: { latitude: 10.5, longitude: -20.25, altitude: 15 },
        people: ['Alice', 'Bob'],
      });
    });

    it('should fall back to geoDataExif and creationTime', () => {
      const metadata = parseTakeoutJson({
        photoTakenTime: { timestamp: '0' },
        creationTime: { timestamp: '1500000000' },
        geoData: { latitude: 0, longitude: 0, altitude: 0 },
        geoDataExif: { latitude: 48.8, longitude: 2.3 },
      });

      expect(metadata?.takenAt).toEqual(new Date(1_500_000_000_000));
      expect(metadata?.geo).toEqual({ latitude: 48.8, longitude: 2.3 });
    });

    it('should ignore a zeroed geo location', () => {
      const metadata = parseTakeoutJson({
        photoTakenTime: { timestamp: '1600000000' },
        geoData: { latitude: 0, longitude: 0, altitude: 0 },
      });

      expect(metadata?.geo).toBeUndefined();
    });

    it('should reject out-of-range coordinates', () => {
      const metadata = parseTakeoutJson({
        photoTakenTime: { timestamp: '1600000000' },
        geoData: { latitude: 91, longitude: 0.1 },
      });

      expect(metadata?.geo).toBeUndefined();
    });

    it('should return null for documents without usable metadata', () => {
      expect(parseTakeoutJson(null)).toBeNull();
      expect(parseTakeoutJson('string')).toBeNull();
      expect(parseTakeoutJson({})).toBeNull();
      expect(parseTakeoutJson({ albums: [] })).toBeNull();
    });
  });
});
