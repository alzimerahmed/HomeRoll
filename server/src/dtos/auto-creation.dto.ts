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
    albumId: z.uuidv4().nullable().describe('Album holding the created assets (trip highlights)'),
    assetId: z.uuidv4().nullable().describe('Primary created asset (collage or animation)'),
    type: AutoCreationTypeSchema,
  })
  .meta({ id: 'AutoCreationStatusDto' });

export class AutoCreationRunDto extends createZodDto(AutoCreationRunDtoSchema) {}
export class AutoCreationStatusDto extends createZodDto(AutoCreationStatusDtoSchema) {}
