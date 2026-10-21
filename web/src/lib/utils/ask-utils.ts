import type { AskInterpretationDto } from '$lib/services/homeroll-api';

/** Search DTO accepted by `Route.search()` (MetadataSearchDto + SmartSearchDto subset). */
export type AskSearchDto = {
  query?: string;
  city?: string;
  country?: string;
  takenAfter?: string;
  takenBefore?: string;
  type?: 'IMAGE' | 'VIDEO';
  isFavorite?: boolean;
  ocr?: string;
};

/** Maps an Ask interpretation onto the existing search route's query DTO. */
export const interpretationToSearchDto = (interpretation: AskInterpretationDto): AskSearchDto => {
  const dto: AskSearchDto = {};
  if (interpretation.query) {
    dto.query = interpretation.query;
  }
  if (interpretation.city) {
    dto.city = interpretation.city;
  }
  if (interpretation.country) {
    dto.country = interpretation.country;
  }
  if (interpretation.takenAfter) {
    dto.takenAfter = interpretation.takenAfter;
  }
  if (interpretation.takenBefore) {
    dto.takenBefore = interpretation.takenBefore;
  }
  if (interpretation.mediaType) {
    dto.type = interpretation.mediaType;
  }
  if (interpretation.favorited) {
    dto.isFavorite = true;
  }
  if (interpretation.ocr) {
    dto.ocr = interpretation.ocr;
  }
  return dto;
};

export interface AskChip {
  key: string;
  label: string;
  value: string;
}

/** Builds the filter chips shown under the answer (one per non-null interpretation field). */
export const interpretationToChips = (interpretation: AskInterpretationDto): AskChip[] => {
  const chips: AskChip[] = [];
  if (interpretation.query) {
    chips.push({ key: 'query', label: 'context', value: interpretation.query });
  }
  if (interpretation.city) {
    chips.push({ key: 'city', label: 'city', value: interpretation.city });
  }
  if (interpretation.country) {
    chips.push({ key: 'country', label: 'country', value: interpretation.country });
  }
  if (interpretation.takenAfter) {
    chips.push({ key: 'takenAfter', label: 'start_date', value: interpretation.takenAfter });
  }
  if (interpretation.takenBefore) {
    chips.push({ key: 'takenBefore', label: 'end_date', value: interpretation.takenBefore });
  }
  if (interpretation.mediaType) {
    chips.push({ key: 'type', label: 'media_type', value: interpretation.mediaType });
  }
  if (interpretation.favorited) {
    chips.push({ key: 'isFavorite', label: 'favorite', value: 'true' });
  }
  if (interpretation.ocr) {
    chips.push({ key: 'ocr', label: 'ocr', value: interpretation.ocr });
  }
  return chips;
};
