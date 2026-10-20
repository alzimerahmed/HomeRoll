import { buildAtomFeed, buildRssFeed, feedContentType } from 'src/utils/feed.js';

const channel = {
  title: 'Vacation & Friends',
  description: '3 shared photos & videos',
  link: 'https://homeroll.test/share/abc123',
  selfLink: 'https://homeroll.test/api/shared-links/abc123/feed?format=atom',
  updatedAt: new Date('2024-05-02T10:00:00Z'),
};

const items = [
  {
    id: '00000000-0000-4000-a000-000000000001',
    title: 'IMG_0001.jpg',
    link: 'https://homeroll.test/api/assets/00000000-0000-4000-a000-000000000001/original?key=abc123',
    publishedAt: new Date('2024-05-01T10:00:00Z'),
    updatedAt: new Date('2024-05-01T11:00:00Z'),
    description: 'A sunny beach',
    enclosureUrl: 'https://homeroll.test/api/assets/00000000-0000-4000-a000-000000000001/thumbnail?key=abc123',
    enclosureType: 'image/webp',
  },
];

describe('feed', () => {
  describe('feedContentType', () => {
    it('returns the atom content type', () => {
      expect(feedContentType('atom')).toBe('application/atom+xml; charset=utf-8');
    });

    it('returns the rss content type', () => {
      expect(feedContentType('rss')).toBe('application/rss+xml; charset=utf-8');
    });
  });

  describe('buildAtomFeed', () => {
    it('builds a well-formed atom feed', () => {
      const xml = buildAtomFeed(channel, items);

      expect(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>')).toBe(true);
      expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
      expect(xml).toContain('<title>Vacation &amp; Friends</title>');
      expect(xml).toContain('<subtitle>3 shared photos &amp; videos</subtitle>');
      expect(xml).toContain('<link rel="self" href="https://homeroll.test/api/shared-links/abc123/feed?format=atom" />');
      expect(xml).toContain('<id>https://homeroll.test/api/shared-links/abc123/feed?format=atom</id>');
      expect(xml).toContain('<updated>2024-05-02T10:00:00.000Z</updated>');
      expect(xml).toContain('<entry>');
      expect(xml).toContain('<title>IMG_0001.jpg</title>');
      expect(xml).toContain('<id>urn:uuid:00000000-0000-4000-a000-000000000001</id>');
      expect(xml).toContain('<published>2024-05-01T10:00:00.000Z</published>');
      expect(xml).toContain('<summary>A sunny beach</summary>');
      expect(xml).toContain('rel="enclosure"');
    });

    it('escapes special characters in interpolated values', () => {
      const xml = buildAtomFeed({ ...channel, title: `a&b<c>d"e'f` }, [
        { ...items[0], title: 'x<y', description: 'd&d' },
      ]);

      expect(xml).toContain('<title>a&amp;b&lt;c&gt;d&quot;e&apos;f</title>');
      expect(xml).toContain('<title>x&lt;y</title>');
      expect(xml).toContain('<summary>d&amp;d</summary>');
      expect(xml).not.toContain('x<y');
    });

    it('omits summary and enclosure when absent', () => {
      const xml = buildAtomFeed(
        { ...channel, description: undefined },
        [{ ...items[0], description: undefined, enclosureUrl: undefined }],
      );

      expect(xml).not.toContain('<subtitle>');
      expect(xml).not.toContain('<summary>');
      expect(xml).not.toContain('rel="enclosure"');
    });

    it('builds an empty feed', () => {
      const xml = buildAtomFeed(channel, []);
      expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
      expect(xml).not.toContain('<entry>');
    });
  });

  describe('buildRssFeed', () => {
    it('builds a well-formed rss feed', () => {
      const xml = buildRssFeed(channel, items);

      expect(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>')).toBe(true);
      expect(xml).toContain('<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">');
      expect(xml).toContain('<title>Vacation &amp; Friends</title>');
      expect(xml).toContain('<link>https://homeroll.test/share/abc123</link>');
      expect(xml).toContain('<lastBuildDate>Thu, 02 May 2024 10:00:00 GMT</lastBuildDate>');
      expect(xml).toContain('<item>');
      expect(xml).toContain('<guid isPermaLink="false">00000000-0000-4000-a000-000000000001</guid>');
      expect(xml).toContain('<pubDate>Wed, 01 May 2024 10:00:00 GMT</pubDate>');
      expect(xml).toContain('<enclosure url=');
      expect(xml).toContain('length="0"');
      expect(xml).toContain('<description>A sunny beach</description>');
    });

    it('escapes special characters', () => {
      const xml = buildRssFeed({ ...channel, title: 'a<b' }, [{ ...items[0], title: 'c>d' }]);
      expect(xml).toContain('<title>a&lt;b</title>');
      expect(xml).toContain('<title>c&gt;d</title>');
    });
  });
});
