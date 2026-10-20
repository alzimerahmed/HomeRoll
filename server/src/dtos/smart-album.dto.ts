import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { AssetTypeSchema } from 'src/enum.js';

/**
 * Rule set for smart albums (FG-06). All fields are optional; present fields are
 * combined with AND semantics. Stored verbatim in the `album.rules` jsonb column.
 */
export const SmartAlbumRulesSchema = z
  .object({
    takenAfter: z
      .iso
      .datetime({ offset: true })
      .optional()
      .describe('Only include assets taken after this ISO 8601 datetime')
      .meta({ example: '2024-01-01T00:00:00.000Z' }),
    takenBefore: z
      .iso
      .datetime({ offset: true })
      .optional()
      .describe('Only include assets taken before this ISO 8601 datetime')
      .meta({ example: '2024-12-31T23:59:59.999Z' }),
    city: z.string().optional().describe('Only include assets taken in this city (exact match on EXIF city)'),
    country: z.string().optional().describe('Only include assets taken in this country (exact match on EXIF country)'),
    make: z.string().optional().describe('Only include assets from this camera make (exact match on EXIF make)'),
    model: z.string().optional().describe('Only include assets from this camera model (exact match on EXIF model)'),
    lensModel: z.string().optional().describe('Only include assets taken with this lens (exact match on EXIF lensModel)'),
    rating: z
      .int()
      .min(-1)
      .max(5)
      .refine((value) => value !== 0, {
        error: 'Rating must be -1 (rejected) or 1–5 (starred); 0 is not valid',
      })
      .optional()
      .describe('Only include assets with at least this rating'),
    personIds: z
      .array(z.uuidv4())
      .min(1)
      .optional()
      .describe('Only include assets that contain all of these person group IDs (same semantics as search personIds)'),
    tagIds: z
      .array(z.uuidv4())
      .min(1)
      .optional()
      .describe('Only include assets tagged with all of these tags (tag descendants included)'),
    type: AssetTypeSchema.optional().describe('Only include assets of this type'),
    isFavorite: z.boolean().optional().describe('Only include favorite assets'),
    isNotInAlbum: z.boolean().optional().describe('Only include assets that are not in any album'),
  })
  .meta({ id: 'SmartAlbumRulesDto' });

export type SmartAlbumRules = z.infer<typeof SmartAlbumRulesSchema>;

export class SmartAlbumRulesDto extends createZodDto(SmartAlbumRulesSchema) {}
