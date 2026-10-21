import { describe, expect, it } from 'vitest';
import { parseTakeoutJson } from 'src/utils/takeout-json.js';
import {
  buildTakeoutJson,
  buildXmp,
  escapeXml,
  getSidecarFileNames,
  type ExportAssetMetadata,
} from 'src/utils/export-sidecar.js';

const baseMetadata: ExportAssetMetadata = {
  id: '00000000-0000-0000-0000-000000000001',
  originalFileName: 'IMG_1234.jpg',
  type: 'IMAGE',
  fileCreatedAt: new Date('2024-06-01T10:00:00.000Z'),
  takenAt: new Date('2024-06-01T09:30:15.000Z'),
  latitude: 48.8584,
  longitude: 2.2945,
  description: 'A trip to the tower',
  rating: 4,
  orientation: '1',
  make: 'Apple',
  model: 'iPhone 15 Pro',
  lensModel: 'iPhone 15 Pro back triple camera 24mm f/1.78',
  fNumber: 1.78,
  focalLength: 24,
  iso: 125,
  exposureTime: '1/120',
  city: 'Paris',
  state: 'Île-de-France',
  country: 'France',
  timeZone: 'Europe/Paris',
  tags: ['vacation'],
  albums: ['Summer 2024'],
  people: ['Alice', 'Bob'],
};

const emptyMetadata: ExportAssetMetadata = {
  ...baseMetadata,
  takenAt: null,
  latitude: null,
  longitude: null,
  description: null,
  rating: null,
  orientation: null,
  make: null,
  model: null,
  lensModel: null,
  fNumber: null,
  focalLength: null,
  iso: null,
  exposureTime: null,
  city: null,
  state: null,
  country: null,
  timeZone: null,
  tags: null,
  albums: [],
  people: [],
};

describe('buildTakeoutJson', () => {
  it('should produce a document that re-parses to the same metadata (round-trip guarantee)', () => {
    const raw = JSON.parse(buildTakeoutJson(baseMetadata)!);
    const parsed = parseTakeoutJson(raw);

    expect(parsed).not.toBeNull();
    // capture time survives the export → import round trip
    expect(parsed!.takenAt!.getTime()).toBe(baseMetadata.takenAt!.getTime());
    // GPS survives
    expect(parsed!.geo).toEqual({ latitude: baseMetadata.latitude, longitude: baseMetadata.longitude });
    // description survives
    expect(parsed!.description).toBe(baseMetadata.description);
    // title (used as originalFileName on import) survives
    expect(parsed!.title).toBe(baseMetadata.originalFileName);
    // people survive
    expect(parsed!.people).toEqual(baseMetadata.people);
  });

  it('should use the Google Takeout field shapes', () => {
    const json = JSON.parse(buildTakeoutJson(baseMetadata)!);

    expect(json.photoTakenTime.timestamp).toBe(Math.floor(baseMetadata.takenAt!.getTime() / 1000).toString());
    expect(json.photoTakenTime.formatted).toBe(baseMetadata.takenAt!.toISOString());
    expect(json.geoData).toEqual({ latitude: 48.8584, longitude: 2.2945, altitude: 0 });
    expect(json.people).toEqual([{ name: 'Alice' }, { name: 'Bob' }]);
  });

  it('should carry HomeRoll extras (rating, albums, keywords, camera) that the importer ignores', () => {
    const json = JSON.parse(buildTakeoutJson(baseMetadata)!);

    expect(json.rating).toBe(4);
    expect(json.albums).toEqual(['Summer 2024']);
    expect(json.keywords).toEqual(['vacation', 'Summer 2024']);
    expect(json.camera).toEqual({ make: 'Apple', model: 'iPhone 15 Pro', lensModel: baseMetadata.lensModel });

    // strict Takeout parsing ignores the extras without erroring
    expect(parseTakeoutJson(json)).not.toBeNull();
  });

  it('should return null when there is no metadata worth exporting', () => {
    expect(buildTakeoutJson(emptyMetadata)).toBeNull();
  });

  it('should skip a 0/0 GPS pair (Google writes 0/0 for "no GPS")', () => {
    const json = JSON.parse(buildTakeoutJson({ ...baseMetadata, latitude: 0, longitude: 0 })!);
    expect(json.geoData).toBeUndefined();
  });

  it('should emit photoTakenTime when EXIF capture time exists (no creationTime)', () => {
    const json = JSON.parse(buildTakeoutJson(baseMetadata)!);
    expect(json.photoTakenTime).toBeDefined();
    expect(json.creationTime).toBeUndefined();
  });

  it('should fall back to creationTime from fileCreatedAt when there is no EXIF capture time (M1)', () => {
    const json = JSON.parse(
      buildTakeoutJson({ ...baseMetadata, takenAt: null, fileCreatedAt: new Date('2024-06-01T10:00:00.000Z') })!,
    );
    expect(json.photoTakenTime).toBeUndefined();
    expect(json.creationTime.timestamp).toBe(
      Math.floor(new Date('2024-06-01T10:00:00.000Z').getTime() / 1000).toString(),
    );
    // the fallback must round-trip through the importer
    expect(parseTakeoutJson(json)!.takenAt!.getTime()).toBe(new Date('2024-06-01T10:00:00.000Z').getTime());
  });
});

describe('buildXmp', () => {
  it('should emit a well-formed XMP packet with the expected schemas', () => {
    const xmp = buildXmp(baseMetadata)!;

    expect(xmp.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xmp).toContain('<x:xmpmeta xmlns:x="adobe:ns:meta/"');
    expect(xmp).toContain('xmlns:dc="http://purl.org/dc/elements/1.1/"');
    expect(xmp).toContain('xmlns:exif="http://ns.adobe.com/exif/1.0/"');
    expect(xmp).toContain('xmlns:tiff="http://ns.adobe.com/tiff/1.0/"');
    expect(xmp).toContain('xmlns:Iptc4xmpExt=');
    expect(xmp).toContain('xmlns:MicrosoftPhoto=');
    // balanced tags for every element we emit
    expect(xmp).toContain('<dc:title>');
    expect(xmp).toContain('</dc:title>');
    expect(xmp).toContain('<dc:description>');
    expect(xmp).toContain('<exif:DateTimeOriginal>');
    expect(xmp).toContain('<exif:GPSLatitude');
    expect(xmp).toContain('<exif:GPSLatitudeRef>N</exif:GPSLatitudeRef>');
    expect(xmp).toContain('<exif:GPSLongitudeRef>E</exif:GPSLongitudeRef>');
    expect(xmp).toContain('<exif:Make>Apple</exif:Make>');
    expect(xmp).toContain('<exif:Model>iPhone 15 Pro</exif:Model>');
    expect(xmp).toContain('<exif:LensModel>');
    expect(xmp).toContain('<exif:FNumber>1.78</exif:FNumber>');
    expect(xmp).toContain('<exif:ExposureTime>1/120</exif:ExposureTime>');
    expect(xmp).toContain('<exif:ISOSpeedRatings><rdf:Seq><rdf:li>125</rdf:li></rdf:Seq></exif:ISOSpeedRatings>');
    expect(xmp).toContain('<exif:FocalLength>24</exif:FocalLength>');
    expect(xmp).toContain('<tiff:Orientation>1</tiff:Orientation>');
    expect(xmp).toContain('<MicrosoftPhoto:Rating>4</MicrosoftPhoto:Rating>');
    expect(xmp).toContain('<Iptc4xmpExt:PersonInImage>');
    expect(xmp).toContain('<rdf:li>Alice</rdf:li>');
    expect(xmp).toContain('<rdf:li>vacation</rdf:li>');
    expect(xmp).toContain('<rdf:li>Summer 2024</rdf:li>');
  });

  it('should XML-escape metadata values', () => {
    const xmp = buildXmp({ ...baseMetadata, description: 'A <b>bold</b> & "quoted" \'trip\'' })!;
    expect(xmp).not.toContain('<b>bold</b>');
    expect(xmp).toContain(escapeXml('A <b>bold</b> & "quoted" \'trip\''));
  });

  it('should use S/W references for negative coordinates', () => {
    const xmp = buildXmp({ ...baseMetadata, latitude: -33.8568, longitude: -70.6505 })!;
    expect(xmp).toContain('<exif:GPSLatitudeRef>S</exif:GPSLatitudeRef>');
    expect(xmp).toContain('<exif:GPSLongitudeRef>W</exif:GPSLongitudeRef>');
    // composite deg,min.secX form carries the hemisphere inside the value
    expect(xmp).toContain('<exif:GPSLatitude>33,51.408S</exif:GPSLatitude>');
    expect(xmp).toContain('<exif:GPSLongitude>70,39.030W</exif:GPSLongitude>');
  });

  it('should write GPS as composite deg,min.secX text values (no rdf:datatype)', () => {
    const xmp = buildXmp(baseMetadata)!;
    expect(xmp).toContain('<exif:GPSLatitude>48,51.504N</exif:GPSLatitude>');
    expect(xmp).toContain('<exif:GPSLongitude>2,17.670E</exif:GPSLongitude>');
    expect(xmp).not.toContain('rdf:datatype');
  });

  it('should return null when there is no metadata worth exporting', () => {
    expect(buildXmp(emptyMetadata)).toBeNull();
  });

  it('should skip a 0/0 GPS pair', () => {
    const xmp = buildXmp({ ...baseMetadata, latitude: 0, longitude: 0 })!;
    expect(xmp).not.toContain('GPSLatitude');
  });
});

describe('getSidecarFileNames', () => {
  it('should emit takeout-compatible JSON and XMP names for "both"', () => {
    expect(getSidecarFileNames('IMG.jpg', 'both')).toEqual([
      { name: 'IMG.jpg.supplemental-metadata.json', format: 'takeout-json' },
      { name: 'IMG.jpg.xmp', format: 'xmp' },
    ]);
  });

  it('should emit only the requested format', () => {
    expect(getSidecarFileNames('IMG.jpg', 'takeout-json')).toEqual([
      { name: 'IMG.jpg.supplemental-metadata.json', format: 'takeout-json' },
    ]);
    expect(getSidecarFileNames('IMG.jpg', 'xmp')).toEqual([{ name: 'IMG.jpg.xmp', format: 'xmp' }]);
  });
});

describe('escapeXml', () => {
  it('should escape all five XML special characters', () => {
    expect(escapeXml('&<>"' + String.fromCharCode(39))).toBe(
      '&' + 'amp;' + '&' + 'lt;' + '&' + 'gt;' + '&' + 'quot;' + String.fromCharCode(39),
    );
  });
});
