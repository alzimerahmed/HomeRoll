import sharp, { OverlayOptions } from 'sharp';

/**
 * FG-14 (HomeRoll): collage composition for auto-creations.
 *
 * Uses sharp (already a server dependency) to composite up to 4 preview images
 * into a 2×2 grid JPEG. Deliberately additive — the upstream media repository
 * is not touched.
 */

export interface CollageInput {
  path: string;
}

const CELL_SIZE = 800;
const GAP = 8;
const JPEG_QUALITY = 85;

/** Composites up to four images into a square 2×2 collage, written to `output`. */
export async function createCollage(inputs: CollageInput[], output: string): Promise<void> {
  if (inputs.length === 0) {
    throw new Error('Collage requires at least one input image');
  }

  const cells = inputs.slice(0, 4);
  const cell = cells.length === 1 ? CELL_SIZE * 2 : CELL_SIZE;
  const canvasSize = cells.length === 1 ? cell : cell * 2 + GAP;

  const composites: OverlayOptions[] = [];
  for (let index = 0; index < cells.length; index++) {
    const resized = await sharp(cells[index].path)
      .resize(cell, cell, { fit: 'cover', position: 'attention' })
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer();

    const column = index % 2;
    const row = Math.floor(index / 2);
    composites.push({
      input: resized,
      left: column * (cell + GAP),
      top: row * (cell + GAP),
    });
  }

  await sharp({
    create: {
      width: canvasSize,
      height: canvasSize,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite(composites)
    .jpeg({ quality: JPEG_QUALITY })
    .toFile(output);
}
