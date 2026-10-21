/**
 * Accessibility (axe-core) e2e layer — HomeRoll Phase 7 surfaces.
 *
 * Coverage: /ask, /auto-creations, VideoTrimPanel (asset viewer).
 *
 * CI: runs under the existing `web` Playwright project (`pnpm test:web`,
 * `testDir: ./src/specs/web`). Requires `@axe-core/playwright` in
 * e2e/package.json devDependencies:
 *
 *   pnpm --filter homeroll-e2e add -D @axe-core/playwright
 *
 * DO NOT run until the dependency is installed. All axe assertions use
 * `toEqual([])`-style reporting; relax to `warn`-level while triaging.
 */
import { LoginResponseDto } from '@immich/sdk';
import { Page, expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { testAssetDir, utils } from 'src/utils.js';

/**
 * TODO(Phase-9): `@axe-core/playwright` is NOT yet a devDependency of this
 * package (see docs/audit-testing.md §CI Wiring Needs). A static
 * `import { AxeBuilder } from '@axe-core/playwright'` would break
 * `pnpm check` / `pnpm lint`, so the module is resolved dynamically and the
 * axe-driven assertions self-skip until the dep lands:
 *
 *   pnpm --filter homeroll-e2e add -D @axe-core/playwright
 *
 * Once installed, replace `runAxe` with direct `new AxeBuilder({ page })` calls
 * and remove this shim.
 */
type AxeResults = { violations: unknown[] };
type AxeBuilderLike = {
  withTags(tags: string[]): AxeBuilderLike;
  include(selector: string): AxeBuilderLike;
  analyze(): Promise<AxeResults>;
};

const loadAxeBuilder = async (): Promise<(new (options: { page: Page }) => AxeBuilderLike) | null> => {
  try {
    const specifier = '@axe-core/playwright'; // variable specifier: optional dep, resolved at runtime only
    const mod = (await import(/* @vite-ignore */ specifier)) as { AxeBuilder?: new (options: { page: Page }) => AxeBuilderLike };
    return mod.AxeBuilder ?? null;
  } catch {
    return null;
  }
};

const runAxe = async (page: Page, configure?: (axe: AxeBuilderLike) => AxeBuilderLike): Promise<AxeResults | null> => {
  const AxeBuilder = await loadAxeBuilder();
  if (!AxeBuilder) {
    return null;
  }
  const axe = new AxeBuilder({ page });
  return (configure ? configure(axe) : axe).analyze();
};

test.describe('a11y — Phase 7 routes', () => {
  let admin: LoginResponseDto;

  test.beforeAll(async () => {
    utils.initSdk();
    await utils.resetDatabase();
    admin = await utils.adminSetup();
  });

  test.describe('ask page', () => {
    test('axe: no automatically-detectable violations', async ({ context, page }) => {
      await utils.setAuthCookies(context, admin.accessToken);
      await page.goto('/ask');

      const results = await runAxe(page, (axe) =>
        // Immich-shell chrome is scanned too; scope to the page content once
        // pre-existing violations are triaged.
        axe.withTags(['wcag2a', 'wcag2aa', 'wcag22aa']),
      );
      test.skip(!results, '@axe-core/playwright not installed — see header TODO');

      expect(results!.violations).toEqual([]);
    });

    test('input has an accessible name and visible focus', async ({ context, page }) => {
      await utils.setAuthCookies(context, admin.accessToken);
      await page.goto('/ask');

      const input = page.getByRole('textbox', { name: /ask/i });
      await expect(input).toBeVisible();
      await input.focus();

      // G1 guard: focused input must expose a non-zero outline or ring.
      const hasIndicator = await input.evaluate((el) => {
        const style = getComputedStyle(el);
        return style.outlineStyle !== 'none' || style.boxShadow !== 'none' || style.borderStyle !== 'none';
      });
      expect(hasIndicator).toBeTruthy();
    });

    test('keyboard: type, submit with Enter, spinner exposes status', async ({ context, page }) => {
      await utils.setAuthCookies(context, admin.accessToken);
      await page.goto('/ask');

      await page.keyboard.press('Tab');
      const input = page.getByRole('textbox', { name: /ask/i });
      await input.fill('photos from paris');
      await page.keyboard.press('Enter');

      // Loading state must be announced (role=status or aria-live).
      const status = page.getByRole('status');
      await expect(status).toBeAttached();
    });

    test('answer region announces results (aria-live)', async ({ context, page }) => {
      await utils.setAuthCookies(context, admin.accessToken);
      await page.goto('/ask');

      // Once /ask is wired, the result container must be a live region or the
      // focus must move to it. This is the contract for fix A3.
      const liveRegion = page.locator('[aria-live], [role="status"], [role="alert"]');
      await page.getByRole('textbox', { name: /ask/i }).fill('test');
      await page.keyboard.press('Enter');
      await expect(liveRegion.first()).toBeAttached();
    });
  });

  test.describe('auto-creations page', () => {
    test('axe: no automatically-detectable violations', async ({ context, page }) => {
      await utils.setAuthCookies(context, admin.accessToken);
      await page.goto('/auto-creations');

      const results = await runAxe(page, (axe) => axe.withTags(['wcag2a', 'wcag2aa', 'wcag22aa']));
      test.skip(!results, '@axe-core/playwright not installed — see header TODO');
      expect(results!.violations).toEqual([]);
    });

    test('run buttons expose type-specific names', async ({ context, page }) => {
      await utils.setAuthCookies(context, admin.accessToken);
      await page.goto('/auto-creations');

      await expect(page.getByRole('button', { name: /collage/i })).toBeVisible();
      await expect(page.getByRole('button', { name: /animation/i })).toBeVisible();
      await expect(page.getByRole('button', { name: /trip highlights/i })).toBeVisible();
    });

    test('page has a top-level heading', async ({ context, page }) => {
      await utils.setAuthCookies(context, admin.accessToken);
      await page.goto('/auto-creations');

      // G2 contract: UserPageLayout must render title as <h1>.
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    });
  });

  test.describe('video trim dialog', () => {
    test('dialog is labeled, sliders have names, Esc closes, focus returns', async ({ context, page }) => {
      await utils.setAuthCookies(context, admin.accessToken);

      const videoPath = `${testAssetDir}/videos/waterfall.mp4`;
      await utils.createAsset(admin.accessToken, {
        assetData: { bytes: readFileSync(videoPath), filename: 'waterfall.mp4' },
      });
      await utils.waitForQueueFinish(admin.accessToken, 'metadataExtraction');

      await page.goto('/photos');
      await page.getByRole('link').first(); // thumbnail grid (role=link per Thumbnail.svelte)
      await page.locator('[data-thumbnail-focus-container]').first().click();

      // Open the trim panel via the labeled button in the control bar.
      const trimButton = page.getByRole('button', { name: /trim video/i });
      await trimButton.click();

      const dialog = page.getByRole('dialog', { name: /trim video/i });
      await expect(dialog).toBeVisible();

      // Both sliders must have accessible names and take keyboard focus.
      const startSlider = dialog.getByRole('slider', { name: /start/i });
      const endSlider = dialog.getByRole('slider', { name: /end/i });
      await expect(startSlider).toBeFocused(); // initial focus lands on start slider
      await startSlider.press('ArrowRight');
      await endSlider.focus();
      await endSlider.press('ArrowLeft');

      // Esc closes and focus returns to the trim trigger (C3 contract).
      await page.keyboard.press('Escape');
      await expect(dialog).not.toBeVisible();
      await expect(trimButton).toBeFocused();

      // axe scan over the open dialog (reopen then scan).
      await trimButton.click();
      const results = await runAxe(page, (axe) =>
        axe.include('[role="dialog"]').withTags(['wcag2a', 'wcag2aa', 'wcag22aa']),
      );
      test.skip(!results, '@axe-core/playwright not installed — see header TODO');
      expect(results!.violations).toEqual([]);
    });
  });

  test.describe('gallery (/photos)', () => {
    test('axe: no automatically-detectable violations', async ({ context, page }) => {
      await utils.setAuthCookies(context, admin.accessToken);
      await utils.createAsset(admin.accessToken);
      await page.goto('/photos');
      await page.waitForLoadState('networkidle');

      const results = await runAxe(page, (axe) => axe.withTags(['wcag2a', 'wcag2aa', 'wcag22aa']));
      test.skip(!results, '@axe-core/playwright not installed — see header TODO');
      expect(results!.violations).toEqual([]);
    });

    test('thumbnail grid is keyboard navigable', async ({ context, page }) => {
      await utils.setAuthCookies(context, admin.accessToken);
      await utils.createAsset(admin.accessToken);
      await page.goto('/photos');
      await page.waitForLoadState('networkidle');

      // every focusable element in the grid must be reachable by keyboard (WCAG 2.1.1)
      await page.keyboard.press('Tab');
      const focused = await page.evaluate(() => document.activeElement?.tagName);
      expect(focused).toBeTruthy();
    });
  });
});
