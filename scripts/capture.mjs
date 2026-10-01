import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { assert, cli, loadConfig, writeJson } from './common.mjs';
export const capture = async (configFile) => {
  assert(configFile, 'Usage: node scripts/capture.mjs <config.json>');
  const config = await loadConfig(configFile);
  const prepare = config.prepare ? (await import(pathToFileURL(config.prepare).href)).default : null;
  assert(!config.prepare || typeof prepare === 'function', 'prepare module must export a default async arrow function');
  // Never mix a new capture with old screenshots or reviewed findings.
  await fs.mkdir(path.dirname(config.output), { recursive: true });
  await fs.mkdir(config.output);
  const browser = await chromium.launch(config.channel ? { channel: config.channel } : {});
  const result = { title: config.title, url: config.url, createdAt: new Date().toISOString(), browser: browser.version(), platform: process.platform, threshold: config.threshold, notes: config.notes, views: [] };
  try {
    for (const view of config.views) {
      const dir = path.join(config.output, view.id);
      await fs.mkdir(dir);
      await fs.copyFile(view.design, path.join(dir, 'design.png'));
      const warnings = [];
      const context = await browser.newContext({ viewport: { width: view.width, height: view.viewportHeight }, deviceScaleFactor: 1, colorScheme: 'light', reducedMotion: 'reduce', locale: config.locale ?? 'ru-RU', ...(config.storageState ? { storageState: config.storageState } : {}) });
      try {
        const page = await context.newPage();
        page.setDefaultTimeout(20000);
        page.on('pageerror', () => { if (!warnings.includes('На странице возникла JavaScript-ошибка.')) warnings.push('На странице возникла JavaScript-ошибка.'); });
        const response = await page.goto(config.url, { waitUntil: 'load', timeout: 45000 });
        assert(response && response.ok(), `Page returned HTTP ${response?.status() ?? 'no response'} at ${view.width}`);
        if (page.url() !== config.url) warnings.push('Страница перенаправлена. Проверьте, что открыт нужный маршрут и состояние.');
        if (prepare) await prepare(page, view.width);
        if (config.readySelector) await page.locator(config.readySelector).waitFor({ state: 'visible' });
        await page.addStyleTag({ content: 'html { scroll-behavior: auto !important; } *, *::before, *::after { transition: none !important; caret-color: transparent !important; }' });
        await page.waitForFunction(() => document.fonts.status === 'loaded');
        // Bounded traversal triggers lazy images without hanging on infinite feeds.
        let reachedBottom = false;
        for (let step = 0; step < 100; step++) {
          const state = await page.evaluate(() => ({ y: window.scrollY, height: document.documentElement.scrollHeight, viewport: innerHeight }));
          assert(state.height <= 30000, 'Page exceeds 30,000px; use a finite page state');
          if (state.y + state.viewport >= state.height - 2) { reachedBottom = true; break; }
          await page.evaluate(() => window.scrollBy(0, Math.round(innerHeight * 0.8)));
          await page.waitForTimeout(120);
        }
        assert(reachedBottom, 'Lazy-loading scroll did not reach the bottom within 100 steps');
        try {
          await page.waitForFunction(() => [...document.images].every(img => img.complete), { }, { timeout: 10000 });
          await page.evaluate(async () => { await Promise.all([...document.images].map(img => img.decode().catch(() => {}))); });
        } catch { warnings.push('Не все изображения завершили загрузку.'); }
        const broken = await page.evaluate(() => [...document.images].filter(img => !img.complete || img.naturalWidth === 0).length);
        if (broken) warnings.push(`Незагруженных или повреждённых изображений: ${broken}.`);
        await page.evaluate(() => { document.querySelectorAll('video').forEach(v => v.pause()); window.scrollTo(0, 0); });
        await page.waitForFunction(() => document.fonts.status === 'loaded');
        await page.mouse.move(-1, -1);
        await page.waitForTimeout(300);
        const options = { fullPage: true, animations: 'disabled', caret: 'hide', scale: 'css', timeout: 20000 };
        let previous = await page.screenshot(options);
        let current = previous;
        let stabilityPercent = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          await page.waitForTimeout(350);
          current = await page.screenshot(options);
          const a = PNG.sync.read(previous), b = PNG.sync.read(current);
          if (a.width === b.width && a.height === b.height) {
            stabilityPercent = pixelmatch(a.data, b.data, null, a.width, a.height, { threshold: 0.1 }) / (a.width * a.height) * 100;
            if (stabilityPercent === 0) break;
          } else stabilityPercent = null;
          previous = current;
        }
        if (stabilityPercent !== 0) warnings.push('Скриншоты не стабилизировались; динамические области требуют проверки.');
        const actual = PNG.sync.read(current);
        if (actual.width !== view.width) warnings.push(`Горизонтальное переполнение: скриншот ${actual.width}px при окне ${view.width}px.`);
        await fs.writeFile(path.join(dir, 'actual.png'), current);
        result.views.push({ id: view.id, width: view.width, viewportHeight: view.viewportHeight, figmaUrl: view.figmaUrl, designVersion: view.designVersion ?? null, stabilityPercent, warnings });
        console.log(`Captured ${view.width} × ${actual.height}`);
      } finally { await context.close(); }
    }
    await writeJson(path.join(config.output, 'capture.json'), result);
    console.log(config.output);
    return config.output;
  } finally { await browser.close(); }
};
cli(import.meta.url, capture);
