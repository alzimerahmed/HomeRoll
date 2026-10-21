import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCollage } from 'src/utils/collage.js';

describe('createCollage', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'collage-'));
  });

  afterAll(async () => {
    // temp dirs are OS-managed; no cleanup needed
  });

  const makeImage = async (color: { r: number; g: number; b: number }) => {
    const path = join(dir, `${color.r}-${color.g}-${color.b}.jpg`);
    await sharp({ create: { width: 100, height: 100, channels: 3, background: color } }).jpeg().toFile(path);
    return path;
  };

  it('should reject an empty input list', async () => {
    await expect(createCollage([], join(dir, 'out.jpg'))).rejects.toThrow(/at least one/i);
  });

  it('should produce a square collage from four inputs', async () => {
    const inputs = await Promise.all([
      makeImage({ r: 255, g: 0, b: 0 }),
      makeImage({ r: 0, g: 255, b: 0 }),
      makeImage({ r: 0, g: 0, b: 255 }),
      makeImage({ r: 255, g: 255, b: 0 }),
    ]);
    const output = join(dir, 'four.jpg');

    await createCollage(inputs.map((path) => ({ path })), output);

    const meta = await sharp(await readFile(output)).metadata();
    expect(meta.width).toBe(meta.height);
    expect(meta.width).toBeGreaterThan(1000);
  });

  it('should produce a single-cell collage from one input', async () => {
    const input = await makeImage({ r: 10, g: 200, b: 30 });
    const output = join(dir, 'one.jpg');

    await createCollage([{ path: input }], output);

    const meta = await sharp(await readFile(output)).metadata();
    expect(meta.width).toBe(meta.height);
  });
});
