import { createZodDto } from 'nestjs-zod';
import z from 'zod';

export enum AutoCreationType {
  Collage = 'collage',
  Animation = 'animation',
  TripHighlights = 'trip-highlights',
}

const AutoCreationTypeSchema = z
  .enum(AutoCreationType)
  .describe('Auto-creation type')
  .meta({ id: 'AutoCreationType' });

const AutoCreationRunDtoSchema = z
  .object({
    type: AutoCreationTypeSchema.describe('Which auto-creation to generate now'),
  })
  .meta({ id: 'AutoCreationRunDto' });

const AutoCreationStatusDtoSchema = z
  .object({
    // honest shape: the job is async, so no result ids exist at enqueue time —
    // results land in the archive/albums and the toast carries the "queued" semantics
    type: AutoCreationTypeSchema,
  })
  .meta({ id: 'AutoCreationStatusDto' });

export class AutoCreationRunDto extends createZodDto(AutoCreationRunDtoSchema) {}
export class AutoCreationStatusDto extends createZodDto(AutoCreationStatusDtoSchema) {}
