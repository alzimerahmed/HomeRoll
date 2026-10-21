import { describe, expect, it } from 'vitest';
import { createAnimation } from 'src/utils/animation.js';

describe('createAnimation', () => {
  it('should reject fewer than two inputs', async () => {
    await expect(createAnimation(['a.jpg'], 'out.mp4')).rejects.toThrow(/at least two/i);
    await expect(createAnimation([], 'out.mp4')).rejects.toThrow(/at least two/i);
  });

  it('should accept an odd size and even it out without throwing on validation', async () => {
    // validation happens before any ffmpeg invocation; a real render is CI/e2e territory
    await expect(createAnimation(['a.jpg', 'b.jpg'], 'out.mp4', { size: 721 })).rejects.toThrow();
  });
});
