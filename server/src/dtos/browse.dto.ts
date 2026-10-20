import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { AssetResponseSchema } from 'src/dtos/asset-response.dto.js';

const BrowseLabelResponseSchema = z
  .object({
    key: z.string().describe('Stable label key, usable in the label assets endpoint'),
    label: z.string().describe('Human-readable label name'),
    count: z.int().min(0).describe('Number of assets matching the label'),
    previewAssetId: z
      .uuidv4()
      .nullable()
      .describe('Asset ID of the closest match, usable as the label thumbnail'),
  })
  .meta({ id: 'BrowseLabelResponseDto' });

const BrowseLabelParamSchema = z.object({
  key: z.string().min(1).max(64).describe('Browse label key'),
});

const BrowseLabelAssetsSchema = z
  .object({
    size: z.coerce.number().int().min(1).max(1000).default(250).describe('Number of results to return'),
    cursor: z.string().min(1).optional().describe('Cursor for the next page of results'),
  })
  .meta({ id: 'BrowseLabelAssetsDto' });

const BrowseLabelAssetsResponseSchema = z
  .object({
    count: z.int().min(0).describe('Number of assets in this page'),
    items: z.array(AssetResponseSchema),
    nextCursor: z.string().nullable().describe('Cursor for the next page of results'),
  })
  .meta({ id: 'BrowseLabelAssetsResponseDto' });

export class BrowseLabelResponseDto extends createZodDto(BrowseLabelResponseSchema) {}
export class BrowseLabelParamDto extends createZodDto(BrowseLabelParamSchema) {}
export class BrowseLabelAssetsDto extends createZodDto(BrowseLabelAssetsSchema) {}
export class BrowseLabelAssetsResponseDto extends createZodDto(BrowseLabelAssetsResponseSchema) {}
