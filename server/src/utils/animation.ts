import ffmpeg from 'fluent-ffmpeg';

/**
 * FG-14 (HomeRoll): animation generation for auto-creations.
 *
 * Builds a short MP4 slideshow from a sequence of still previews using
 * fluent-ffmpeg (already a server dependency; the jellyfin-ffmpeg binary is
 * provided by the deployment). Additive — the upstream media repository is not
 * touched.
 */

export interface AnimationOptions {
  /** Seconds each still is shown. */
  secondsPerStill?: number;
  /** Output frames per second. */
  fps?: number;
  /** Output pixel size (square, fit-inside). */
  size?: number;
}

const DEFAULTS = { secondsPerStill: 1.5, fps: 30, size: 720 };

/** Renders an MP4 slideshow from still images, written to `output`. */
export async function createAnimation(inputs: string[], output: string, options: AnimationOptions = {}): Promise<void> {
  if (inputs.length < 2) {
    throw new Error('Animation requires at least two input images');
  }

  const { secondsPerStill, fps, size } = { ...DEFAULTS, ...options };
  const evenSize = size % 2 === 0 ? size : size + 1;

  await new Promise<void>((resolve, reject) => {
    const command = ffmpeg();
    for (const input of inputs) {
      // loop each still into its own video stream, then concat
      command.input(input).inputOptions(['-loop', '1', '-t', String(secondsPerStill), '-framerate', String(fps)]);
    }

    command
      .on('error', (error: Error, _stdout: string | null, stderr: string | null) =>
        reject(new Error(stderr || error.message)),
      )
      .on('end', () => resolve())
      .complexFilter([
        // scale every input to a common square canvas, then concat
        ...inputs.flatMap((_, index) => [
          `[${index}:v]scale=${evenSize}:${evenSize}:force_original_aspect_ratio=decrease,pad=${evenSize}:${evenSize}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v${index}]`,
        ]),
        `${inputs.map((_, index) => `[v${index}]`).join('')}concat=n=${inputs.length}:v=1:a=0[outv]`,
      ])
      .outputOptions([
        '-map',
        '[outv]',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-r',
        String(fps),
        '-movflags',
        '+faststart',
      ])
      .output(output)
      .run();
  });
}
