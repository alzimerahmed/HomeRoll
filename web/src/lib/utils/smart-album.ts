import { AlbumType, AssetType, type AlbumResponseDto, type SmartAlbumRulesDto } from '@immich/sdk';

/**
 * FG-06 — smart album helpers. `SmartAlbumRulesDto` is a flat object of
 * optional rule fields; the server combines all present fields with AND
 * semantics (see `SmartAlbumRulesSchema` in `server/src/dtos/smart-album.dto.ts`).
 */
export const isSmartAlbum = (album: AlbumResponseDto) => album.albumType === AlbumType.Smart;

export type SmartRuleField = keyof SmartAlbumRulesDto;

export type SmartRuleKind = 'date' | 'text' | 'rating' | 'people' | 'tags' | 'type' | 'boolean';

export interface SmartRuleFieldMeta {
  /** i18n key for the field name shown in the field selector. */
  labelKey: string;
  /** i18n key for the fixed operator verb shown between field and value. */
  operatorKey: string;
  kind: SmartRuleKind;
}

/**
 * Order and presentation of every rule field supported by SmartAlbumRulesDto.
 * Each field can only be used once per rule set because the rules are a flat
 * object — AND-combining the same field twice is not possible.
 */
export const smartRuleFields: readonly SmartRuleField[] = [
  'takenAfter',
  'takenBefore',
  'city',
  'country',
  'make',
  'model',
  'lensModel',
  'rating',
  'personIds',
  'tagIds',
  'type',
  'isFavorite',
  'isNotInAlbum',
];

export const smartRuleFieldMeta: Record<SmartRuleField, SmartRuleFieldMeta> = {
  takenAfter: { labelKey: 'date_after', operatorKey: 'rule_operator_is', kind: 'date' },
  takenBefore: { labelKey: 'date_before', operatorKey: 'rule_operator_is', kind: 'date' },
  city: { labelKey: 'city', operatorKey: 'rule_operator_is', kind: 'text' },
  country: { labelKey: 'country', operatorKey: 'rule_operator_is', kind: 'text' },
  make: { labelKey: 'make', operatorKey: 'rule_operator_is', kind: 'text' },
  model: { labelKey: 'model', operatorKey: 'rule_operator_is', kind: 'text' },
  lensModel: { labelKey: 'lens_model', operatorKey: 'rule_operator_is', kind: 'text' },
  rating: { labelKey: 'rating', operatorKey: 'rule_operator_at_least', kind: 'rating' },
  personIds: { labelKey: 'people', operatorKey: 'rule_operator_includes_all', kind: 'people' },
  tagIds: { labelKey: 'tags', operatorKey: 'rule_operator_includes_all', kind: 'tags' },
  type: { labelKey: 'media_type', operatorKey: 'rule_operator_is', kind: 'type' },
  isFavorite: { labelKey: 'favorite', operatorKey: 'rule_operator_is', kind: 'boolean' },
  isNotInAlbum: { labelKey: 'album_membership', operatorKey: 'rule_operator_is', kind: 'boolean' },
};

/**
 * Default value applied when a rule row is enabled, so boolean/select rules are
 * immediately valid. Text/date/people/tag fields stay empty until the user
 * provides a value.
 */
export const defaultSmartRuleValue = (field: SmartRuleField): SmartAlbumRulesDto[SmartRuleField] => {
  switch (field) {
    case 'isFavorite':
    case 'isNotInAlbum': {
      return true;
    }
    case 'rating': {
      return 1;
    }
    case 'type': {
      return AssetType.Image;
    }
    case 'personIds':
    case 'tagIds': {
      return [];
    }
    default: {
      return undefined;
    }
  }
};

export const hasSmartRuleValue = (value: unknown): boolean => {
  if (value === undefined || value === null || value === '') {
    return false;
  }
  return !(Array.isArray(value) && value.length === 0);
};

/**
 * Turns the enabled rows of the rules editor into the wire format: only fields
 * that are enabled AND have a value are sent, empty strings/arrays dropped.
 */
export const serializeSmartRules = (
  fields: readonly SmartRuleField[],
  values: Partial<SmartAlbumRulesDto>,
): SmartAlbumRulesDto => {
  const rules: Record<string, unknown> = {};
  for (const field of fields) {
    const value = values[field];
    if (hasSmartRuleValue(value)) {
      rules[field] = value;
    }
  }
  return rules as SmartAlbumRulesDto;
};

export const countSmartAlbumRules = (rules: SmartAlbumRulesDto | null | undefined): number => {
  if (!rules) {
    return 0;
  }
  return Object.values(rules).filter((value) => hasSmartRuleValue(value)).length;
};
