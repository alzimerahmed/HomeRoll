/**
 * RSS 2.0 / Atom feed builders for shared links (FG-08).
 * Hand-rolled like the WebDAV XML helpers: string interpolation only,
 * every interpolated value passes through `escapeXml`.
 */

import { escapeXml } from 'src/utils/webdav.js';

export type FeedFormat = 'atom' | 'rss';

export interface FeedItem {
  /** Stable unique id (asset id). */
  id: string;
  title: string;
  /** Absolute URL the item links to. */
  link: string;
  /** Item creation date (asset fileCreatedAt). */
  publishedAt: Date;
  updatedAt: Date;
  /** Optional plain-text summary (exif description); omitted when metadata is hidden. */
  description?: string;
  /** Absolute thumbnail URL. */
  enclosureUrl?: string;
  enclosureType?: string;
}

export interface FeedChannel {
  title: string;
  description?: string;
  /** Absolute URL of the share page. */
  link: string;
  /** Absolute URL of the feed itself (atom self link / atom:link in rss). */
  selfLink: string;
  updatedAt: Date;
}

export const feedContentType = (format: FeedFormat) =>
  format === 'rss' ? 'application/rss+xml; charset=utf-8' : 'application/atom+xml; charset=utf-8';

const toIso = (date: Date) => new Date(date).toISOString();
const toHttpDate = (date: Date) => new Date(date).toUTCString();

export const buildAtomFeed = (channel: FeedChannel, items: FeedItem[]): string => {
  const entries = items.map((item) => {
    const description = item.description ? `<summary>${escapeXml(item.description)}</summary>` : '';
    const enclosure = item.enclosureUrl
      ? `<link rel="enclosure" href="${escapeXml(item.enclosureUrl)}" type="${escapeXml(item.enclosureType || 'image/webp')}" />`
      : '';

    return (
      '<entry>' +
      `<title>${escapeXml(item.title)}</title>` +
      `<link href="${escapeXml(item.link)}" />` +
      enclosure +
      `<id>urn:uuid:${escapeXml(item.id)}</id>` +
      `<published>${toIso(item.publishedAt)}</published>` +
      `<updated>${toIso(item.updatedAt)}</updated>` +
      description +
      '</entry>'
    );
  });

  const description = channel.description ? `<subtitle>${escapeXml(channel.description)}</subtitle>` : '';

  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<feed xmlns="http://www.w3.org/2005/Atom">' +
    `<title>${escapeXml(channel.title)}</title>` +
    description +
    `<link href="${escapeXml(channel.link)}" />` +
    `<link rel="self" href="${escapeXml(channel.selfLink)}" />` +
    `<id>${escapeXml(channel.selfLink)}</id>` +
    `<updated>${toIso(channel.updatedAt)}</updated>` +
    entries.join('') +
    '</feed>'
  );
};

export const buildRssFeed = (channel: FeedChannel, items: FeedItem[]): string => {
  const entries = items.map((item) => {
    const description = item.description ? `<description>${escapeXml(item.description)}</description>` : '';
    const enclosure = item.enclosureUrl
      ? `<enclosure url="${escapeXml(item.enclosureUrl)}" type="${escapeXml(item.enclosureType || 'image/webp')}" length="0" />`
      : '';

    return (
      '<item>' +
      `<title>${escapeXml(item.title)}</title>` +
      `<link>${escapeXml(item.link)}</link>` +
      `<guid isPermaLink="false">${escapeXml(item.id)}</guid>` +
      `<pubDate>${toHttpDate(item.publishedAt)}</pubDate>` +
      enclosure +
      description +
      '</item>'
    );
  });

  const description = channel.description ? `<description>${escapeXml(channel.description)}</description>` : '';

  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">' +
    '<channel>' +
    `<title>${escapeXml(channel.title)}</title>` +
    `<link>${escapeXml(channel.link)}</link>` +
    description +
    `<atom:link href="${escapeXml(channel.selfLink)}" rel="self" type="application/rss+xml" />` +
    `<lastBuildDate>${toHttpDate(channel.updatedAt)}</lastBuildDate>` +
    entries.join('') +
    '</channel>' +
    '</rss>'
  );
};
