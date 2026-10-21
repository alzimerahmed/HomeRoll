/**
 * Visual regression layer (Phase 9 quality gate) for the key HomeRoll web surfaces:
 * gallery (/photos), asset viewer (/photos/:id), Ask HomeRoll (/ask) and
 * auto-creations (/auto-creations).
 *
 * BASELINE GENERATION
 * -------------------
 * Baseline snapshots are NOT committed. They are generated on the first CI run:
 *
 *   pnpm --filter homeroll-e2e exec playwright test --project=web \
 *     --update-snapshots src/specs/web/visual-regression.e2e-spec.ts
 *
 * Run that once on a PR, then commit the resulting
 * `src/specs/web/visual-regression.e2e-spec.ts-snapshots/` directory (PNG files,
 * per platform suffix e.g. `-chromium-linux.png`). Subsequent runs compare
 * against them; CI fails on pixel diffs beyond `maxDiffPixelRatio`.
 *
 * Stability notes:
 * - `page.waitForLoadState('networkidle')` before every capture.
 * - Dynamic regions (timestamps, relative-time labels, asset/job counts, map
 *   tiles) are masked via `mask` locators rather than lowering the diff
 *   threshold globally.
 * - Keep `animations: 'disabled'` and `caret: 'hide'` on every assertion.
 */
import { LoginResponseDto } from '@immich/sdk';
import { expect, test } from '@playwright/test';
import { utils } from 'src/utils.js';

// generous pixel budget: thumbnails render from real jpeg decodes which can
// differ by a few pixels across runner hardware
const SNAPSHOT_OPTIONS = {
  animations: 'disabled',
  caret: 'hide',
  maxDiffPixelRatio: 0.02,
} as const;

test.describe('Visual regression', () => {
  let admin: LoginResponseDto;
  let assetId: string;

  test.beforeAll(async () => {
    utils.initSdk();
    await utils.resetDatabase();
    admin = await utils.adminSetup();
    const asset = await utils.createAsset(admin.accessToken);
    assetId = asset.id;
    await utils.waitForQueueFinish(admin.accessToken, 'thumbnailGeneration');
  });

  test.beforeEach(async ({ context }) => {
    await utils.setAuthCookies(context, admin.accessToken);
  });

  test('gallery timeline', async ({ page }) => {
    await page.goto('/photos');
    await page.waitForLoadState('networkidle');

    await expect(page).toHaveScreenshot('gallery-timeline.png', {
      ...SNAPSHOT_OPTIONS,
      mask: [
        // relative dates, storage/quota figures and the user avatar initials
        page.getByText(/\bago\b|yesterday|today/i),
        page.locator('[data-testid="sidebar-storage"], .storage, [class*="quota" i]'),
        page.locator('[data-testid="user-avatar"], [class*="avatar" i]'),
      ],
    });
  });

  test('asset viewer', async ({ page }) => {
    await page.goto(`/photos/${assetId}`);
    await page.waitForLoadState('networkidle');
    // wait for the preview to actually render pixels
    const preview = page.getByTestId('preview').filter({ visible: true });
    await expect(preview).toHaveAttribute('src', /.+/);

    await expect(page).toHaveScreenshot('asset-viewer.png', {
      ...SNAPSHOT_OPTIONS,
      mask: [
        // filename / taken-at / camera metadata in the detail panel
        page.locator('[class*="detail" i], [data-testid*="detail" i]').getByText(/\d{4}| ago|IMG_|\.jpe?g/i),
      ],
    });
  });

  test('ask homeroll (empty state)', async ({ page }) => {
    await page.goto('/ask');
    await page.waitForLoadState('networkidle');

    await expect(page).toHaveScreenshot('ask-empty.png', {
      ...SNAPSHOT_OPTIONS,
      mask: [page.locator('[class*="avatar" i]')],
    });
  });

  test('auto-creations', async ({ page }) => {
    await page.goto('/auto-creations');
    await page.waitForLoadState('networkidle');

    await expect(page).toHaveScreenshot('auto-creations.png', {
      ...SNAPSHOT_OPTIONS,
      mask: [
        // "last run"/job timestamps and any per-run counters
        page.getByText(/ago|last run|queued|running/i),
        page.locator('[class*="avatar" i]'),
      ],
    });
  });
});
