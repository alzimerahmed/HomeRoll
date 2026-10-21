/**
 * FG-19 sidecar builders for portable exports.
 *
 * Two formats are produced per asset:
 * - a Google-Takeout-compatible JSON sidecar (`<file>.supplemental-metadata.json`)
 *   whose shape is exactly what `parseTakeoutJson` consumes — an export re-imported
 *   through the Phase 4 takeout importer restores capture time, GPS, description,
 *   title and people (round-trip guarantee).
 * - a hand-templated XMP sidecar (`<file>.xmp`, Dublin Core + EXIF + Microsoft
 *   photo-rating schemas) for Adobe-compatible tools. No XML library dependency —
 *   values are XML-escaped by hand (ADR-022).
 *
 * Fields without a Takeout/Google equivalent (rating, albums, keywords, camera
 * summary) ride along as extra top-level keys; strict parsers ignore them and
 * `parseTakeoutJson` does too.
 */

const XML_ESCAPE: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

export const escapeXml = (value: string): string => value.replaceAll(/[&<>"']/g, (c) => XML_ESCAPE[c]!);

export type ExportAssetMetadata = {
  id: string;
  originalFileName: string;
  type: string;
  fileCreatedAt: Date | null;
  takenAt: Date | null;
  latitude: number | null;
  longitude: number | null;
  description: string | null;
  rating: number | null;
  orientation: string | null;
  make: string | null;
  model: string | null;
  lensModel: string | null;
  fNumber: number | null;
  focalLength: number | null;
  iso: number | null;
  exposureTime: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  timeZone: string | null;
  tags: string[] | null;
  albums: string[];
  people: string[];
};

export type SidecarFormat = 'takeout-json' | 'xmp' | 'both';

/** Seconds-since-epoch string, the shape Google Takeout writes and our importer reads. */
const toTakeoutTimestamp = (date: Date): string => Math.floor(date.getTime() / 1000).toString();

const toTakeoutFormatted = (date: Date): string => date.toISOString();

/**
 * Builds a Google-Takeout-compatible sidecar document for an asset.
 * Returns `null` when the asset carries no metadata worth exporting.
 */
export const buildTakeoutJson = (metadata: ExportAssetMetadata): string | null => {
  const json: Record<string, unknown> = {};

  if (metadata.takenAt) {
    json.photoTakenTime = {
      timestamp: toTakeoutTimestamp(metadata.takenAt),
      formatted: toTakeoutFormatted(metadata.takenAt),
    };
  } else if (metadata.fileCreatedAt) {
    // M1 fallback: assets without EXIF capture time still export a usable time —
    // `parseTakeoutJson` reads `creationTime` when `photoTakenTime` is absent.
    json.creationTime = {
      timestamp: toTakeoutTimestamp(metadata.fileCreatedAt),
      formatted: toTakeoutFormatted(metadata.fileCreatedAt),
    };
  }

  // Google writes 0/0 for "no GPS" — our importer rejects that pair, so skip it here too
  if (
    metadata.latitude !== null &&
    metadata.longitude !== null &&
    !(metadata.latitude === 0 && metadata.longitude === 0)
  ) {
    json.geoData = { latitude: metadata.latitude, longitude: metadata.longitude, altitude: 0 };
  }

  if (metadata.description) {
    json.description = metadata.description;
  }

  if (metadata.people.length > 0) {
    json.people = metadata.people.map((name) => ({ name }));
  }

  // HomeRoll extensions — ignored by strict Takeout consumers, useful elsewhere
  if (metadata.rating !== null) {
    json.rating = metadata.rating;
  }
  if (metadata.albums.length > 0) {
    json.albums = metadata.albums;
  }
  const keywords = [...(metadata.tags ?? []), ...metadata.albums];
  if (keywords.length > 0) {
    json.keywords = keywords;
  }
  const camera = [metadata.make, metadata.model, metadata.lensModel].filter((v): v is string => !!v);
  if (camera.length > 0) {
    json.camera = {
      make: metadata.make ?? undefined,
      model: metadata.model ?? undefined,
      lensModel: metadata.lensModel ?? undefined,
    };
  }

  if (Object.keys(json).length === 0) {
    return null;
  }
  // the title only rides along when there is real metadata — a sidecar containing
  // nothing but the file name duplicates what the file itself already says
  if (metadata.originalFileName) {
    json.title = metadata.originalFileName;
  }

  return JSON.stringify(json, null, 2);
};

const xmpDate = (date: Date): string => date.toISOString();

const optional = (value: string | number | null | undefined): string | null =>
  value === null || value === undefined ? null : String(value);

/**
 * Builds an XMP sidecar (Adobe-compatible) for an asset.
 * Returns `null` when the asset carries no metadata worth exporting.
 */
export const buildXmp = (metadata: ExportAssetMetadata): string | null => {
  const rdfItems: string[] = [];
  const simpleProps: string[] = [];

  const addSimple = (prefix: string, name: string, value: string | number | null | undefined) => {
    const v = optional(value);
    if (v === null) {
      return;
    }
    simpleProps.push(`    <${prefix}:${name}>${escapeXml(v)}</${prefix}:${name}>`);
  };

  if (metadata.description) {
    rdfItems.push(
      `    <dc:description><rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(metadata.description)}</rdf:li></rdf:Alt></dc:description>`,
    );
  }

  const subjects = [...(metadata.tags ?? []), ...metadata.albums];
  if (subjects.length > 0) {
    rdfItems.push(
      `    <dc:subject><rdf:Bag>${subjects.map((s) => `<rdf:li>${escapeXml(s)}</rdf:li>`).join('')}</rdf:Bag></dc:subject>`,
    );
  }

  if (metadata.people.length > 0) {
    rdfItems.push(
      `    <Iptc4xmpExt:PersonInImage><rdf:Bag>${metadata.people
        .map((p) => `<rdf:li>${escapeXml(p)}</rdf:li>`)
        .join('')}</rdf:Bag></Iptc4xmpExt:PersonInImage>`,
    );
  }

  if (metadata.takenAt) {
    addSimple('exif', 'DateTimeOriginal', xmpDate(metadata.takenAt));
  }

  if (
    metadata.latitude !== null &&
    metadata.longitude !== null &&
    !(metadata.latitude === 0 && metadata.longitude === 0)
  ) {
    // EXIF-XMP: GPSLatitude/GPSLongitude are single text values in `deg,min.secX` form
    // (e.g. `48,51.504N`); the hemisphere rides inside the value, with the matching
    // `*Ref` elements kept for TIFF-tag compatibility.
    const toGpsText = (value: number, positive: string, negative: string): string => {
      const abs = Math.abs(value);
      const deg = Math.floor(abs);
      const min = ((abs - deg) * 60).toFixed(3);
      return `${deg},${min}${value >= 0 ? positive : negative}`;
    };
    simpleProps.push(
      `    <exif:GPSLatitude>${escapeXml(toGpsText(metadata.latitude, 'N', 'S'))}</exif:GPSLatitude>`,
      `    <exif:GPSLongitude>${escapeXml(toGpsText(metadata.longitude, 'E', 'W'))}</exif:GPSLongitude>`,
      `    <exif:GPSLatitudeRef>${metadata.latitude >= 0 ? 'N' : 'S'}</exif:GPSLatitudeRef>`,
      `    <exif:GPSLongitudeRef>${metadata.longitude >= 0 ? 'E' : 'W'}</exif:GPSLongitudeRef>`,
    );
  }

  addSimple('exif', 'Make', metadata.make);
  addSimple('exif', 'Model', metadata.model);
  addSimple('exif', 'LensModel', metadata.lensModel);
  addSimple('exif', 'FNumber', metadata.fNumber);
  addSimple('exif', 'ExposureTime', metadata.exposureTime);
  if (metadata.iso !== null) {
    // EXIF-XMP defines ISOSpeedRatings as an ordered list of integers
    simpleProps.push(
      `    <exif:ISOSpeedRatings><rdf:Seq><rdf:li>${metadata.iso}</rdf:li></rdf:Seq></exif:ISOSpeedRatings>`,
    );
  }
  addSimple('exif', 'FocalLength', metadata.focalLength);
  addSimple('tiff', 'Orientation', metadata.orientation);
  addSimple('MicrosoftPhoto', 'Rating', metadata.rating);

  if (metadata.city) {
    addSimple('Iptc4xmpExt', 'City', metadata.city);
  }
  if (metadata.state) {
    addSimple('Iptc4xmpExt', 'ProvinceState', metadata.state);
  }
  if (metadata.country) {
    addSimple('Iptc4xmpExt', 'CountryCode', metadata.country);
  }

  if (rdfItems.length === 0 && simpleProps.length === 0) {
    return null;
  }
  // dc:title only accompanies real metadata — a title-only packet is useless
  if (metadata.originalFileName) {
    rdfItems.unshift(
      `    <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(metadata.originalFileName)}</rdf:li></rdf:Alt></dc:title>`,
    );
  }

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="HomeRoll">`,
    ` <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">`,
    `  <rdf:Description rdf:about=""`,
    `   xmlns:dc="http://purl.org/dc/elements/1.1/"`,
    `   xmlns:exif="http://ns.adobe.com/exif/1.0/"`,
    `   xmlns:tiff="http://ns.adobe.com/tiff/1.0/"`,
    `   xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/"`,
    `   xmlns:MicrosoftPhoto="http://ns.microsoft.com/photo/1.0">`,
    ...rdfItems,
    ...simpleProps,
    `  </rdf:Description>`,
    ` </rdf:RDF>`,
    `</x:xmpmeta>`,
    ``,
  ].join('\n');
};

/** Sidecar file names for a media file name, per the requested format. */
export const getSidecarFileNames = (
  mediaFileName: string,
  format: SidecarFormat,
): Array<{ name: string; format: 'takeout-json' | 'xmp' }> => {
  const names: Array<{ name: string; format: 'takeout-json' | 'xmp' }> = [];
  if (format === 'takeout-json' || format === 'both') {
    names.push({ name: `${mediaFileName}.supplemental-metadata.json`, format: 'takeout-json' });
  }
  if (format === 'xmp' || format === 'both') {
    names.push({ name: `${mediaFileName}.xmp`, format: 'xmp' });
  }
  return names;
};
