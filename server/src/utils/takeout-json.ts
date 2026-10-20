/**
 * Pure helpers for parsing Google Takeout JSON sidecars and pairing them with media files.
 *
 * Takeout emits a `*.supplemental-metadata.json` sidecar next to each photo/video.
 * Known quirks handled here:
 * - plain `<name>.json` sidecars without the supplemental marker
 * - sidecar names truncated to fit a ~51 character filename limit
 * - `(n)` duplicate suffixes placed either before or after the media extension
 */

export type TakeoutGeo = {
  latitude: number;
  longitude: number;
  altitude?: number;
};

export type TakeoutMetadata = {
  /** display title from Google Photos (may differ from the file name) */
  title?: string;
  /** user-supplied description */
  description?: string;
  /** capture time, from `photoTakenTime` (falls back to `creationTime`) */
  takenAt?: Date;
  geo?: TakeoutGeo;
  /** people names tagged in Google Photos */
  people?: string[];
};

/**
 * Sidecar names longer than this are assumed to be the start of a truncated
 * `<media>.supplemental-metadata.json` name and are prefix-matched.
 */
export const TAKEOUT_TRIMMED_NAME_LENGTH = 46;

const JSON_SUFFIX = '.json';

/**
 * Extracts the media file name a JSON sidecar refers to, or `null` when the
 * file does not look like a per-asset sidecar (e.g. album `metadata.json` is
 * still parsed, it just won't contain asset metadata fields).
 */
export const getSidecarMediaName = (jsonFileName: string): string | null => {
  if (!jsonFileName.toLowerCase().endsWith(JSON_SUFFIX)) {
    return null;
  }

  // strip `.json`, then strip a full or truncated `.supplemental-metadata` marker
  const base = jsonFileName.slice(0, -JSON_SUFFIX.length).replace(/\.supplemental-[^/\\]*$/i, '');
  return base || null;
};

/**
 * Candidate sidecar names for a media file, in priority order.
 * Covers `<m>.supplemental-metadata.json`, `<m>.json`, truncated variants and
 * the `name(n).ext` ↔ `name.ext(n)` duplicate-numbering quirk.
 */
export const getSidecarCandidates = (mediaFileName: string): string[] => {
  const names = [mediaFileName];

  // `IMG_1234(1).jpg` may be paired with `IMG_1234.jpg(1).json` style sidecars
  const duplicate = /^(.*?)\s*\((\d+)\)(\.[^.]+)$/.exec(mediaFileName);
  if (duplicate) {
    names.push(`${duplicate[1]}${duplicate[3]}(${duplicate[2]})`);
  }

  const candidates: string[] = [];
  for (const name of names) {
    candidates.push(
      `${name}.supplemental-metadata.json`,
      `${name}.json`,
      `${name.slice(0, TAKEOUT_TRIMMED_NAME_LENGTH)}.json`,
    );
  }

  return [...new Set(candidates)];
};

/**
 * Returns true when `jsonFileName` looks like the metadata sidecar for `mediaFileName`.
 */
export const matchSidecar = (mediaFileName: string, jsonFileName: string): boolean => {
  const base = getSidecarMediaName(jsonFileName);
  if (!base) {
    return false;
  }

  if (base === mediaFileName) {
    return true;
  }

  // truncated sidecar: the sidecar name is a long prefix of the media name
  if (base.length >= TAKEOUT_TRIMMED_NAME_LENGTH && mediaFileName.startsWith(base)) {
    return true;
  }

  return false;
};

/**
 * Finds the sidecar JSON for a media file inside a list of `.json` file names
 * from the same directory. Returns `undefined` when there is no match.
 */
export const findSidecarJson = (mediaFileName: string, jsonFileNames: Iterable<string>): string | undefined => {
  const names = jsonFileNames instanceof Set ? jsonFileNames : new Set(jsonFileNames);

  for (const candidate of getSidecarCandidates(mediaFileName)) {
    if (names.has(candidate)) {
      return candidate;
    }
  }

  for (const name of names) {
    if (matchSidecar(mediaFileName, name)) {
      return name;
    }
  }

  return undefined;
};

const parseGeo = (value: unknown): TakeoutGeo | null => {
  if (typeof value !== 'object' || value === null) {
    return null;
  }

  const { latitude, longitude, altitude } = value as { latitude?: unknown; longitude?: unknown; altitude?: unknown };
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return null;
  }
  // Google writes 0/0 for photos without GPS data
  if (lat === 0 && lng === 0) {
    return null;
  }

  const alt = Number(altitude);
  return Number.isFinite(alt) && alt !== 0
    ? { latitude: lat, longitude: lng, altitude: alt }
    : { latitude: lat, longitude: lng };
};

const parseTimestamp = (value: unknown): Date | undefined => {
  const timestamp = Number((value as { timestamp?: unknown })?.timestamp);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return undefined;
  }
  return new Date(timestamp * 1000);
};

/**
 * Parses a Google Takeout sidecar JSON document.
 * Returns `null` for documents that contain no usable metadata.
 */
export const parseTakeoutJson = (raw: unknown): TakeoutMetadata | null => {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }

  const json = raw as Record<string, unknown>;
  const metadata: TakeoutMetadata = {};

  const takenAt = parseTimestamp(json.photoTakenTime) ?? parseTimestamp(json.creationTime);
  if (takenAt) {
    metadata.takenAt = takenAt;
  }

  const geo = parseGeo(json.geoData) ?? parseGeo(json.geoDataExif);
  if (geo) {
    metadata.geo = geo;
  }

  if (typeof json.title === 'string' && json.title.length > 0) {
    metadata.title = json.title;
  }

  if (typeof json.description === 'string' && json.description.length > 0) {
    metadata.description = json.description;
  }

  if (Array.isArray(json.people)) {
    const people = json.people
      .map((person) =>
        typeof (person as { name?: unknown })?.name === 'string' ? (person as { name: string }).name : null,
      )
      .filter((name): name is string => name !== null);
    if (people.length > 0) {
      metadata.people = people;
    }
  }

  return Object.keys(metadata).length > 0 ? metadata : null;
};
