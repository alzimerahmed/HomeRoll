import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { AssetResponseSchema } from 'src/dtos/asset-response.dto.js';

const AskResponseSchema = z
  .object({
    /** Natural-language answer. LLM-composed when a provider is configured, otherwise a deterministic summary. */
    answer: z.string().describe('Natural-language answer over the user library'),
    /** How the answer was produced. */
    provider: z.enum(['llm', 'structured']).describe('Answer provider: llm when configured, structured fallback otherwise'),
    /** The structured interpretation of the question that drove the search. */
    interpretation: z
      .object({
        /** Free-text remainder handed to CLIP (empty when the question was fully structured). */
        query: z.string().nullable().describe('CLIP text query extracted from the question'),
        city: z.string().nullable().describe('City filter extracted from the question'),
        country: z.string().nullable().describe('Country filter extracted from the question'),
        takenAfter: z.string().nullable().describe('ISO date lower bound extracted from the question'),
        takenBefore: z.string().nullable().describe('ISO date upper bound extracted from the question'),
        mediaType: z.enum(['IMAGE', 'VIDEO']).nullable().describe('Media type filter extracted from the question'),
        favorited: z.boolean().nullable().describe('Favorites-only filter extracted from the question'),
        ocr: z.string().nullable().describe('OCR text filter extracted from the question'),
      })
      .meta({ id: 'AskInterpretationDto' }),
    /** Matching assets, best-first (CLIP similarity order). */
    assets: z.array(AssetResponseSchema).describe('Matching assets, best-first'),
    /** Total candidates found before the response cap. */
    total: z.int().min(0).describe('Total matching assets found'),
  })
  .meta({ id: 'AskResponseDto' });

const AskDtoSchema = z
  .object({
    query: z.string().min(1).max(512).describe('Natural-language question about the library'),
    size: z.coerce.number().int().min(1).max(500).default(100).describe('Maximum number of assets to return'),
  })
  .meta({ id: 'AskDto' });

export class AskDto extends createZodDto(AskDtoSchema) {}
export class AskResponseDto extends createZodDto(AskResponseSchema) {}
