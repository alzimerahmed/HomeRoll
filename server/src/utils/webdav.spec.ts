import {
  assignDavNames,
  buildDavHref,
  buildLockResponse,
  buildMultistatus,
  encodeDavSegment,
  escapeXml,
  getDavSegments,
  parseDepthHeader,
  sanitizeDavName,
  toHttpDate,
  toIsoDate,
} from 'src/utils/webdav.js';

describe('webdav utils', () => {
  describe('escapeXml', () => {
    it('should escape all five predefined entities', () => {
      expect(escapeXml(`a&b<c>d"e'f`)).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f');
    });

    it('should leave plain text untouched', () => {
      expect(escapeXml('hello world')).toBe('hello world');
    });
  });

  describe('encodeDavSegment', () => {
    it('should percent-encode special characters', () => {
      expect(encodeDavSegment('a b&c.jpg')).toBe('a%20b%26c.jpg');
    });

    it('should encode UTF-8 characters', () => {
      expect(encodeDavSegment('日本語.jpg')).toBe(encodeURIComponent('日本語.jpg'));
    });

    it('should encode slashes inside a segment', () => {
      expect(encodeDavSegment('a/b')).toBe('a%2Fb');
    });
  });

  describe('buildDavHref', () => {
    it('should join base and segments', () => {
      expect(buildDavHref('/api/webdav', ['Libraries', 'a b.jpg'], false)).toBe('/api/webdav/Libraries/a%20b.jpg');
    });

    it('should append a trailing slash for collections', () => {
      expect(buildDavHref('/api/webdav', ['Albums'], true)).toBe('/api/webdav/Albums/');
    });

    it('should handle the root collection', () => {
      expect(buildDavHref('/api/webdav', [], true)).toBe('/api/webdav/');
    });

    it('should normalize a base href with a trailing slash', () => {
      expect(buildDavHref('/api/webdav/', [], true)).toBe('/api/webdav/');
    });
  });

  describe('date formatting', () => {
    const date = new Date('2026-01-02T03:04:05.678Z');

    it('should produce RFC 1123 dates', () => {
      expect(toHttpDate(date)).toBe('Fri, 02 Jan 2026 03:04:05 GMT');
    });

    it('should produce ISO dates', () => {
      expect(toIsoDate(date)).toBe('2026-01-02T03:04:05.678Z');
    });
  });

  describe('parseDepthHeader', () => {
    it('should return undefined when the header is absent', () => {
      expect(parseDepthHeader(undefined)).toBeUndefined();
    });

    it('should parse 0 and 1', () => {
      expect(parseDepthHeader('0')).toBe(0);
      expect(parseDepthHeader('1')).toBe(1);
    });

    it('should be case-insensitive for infinity', () => {
      expect(parseDepthHeader('infinity')).toBe('infinity');
      expect(parseDepthHeader('Infinity')).toBe('infinity');
    });

    it('should mark unknown values invalid', () => {
      expect(parseDepthHeader('2')).toBe('invalid');
      expect(parseDepthHeader('foo')).toBe('invalid');
    });

    it('should take the first value of multi-valued headers', () => {
      expect(parseDepthHeader(['1', '0'])).toBe(1);
    });
  });

  describe('getDavSegments', () => {
    it('should return an empty array for undefined', () => {
      expect(getDavSegments(undefined)).toEqual([]);
    });

    it('should pass through segment arrays', () => {
      expect(getDavSegments(['Libraries', 'a.jpg'])).toEqual(['Libraries', 'a.jpg']);
    });

    it('should drop empty and dot segments', () => {
      expect(getDavSegments(['Libraries', '', '.', 'a.jpg'])).toEqual(['Libraries', 'a.jpg']);
    });

    it('should split a plain string on slashes', () => {
      expect(getDavSegments('Libraries/a.jpg')).toEqual(['Libraries', 'a.jpg']);
    });

    it('should preserve traversal segments for the service to reject', () => {
      expect(getDavSegments(['..', 'etc'])).toEqual(['..', 'etc']);
    });
  });

  describe('sanitizeDavName', () => {
    it('should replace filesystem-hostile characters', () => {
      expect(sanitizeDavName('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j');
    });

    it('should strip trailing dots and spaces', () => {
      expect(sanitizeDavName('file. ')).toBe('file');
      expect(sanitizeDavName('name...')).toBe('name');
    });

    it('should return untitled for empty results', () => {
      expect(sanitizeDavName('')).toBe('untitled');
      expect(sanitizeDavName('  ')).toBe('untitled');
    });

    it('should keep normal names untouched', () => {
      expect(sanitizeDavName('IMG_0001.jpg')).toBe('IMG_0001.jpg');
    });
  });

  describe('assignDavNames', () => {
    it('should keep unique names', () => {
      const result = assignDavNames([
        { id: 'a', name: 'one.jpg' },
        { id: 'b', name: 'two.jpg' },
      ]);
      expect(result.map(({ name }) => name)).toEqual(['one.jpg', 'two.jpg']);
    });

    it('should suffix duplicates with a deterministic short id', () => {
      const result = assignDavNames([
        { id: '00000000-0000-4000-a000-000000000001', name: 'same.jpg' },
        { id: '00000000-0000-4000-a000-000000000002', name: 'same.jpg' },
      ]);
      expect(result[0].name).toBe('same.jpg');
      expect(result[1].name).toBe('same-00000000.jpg');
    });

    it('should dedupe names that sanitize identically', () => {
      const result = assignDavNames([
        { id: 'a', name: 'x/y.jpg' },
        { id: 'b', name: 'x_y.jpg' },
      ]);
      expect(result[0].name).not.toEqual(result[1].name);
    });

    it('should be deterministic for identical input', () => {
      const items = [
        { id: 'b', name: 'dup' },
        { id: 'a', name: 'dup' },
      ];
      expect(assignDavNames(items)).toEqual(assignDavNames(items));
    });
  });

  describe('buildMultistatus', () => {
    it('should produce a multistatus document with responses', () => {
      const xml = buildMultistatus('/api/webdav', [
        { segments: [], name: 'webdav', isCollection: true },
        {
          segments: ['Libraries', 'photo &1.jpg'],
          name: 'photo &1.jpg',
          isCollection: false,
          size: 123,
          mimeType: 'image/jpeg',
          etag: 'deadbeef',
          createdAt: new Date('2026-01-02T03:04:05Z'),
          modifiedAt: new Date('2026-01-02T03:04:05Z'),
        },
      ]);

      expect(xml).toContain('<D:multistatus xmlns:D="DAV:">');
      expect(xml).toContain('<D:href>/api/webdav/</D:href>');
      expect(xml).toContain('<D:collection/>');
      expect(xml).toContain('<D:href>/api/webdav/Libraries/photo%20%261.jpg</D:href>');
      expect(xml).toContain('<D:displayname>photo &amp;1.jpg</D:displayname>');
      expect(xml).toContain('<D:getcontentlength>123</D:getcontentlength>');
      expect(xml).toContain('<D:getcontenttype>image/jpeg</D:getcontenttype>');
      expect(xml).toContain('<D:getetag>"deadbeef"</D:getetag>');
      expect(xml).toContain('<D:getlastmodified>Fri, 02 Jan 2026 03:04:05 GMT</D:getlastmodified>');
      expect(xml).toContain('<D:creationdate>2026-01-02T03:04:05.000Z</D:creationdate>');
      expect(xml).toContain('<D:status>HTTP/1.1 200 OK</D:status>');
      expect(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>')).toBe(true);
    });

    it('should not emit file properties on collections', () => {
      const xml = buildMultistatus('/api/webdav', [
        { segments: ['Albums'], name: 'Albums', isCollection: true },
      ]);
      expect(xml).not.toContain('getcontentlength');
      expect(xml).not.toContain('getcontenttype');
      expect(xml).not.toContain('getetag');
      expect(xml).toContain('<D:resourcetype><D:collection/></D:resourcetype>');
    });

    it('should emit an empty resourcetype for files', () => {
      const xml = buildMultistatus('/api/webdav', [
        { segments: ['a.txt'], name: 'a.txt', isCollection: false },
      ]);
      expect(xml).toContain('<D:resourcetype></D:resourcetype>');
    });
  });

  describe('buildLockResponse', () => {
    it('should produce a lockdiscovery document', () => {
      const xml = buildLockResponse('/api/webdav/a', 'opaquelocktoken:123');
      expect(xml).toContain('<D:lockdiscovery>');
      expect(xml).toContain('<D:activelock>');
      expect(xml).toContain('<D:locktoken><D:href>opaquelocktoken:123</D:href></D:locktoken>');
      expect(xml).toContain('<D:lockroot><D:href>/api/webdav/a</D:href></D:lockroot>');
    });
  });
});
