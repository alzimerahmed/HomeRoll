import { createZodDto } from 'nestjs-zod';
import z from 'zod';

/**
 * FG-15 (HomeRoll): server-side video trim contract (ADR-021).
 * `POST /videos/:id/trim` — queues an ffmpeg trim that produces a new archived asset.
 */
const VideoTrimDtoSchema = z
  .object({
    startSeconds: z.number().min(0).describe('Trim window start in seconds'),
    endSeconds: z.number().min(0).describe('Trim window end in seconds (exclusive)'),
  })
  .refine(({ startSeconds, endSeconds }) => endSeconds > startSeconds, {
    message: 'endSeconds must be greater than startSeconds',
  })
  .meta({ id: 'VideoTrimDto' });

const VideoTrimResponseDtoSchema = z
  .object({
    assetId: z.uuidv4().describe('Queued trimmed-copy asset id (the asset appears once the trim job finishes)'),
  })
  .meta({ id: 'VideoTrimResponseDto' });

export class VideoTrimDto extends createZodDto(VideoTrimDtoSchema) {}
export class VideoTrimResponseDto extends createZodDto(VideoTrimResponseDtoSchema) {}
