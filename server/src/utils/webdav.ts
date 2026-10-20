/**
 * Hand-rolled WebDAV (RFC 4918) helpers for the read-only DAV endpoint.
 * Intentionally free of external dependencies: the multistatus XML is built
 * with plain string interpolation and every user-supplied value is escaped.
 */

/** HTTP methods the read-only DAV endpoint handles. Everything else gets 405. */
export const DAV_ALLOWED_METHODS = 'OPTIONS, PROPFIND, GET, HEAD, LOCK, UNLOCK';

/** DAV compliance classes reported in the `DAV` response header. */
export const DAV_COMPLIANCE_CLASSES = '1, 2';

/** Depth values the server honors (RFC 4918 §9.1); `infinity` is rejected. */
export type DavDepth = 0 | 1;

export type DavDepthHeader = DavDepth | 'infinity' | 'invalid' | undefined;

/** A single resource (file or collection) in the WebDAV tree. */
export interface DavResource {
  /** Path segments relative to the DAV root, unencoded. Empty for the root collection. */
  segments: string[];
  /** `displayname` property. */
  name: string;
  isCollection: boolean;
  /** `getcontentlength` in bytes; omitted when unknown. */
  size?: number;
  /** `getcontenttype`; files only. */
  mimeType?: string;
  /** `getetag`; files only. Emitted quoted. */
  etag?: string;
  createdAt?: Date;
  modifiedAt?: Date;
  /** Internal: absolute filesystem path used for GET/HEAD streaming. Never serialized. */
  path?: string;
  /** Internal: backing asset id used for access checks. Never serialized. */
  id?: string;
}

const XML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

/** Escape the five XML predefined entities. */
export const escapeXml = (value: string): string => value.replace(/[&<>"']/g, (char) => XML_ESCAPE_MAP[char]);

/** Percent-encode a single href segment, then XML-escape the result. */
export const encodeDavSegment = (segment: string): string => escapeXml(encodeURIComponent(segment));

/**
 * Build an absolute DAV href. `baseHref` is the request path of the DAV root
 * (e.g. `/api/webdav`). Collection hrefs get a trailing slash.
 */
export const buildDavHref = (baseHref: string, segments: string[], isCollection: boolean): string => {
  const base = baseHref.replace(/\/+$/, '');
  const path = segments.map(encodeDavSegment).join('/');
  const href = path ? `${base}/${path}` : base;
  return isCollection ? `${href}/` : href;
};

/** RFC 1123 (IMF-fixdate) for `getlastmodified`. */
export const toHttpDate = (date: Date): string => date.toUTCString();

/** ISO 8601 for `creationdate`. */
export const toIsoDate = (date: Date): string => date.toISOString();

/**
 * Parse the `Depth` header.
 * Returns `undefined` when absent (caller applies the default),
 * `'infinity'` when the client explicitly asked for it (rejected with 403 per RFC 4918 §9.1),
 * and `'invalid'` for anything else (rejected with 400).
 */
export const parseDepthHeader = (value: string | string[] | undefined): DavDepthHeader => {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined) {
    return undefined;
  }

  const normalized = raw.trim().toLowerCase();
  if (normalized === '0' || normalized === '1') {
    return Number(normalized) as DavDepth;
  }
  if (normalized === 'infinity') {
    return 'infinity';
  }
  return 'invalid';
};

/**
 * Normalize an Express 5 named wildcard parameter (`/api/webdav/*davPath`)
 * into clean path segments. Empty segments and `.` are dropped; `..`
 * is preserved here and rejected by the service layer.
 */
export const getDavSegments = (param: string | string[] | undefined): string[] => {
  const raw = Array.isArray(param) ? param : param ? param.split('/') : [];
  return raw.filter((segment) => segment.length > 0 && segment !== '.');
};

// Characters that are illegal in file names on common mount targets
// (Windows in particular) or unsafe in DAV hrefs: / \ : * ? " < > | and control chars.
const ILLEGAL_NAME_CHARACTERS = /[\x5c\x2f:*?"<>|\x00-\x1f]/g;

/**
 * Convert an arbitrary display name (library name, album name, original file name)
 * into a safe DAV segment. Never returns an empty string.
 */
export const sanitizeDavName = (name: string): string => {
  const sanitized = name
    .replace(ILLEGAL_NAME_CHARACTERS, '_')
    .trim()
    .replace(/[.\s]+$/, ''); // Windows forbids trailing dots and spaces
  // '.' and '..' are legal names but dangerous DAV segments — some clients normalize them
  // into traversal; a resource named that is unreachable anyway (path safety rejects it)
  return sanitized === '' || sanitized === '.' || sanitized === '..' ? 'untitled' : sanitized;
};

const shortId = (id: string) => id.replaceAll('-', '').slice(0, 8);

/**
 * Assign unique, sanitized display names to a set of items.
 * Collisions (identical names, or names that sanitize identically) are
 * disambiguated with a deterministic `-<id8>` suffix before the extension.
 * Output order is deterministic for a given input set.
 */
export const assignDavNames = <T extends { id: string; name: string }>(items: T[]): { item: T; name: string }[] => {
  const sorted = [...items].sort((a, b) => a.name.localeCompare(b.name, 'en') || a.id.localeCompare(b.id));
  const used = new Set<string>();
  const result: { item: T; name: string }[] = [];

  for (const item of sorted) {
    let name = sanitizeDavName(item.name);
    if (used.has(name)) {
      const extensionIndex = name.lastIndexOf('.');
      name =
        extensionIndex > 0
          ? `${name.slice(0, extensionIndex)}-${shortId(item.id)}${name.slice(extensionIndex)}`
          : `${name}-${shortId(item.id)}`;
    }

    // Defensive: a suffixed name could still collide with an existing file name.
    let counter = 1;
    while (used.has(name)) {
      name = `${name}-${counter++}`;
    }

    used.add(name);
    result.push({ item, name });
  }

  return result;
};

const resourceProps = (resource: DavResource): string => {
  const props: string[] = [
    `<D:displayname>${escapeXml(resource.name)}</D:displayname>`,
    `<D:resourcetype>${resource.isCollection ? '<D:collection/>' : ''}</D:resourcetype>`,
  ];

  if (resource.createdAt) {
    props.push(`<D:creationdate>${toIsoDate(resource.createdAt)}</D:creationdate>`);
  }
  if (resource.modifiedAt) {
    props.push(`<D:getlastmodified>${toHttpDate(resource.modifiedAt)}</D:getlastmodified>`);
  }

  if (!resource.isCollection) {
    if (resource.size !== undefined) {
      props.push(`<D:getcontentlength>${resource.size}</D:getcontentlength>`);
    }
    if (resource.mimeType) {
      props.push(`<D:getcontenttype>${escapeXml(resource.mimeType)}</D:getcontenttype>`);
    }
    if (resource.etag) {
      props.push(`<D:getetag>"${escapeXml(resource.etag)}"</D:getetag>`);
    }
  }

  return props.join('');
};

/**
 * Build a `207 Multi-Status` response body (allprop style: every standard
 * property is returned for each resource).
 */
export const buildMultistatus = (baseHref: string, resources: DavResource[]): string => {
  const responses = resources.map(
    (resource) =>
      '<D:response>' +
      `<D:href>${buildDavHref(baseHref, resource.segments, resource.isCollection)}</D:href>` +
      `<D:propstat><D:prop>${resourceProps(resource)}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>` +
      '</D:response>',
  );

  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    `<D:multistatus xmlns:D="DAV:">${responses.join('')}</D:multistatus>`
  );
};

/**
 * Minimal fake-lock response. The DAV tree is read-only, but some clients
 * refuse to proceed without a successful LOCK; returning an unlocked,
 * inert token satisfies them (the common read-only DAV pattern).
 */
export const buildLockResponse = (href: string, token: string): string =>
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<D:prop xmlns:D="DAV:">' +
  '<D:lockdiscovery><D:activelock>' +
  '<D:locktype><D:write/></D:locktype>' +
  '<D:lockscope><D:exclusive/></D:lockscope>' +
  '<D:depth>infinity</D:depth>' +
  '<D:timeout>Second-3600</D:timeout>' +
  `<D:locktoken><D:href>${escapeXml(token)}</D:href></D:locktoken>` +
  `<D:lockroot><D:href>${escapeXml(href)}</D:href></D:lockroot>` +
  '</D:activelock></D:lockdiscovery>' +
  '</D:prop>';
