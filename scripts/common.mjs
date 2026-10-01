import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PNG } from 'pngjs';

export const defaultViewportHeight = 900;
export const assert = (condition, message) => { if (!condition) throw new Error(message); };
export const validateViews = (views, allowMissingWidth = false) => {
  assert(Array.isArray(views) && views.length > 0, 'At least one Figma frame is required');
  const ids = new Set();
  for (const [index, view] of views.entries()) {
    view.id ??= `frame-${index + 1}`;
    assert(typeof view.id === 'string' && /^[a-zA-Z0-9_-]+$/.test(view.id) && !ids.has(view.id), 'Frame IDs must be unique safe directory names');
    ids.add(view.id);
    assert((allowMissingWidth && view.width === undefined) || (Number.isSafeInteger(view.width) && view.width > 0), 'Frame width must be a positive integer from Figma');
  }
};
export const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
export const writeJson = async (file, data) => fs.writeFile(file, JSON.stringify(data, null, 2) + '\n');
export const readPng = async (file) => {
  const buffer = await fs.readFile(file);
  assert(buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])), `Expected PNG: ${file}`);
  assert(buffer.readUInt32BE(16) * buffer.readUInt32BE(20) <= 60000000, `Image exceeds 60 million pixels: ${file}`);
  return PNG.sync.read(buffer);
};
export const savePng = async (file, png) => fs.writeFile(file, PNG.sync.write(png));
export const blank = (width, height, color = [255,255,255,255]) => {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) png.data.set(color, i);
  return png;
};
export const onWhite = (source, width, height) => {
  const png = blank(width, height);
  for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) {
    const s = (y * source.width + x) * 4;
    const d = (y * width + x) * 4;
    const alpha = source.data[s + 3] / 255;
    for (let c = 0; c < 3; c++) png.data[d + c] = Math.round(source.data[s + c] * alpha + 255 * (1 - alpha));
  }
  return png;
};
export const httpUrl = (value, httpsOnly = false) => {
  try { const url = new URL(value); return (httpsOnly ? ['https:'] : ['http:', 'https:']).includes(url.protocol) && !url.username && !url.password; } catch { return false; }
};
export const loadConfig = async (file) => {
  const config = await readJson(file);
  const base = path.dirname(path.resolve(file));
  assert(typeof config.title === 'string' && config.title.trim(), 'config.title is required');
  assert(httpUrl(config.url), 'config.url must be an HTTP(S) URL without embedded credentials');
  assert(typeof config.output === 'string' && config.output, 'config.output must name a new run directory');
  validateViews(config.views, true);
  config.threshold ??= 0.1;
  assert(Number.isFinite(config.threshold) && config.threshold >= 0 && config.threshold <= 1, 'threshold must be 0..1');
  config.output = path.resolve(base, config.output);
  for (const view of config.views) {
    assert(typeof view.design === 'string' && view.design, `Missing design PNG for ${view.width}`);
    view.design = path.resolve(base, view.design);
    view.viewportHeight ??= defaultViewportHeight;
    assert(Number.isInteger(view.viewportHeight) && view.viewportHeight >= 200 && view.viewportHeight <= 4000, 'viewportHeight must be 200..4000');
    assert(view.figmaUrl === undefined || httpUrl(view.figmaUrl, true), 'figmaUrl must be HTTPS when provided');
    const png = await readPng(view.design);
    view.width ??= png.width;
    assert(png.width === view.width, `Figma PNG width ${png.width} != ${view.width}; export at 1x, do not resize`);
  }
  validateViews(config.views);
  for (const key of ['storageState', 'prepare']) if (config[key]) config[key] = path.resolve(base, config[key]);
  config.notes ??= [];
  assert(Array.isArray(config.notes) && config.notes.every(n => typeof n === 'string'), 'notes must be strings');
  return config;
};
export const cli = (url, run) => {
  if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === url) run(...process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
};

