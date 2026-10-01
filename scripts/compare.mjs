import fs from 'node:fs/promises';
import path from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { assert, blank, cli, onWhite, readJson, readPng, savePng, validateViews, writeJson } from './common.mjs';

export const compareImages = (design, actual, threshold = 0.1) => {
  const width = Math.max(design.width, actual.width), height = Math.max(design.height, actual.height);
  assert(width * height <= 60000000, 'Comparison canvas exceeds 60 million pixels');
  const a = onWhite(design, width, height), b = onWhite(actual, width, height);
  const diff = blank(width, height), overlay = blank(width, height);
  let mismatch = pixelmatch(a.data, b.data, diff.data, width, height, { threshold, includeAA: false });
  // Missing canvas is always a difference, even when both backgrounds are white.
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    for (let c = 0; c < 3; c++) overlay.data[i + c] = Math.round((a.data[i + c] + b.data[i + c]) / 2);
    const inA = x < design.width && y < design.height, inB = x < actual.width && y < actual.height;
    if (inA !== inB) {
      if (!(diff.data[i] === 255 && diff.data[i + 1] === 0 && diff.data[i + 2] === 0)) mismatch++;
      diff.data.set([255,0,0,255], i);
    }
  }
  return { diff, overlay, mismatchPercent: mismatch / (width * height) * 100, width, height };
};
export const compare = async (directory) => {
  assert(directory, 'Usage: node scripts/compare.mjs <run-directory>');
  const data = await readJson(path.join(directory, 'capture.json'));
  // Keep old width-named runs readable; new captures are keyed by frame ID.
  for (const view of data.views ?? []) view.id ??= String(view.width);
  validateViews(data.views);
  for (const view of data.views) {
    const dir = path.join(directory, view.id);
    const design = await readPng(path.join(dir, 'design.png')), actual = await readPng(path.join(dir, 'actual.png'));
    assert(design.width === view.width, 'Design export must be exactly 1x');
    const result = compareImages(design, actual, data.threshold);
    await savePng(path.join(dir, 'diff.png'), result.diff);
    await savePng(path.join(dir, 'overlay.png'), result.overlay);
    Object.assign(view, { designHeight: design.height, actualHeight: actual.height, actualWidth: actual.width, heightDelta: actual.height - design.height, mismatchPercent: result.mismatchPercent, threshold: data.threshold });
    // Full resolution strips for model inspection; y is in original screenshot pixels.
    view.tiles = [];
    const tilesDir = path.join(dir, 'tiles');
    await fs.mkdir(tilesDir, { recursive: true });
    for (let y = 0; y < result.height; y += 900) {
      const tile = { y, images: {} };
      for (const [name, png] of [['design', design], ['actual', actual], ['diff', result.diff]]) {
        if (y >= png.height) continue;
        const height = Math.min(1000, png.height - y);
        const crop = new PNG({ width: png.width, height });
        PNG.bitblt(png, crop, 0, y, png.width, height, 0, 0);
        const file = `tiles/${name}-${y}.png`;
        await savePng(path.join(dir, file), crop);
        tile.images[name] = file;
      }
      view.tiles.push(tile);
    }
    console.log(`${view.width}: ${result.mismatchPercent.toFixed(2)}% pixels, height delta ${view.heightDelta}px`);
  }
  await writeJson(path.join(directory, 'comparison.json'), data);
  // Exclusive create preserves the agent's existing review if diff is rerun.
  await fs.writeFile(path.join(directory, 'issues.json'), JSON.stringify({ reviewedViews: [], issues: [] }, null, 2) + '\n', { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  return data;
};
cli(import.meta.url, compare);
