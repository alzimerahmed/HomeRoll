import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type ExportAssetMetadata, buildTakeoutJson, buildXmp } from 'src/utils/export-sidecar.js';

/**
 * FG-19 contract tests for the repository → sidecar pipeline (review M3).
 *
 * The service spec mocks `getExportMetadata` with a hand-shaped object, so a
 * select-alias regression in the repository (e.g. losing `dateTimeOriginal as
 * takenAt`) would ship silently. These tests pin the real contract:
 *
 * 1. the SQL select actually aliases `asset_exif.dateTimeOriginal` to `takenAt`
 *    (asserted against the repository source — no DB needed);
 * 2. a raw row object exactly as Postgres returns it (snake-free key set from
 *    the select list, including the `takenAt` alias) maps through the same
 *    spread the repository performs and feeds both builders.
 */

const repositorySource = readFileSync(new URL('download.repository.ts', import.meta.url), 'utf8');

describe('download.repository.getExportMetadata (sidecar contract)', () => {
  it('aliases asset_exif.dateTimeOriginal as takenAt in the select list', () => {
    expect(repositorySource).toContain("'asset_exif.dateTimeOriginal as takenAt'");
  });

  it('maps a raw row (real select shape) into ExportAssetMetadata that both builders consume', () => {
    // keys exactly as the SQL select list produces them — `takenAt` is the alias
    const rawRow = {
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
      lensModel: 'triple camera',
      fNumber: 1.78,
      focalLength: 24,
      iso: 125,
      exposureTime: '1/120',
      city: 'Paris',
      state: null,
      country: 'France',
      timeZone: null,
      tags: ['vacation'],
      albums: ['Summer 2024'],
      people: ['Alice'],
    };

    // same mapping the repository performs on every row
    const metadata = {
      ...rawRow,
      albums: rawRow.albums ?? [],
      people: rawRow.people ?? [],
    } satisfies ExportAssetMetadata;

    const json = JSON.parse(buildTakeoutJson(metadata)!);
    expect(json.photoTakenTime.timestamp).toBe(
      Math.floor(new Date('2024-06-01T09:30:15.000Z').getTime() / 1000).toString(),
    );

    const xmp = buildXmp(metadata)!;
    expect(xmp).toContain('<exif:DateTimeOriginal>');
  });

  it('maps a row with null takenAt into a builder output carrying the creationTime fallback', () => {
    const rawRow = {
      id: '00000000-0000-0000-0000-000000000002',
      originalFileName: 'scan.jpg',
      type: 'IMAGE',
      fileCreatedAt: new Date('2024-06-01T10:00:00.000Z'),
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
      albums: null,
      people: null,
    };

    const metadata = {
      ...rawRow,
      albums: rawRow.albums ?? [],
      people: rawRow.people ?? [],
    } satisfies ExportAssetMetadata;

    const json = JSON.parse(buildTakeoutJson(metadata)!);
    expect(json.photoTakenTime).toBeUndefined();
    expect(json.creationTime.timestamp).toBe(
      Math.floor(new Date('2024-06-01T10:00:00.000Z').getTime() / 1000).toString(),
    );
  });
});
