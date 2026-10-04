import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { assert, cli, readJson, writeJson } from './common.mjs';

export const verifyReport = async (directory, channel) => {
  const data = await readJson(path.join(directory, 'comparison.json'));
  const browser = await chromium.launch((channel ?? data.channel) ? { channel: channel ?? data.channel } : {});
  const errors = [];
  const checks = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(pathToFileURL(path.resolve(directory, 'report.html')).href);
    for (let i = 0; i < data.views.length; i++) {
      await page.locator(`#widths button[data-index="${i}"]`).click();
      for (const mode of ['side', 'overlay', 'diff']) {
        await page.locator(`#modes button[data-mode="${mode}"]`).click();
        await page.waitForFunction(({ mode, viewId }) => {
          const boards = document.querySelectorAll('#boards .board');
          const images = [...document.querySelectorAll('#boards img')];
          const label = document.querySelector('#boards figcaption')?.textContent ?? '';
          const state = document.querySelector('#boards').dataset;
          return state.viewId === viewId && state.mode === mode && boards.length === (mode === 'side' ? 2 : 1) && images.length > 0 && images.every(img => img.complete && img.naturalWidth > 0) && label.startsWith(mode === 'side' ? 'Figma' : mode === 'overlay' ? 'Наложение' : 'Разница');
        }, { mode, viewId: data.views[i].id });
        assert(await page.locator('#boards .notice').count() === 0, 'Report image failed to load');
        checks.push(`${data.views[i].id}:${mode}`);
      }
      for (const zoom of ['full', 'fit']) {
        await page.locator(`#zooms button[data-zoom="${zoom}"]`).click();
        await page.waitForFunction(zoom => document.querySelector('#boards').dataset.zoom === zoom, zoom);
        assert(await page.locator(`#zooms button[data-zoom="${zoom}"]`).getAttribute('aria-pressed') === 'true', 'Zoom control failed');
      }
      const issues = page.locator('#issues button.issue');
      for (let j = 0; j < await issues.count(); j++) {
        await issues.nth(j).click();
        const id = await issues.nth(j).locator('.issue-id').textContent();
        await page.waitForFunction(id => document.querySelector('#evidence').dataset.issueId === id && document.querySelector('#boards').dataset.issueId === id && document.querySelectorAll('#evidence canvas').length === 2 && Boolean(document.querySelector('#boards .region')), id);
        assert(await issues.nth(j).evaluate(node => node.scrollHeight <= node.clientHeight + 1), 'Issue card content is clipped');
        checks.push(`${data.views[i].id}:issue-${j+1}`);
      }
    }
    assert(errors.length === 0, `Report JavaScript errors: ${errors.join('; ')}`);
    await writeJson(path.join(directory, 'report-check.json'), { passed: true, checks, errors });
    console.log(`Report verified: ${checks.length} checks`);
  } catch (error) {
    await writeJson(path.join(directory, 'report-check.json'), { passed: false, checks, errors: [...errors, error.message] });
    throw error;
  } finally { await browser.close(); }
};
cli(import.meta.url, verifyReport);
