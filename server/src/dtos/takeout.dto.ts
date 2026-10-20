import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { ApiCustomExtension } from 'src/enum.js';

export enum TakeoutImportState {
  Queued = 'queued',
  Processing = 'processing',
  Completed = 'completed',
  Failed = 'failed',
  Cancelled = 'cancelled',
}

export const TakeoutImportStateSchema = z
  .enum(TakeoutImportState)
  .describe('Takeout import status')
  .meta({ id: 'TakeoutImportState' });

const TakeoutUploadSchema = z
  .object({
    /**
     * Added to correctly generate the API docs and client SDKs. Validation is handled
     * in the controller; file parts never reach the request body.
     */
    file: z
      .any()
      .optional()
      .describe('Google Takeout archive (.zip, .tar, .tar.gz, .tgz)')
      .meta({ type: 'string', format: 'binary', [ApiCustomExtension.Required]: true }),
  })
  .meta({ id: 'TakeoutUploadDto' });

export const TakeoutImportProgressSchema = z
  .object({
    processed: z.int().min(0).describe('Archive entries processed so far'),
    imported: z.int().min(0).describe('Media files imported as new assets'),
    duplicates: z.int().min(0).describe('Media files skipped because they already exist'),
    skipped: z.int().min(0).describe('Entries skipped (non-media files, oversized sidecars, quota limits)'),
    errors: z.int().min(0).describe('Entries that failed to import'),
  })
  .meta({ id: 'TakeoutImportProgressDto' });

const TakeoutImportResponseSchema = z
  .object({
    id: z.uuid().describe('Import ID (same as the BullMQ job ID)'),
    fileName: z.string().describe('Uploaded archive file name'),
    status: TakeoutImportStateSchema,
  })
  .meta({ id: 'TakeoutImportResponseDto' });

const TakeoutImportStatusSchema = z
  .object({
    id: z.uuid().describe('Import ID'),
    fileName: z.string().describe('Uploaded archive file name'),
    status: TakeoutImportStateSchema,
    createdAt: z.int().describe('Job creation timestamp (epoch milliseconds)'),
    progress: TakeoutImportProgressSchema.optional().describe('Import progress and result counts'),
    error: z.string().optional().describe('Failure reason when the import failed'),
  })
  .meta({ id: 'TakeoutImportStatusDto' });

export class TakeoutUploadDto extends createZodDto(TakeoutUploadSchema) {}
export class TakeoutImportResponseDto extends createZodDto(TakeoutImportResponseSchema) {}
export class TakeoutImportStatusDto extends createZodDto(TakeoutImportStatusSchema) {}
export class TakeoutImportProgressDto extends createZodDto(TakeoutImportProgressSchema) {}
