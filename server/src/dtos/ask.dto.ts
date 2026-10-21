import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { AssetResponseSchema } from 'src/dtos/asset-response.dto.js';

const AskResponseSchema = z
  .object({
    answer: z.string().describe('Natural-language answer over the user library'),
    provider: z
      .enum(['llm', 'structured'])
      .describe('Answer provider: llm when configured, structured fallback otherwise'),
    interpretation: z
      .object({
        query: z.string().nullable().describe('CLIP text query extracted from the question'),
        city: z.string().nullable().describe('City filter extracted from the question'),
        country: z.string().nullable().describe('Country filter extracted from the question'),
        takenAfter: z.string().nullable().describe('ISO date lower bound extracted from the question'),
        takenBefore: z.string().nullable().describe('ISO date upper bound extracted from the question'),
        // optional, not .nullable(): an enum with a null member generates an
        // initializer-less `Null` member in the TS SDK (oazapfts)
        mediaType: z.enum(['IMAGE', 'VIDEO']).optional().describe('Media type filter extracted from the question'),
        favorited: z.boolean().nullable().describe('Favorites-only filter extracted from the question'),
        ocr: z.string().nullable().describe('OCR text filter extracted from the question'),
      })
      .meta({ id: 'AskInterpretationDto' }),
    assets: z.array(AssetResponseSchema).describe('Matching assets, best-first (capped at 100 per response)'),
    total: z.int().min(0).describe('Lower bound on matching assets found (may exceed the returned assets)'),
  })
  .meta({ id: 'AskResponseDto' });

const AskDtoSchema = z
  .object({
    query: z.string().min(1).max(512).describe('Natural-language question about the library'),
    size: z.coerce.number().int().min(1).max(500).default(100).describe('Maximum number of assets to match'),
  })
  .meta({ id: 'AskDto' });

export class AskDto extends createZodDto(AskDtoSchema) {}
export class AskResponseDto extends createZodDto(AskResponseSchema) {}
