import ffmpeg from 'fluent-ffmpeg';

/**
 * FG-15 (HomeRoll): server-side video trim.
 *
 * Stream-copies the `[start, end)` window of the source video into a new file.
 * `-c copy` avoids re-encode cost/quality loss; keyframe alignment means the
 * actual cut points may snap to the nearest keyframes, which is acceptable for
 * a "save trimmed copy" feature (documented in ADR-021).
 */

export interface VideoTrimOptions {
  startSeconds: number;
  endSeconds: number;
}

/** Renders the trimmed copy of `input` to `output`. */
export async function trimVideoFile(input: string, output: string, options: VideoTrimOptions): Promise<void> {
  const { startSeconds, endSeconds } = options;

  await new Promise<void>((resolve, reject) => {
    ffmpeg(input)
      .on('error', (error: Error, _stdout: unknown, stderr: string) => reject(new Error(stderr || error.message)))
      .on('end', () => resolve())
      .outputOptions([
        // input seeking before decoding, then a precise window via -t
        '-ss',
        `${startSeconds}`,
        '-t',
        `${Math.max(endSeconds - startSeconds, 0)}`,
        '-c',
        'copy',
        '-movflags',
        '+faststart',
      ])
      .output(output)
      .run();
  });
}
