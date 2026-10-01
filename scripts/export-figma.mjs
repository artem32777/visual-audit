import fs from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';
import { assert, cli, readJson, validateViews, writeJson } from './common.mjs';

export const parseFigma = (value) => {
  const url = new URL(value);
  assert(url.protocol === 'https:' && ['figma.com', 'www.figma.com'].includes(url.hostname), 'Expected a Figma HTTPS URL');
  const match = url.pathname.match(/^\/(?:design|file)\/([a-zA-Z0-9]+)(?:\/|$)/);
  const nodeId = url.searchParams.get('node-id')?.replaceAll('-', ':');
  assert(match && nodeId && /^\d+:\d+$/.test(nodeId), 'Figma frame URL must contain file key and node-id');
  return { key: match[1], nodeId };
};
export const exportFigma = async (configFile) => {
  assert(configFile, 'Usage: export-figma.mjs <config.json>; requires FIGMA_TOKEN environment variable');
  const token = process.env.FIGMA_TOKEN;
  assert(token, 'FIGMA_TOKEN is not configured. Use an original PNG from Figma MCP or configure a read-only Figma token.');
  const config = await readJson(configFile);
  validateViews(config.views, true);
  const base = path.dirname(path.resolve(configFile));
  const staged = [], versions = new Map();
  const api = async (pathname, params) => {
    const url = new URL('https://api.figma.com/v1/' + pathname);
    for (const [key,value] of Object.entries(params)) if (value) url.searchParams.set(key,value);
    const response = await fetch(url, { headers: { 'X-Figma-Token': token }, signal: AbortSignal.timeout(30000), redirect: 'error' });
    assert(response.ok, `Figma API HTTP ${response.status}${response.status === 429 ? '; respect Retry-After: ' + response.headers.get('retry-after') : ''}`);
    return response.json();
  };
  for (const view of config.views) {
    if (view.figmaUrl === undefined) continue;
    const { key, nodeId } = parseFigma(view.figmaUrl);
    assert(typeof view.design === 'string' && view.design, 'Each view requires a design output path');
    const target = path.resolve(base, view.design);
    await fs.access(target).then(() => { throw new Error(`Design already exists: ${target}`); }, error => { if (error.code !== 'ENOENT') throw error; });
    const requestedVersion = view.designVersion ?? versions.get(key);
    const meta = await api(`files/${key}/nodes`, { ids: nodeId, version: requestedVersion });
    const node = meta.nodes?.[nodeId]?.document;
    const frameWidth = node?.absoluteBoundingBox?.width;
    assert(node?.type === 'FRAME' && Number.isSafeInteger(frameWidth) && frameWidth > 0, 'Expected a Figma frame with an integer CSS-pixel width; fractional widths cannot be captured exactly');
    assert(view.width === undefined || view.width === frameWidth, `Configured width ${view.width} != Figma frame width ${frameWidth}`);
    view.width = frameWidth;
    assert(typeof meta.version === 'string' && meta.version, 'Figma did not return a file version');
    versions.set(key, meta.version);
    const images = await api(`images/${key}`, { ids: nodeId, format: 'png', scale: '1', use_absolute_bounds: 'true', version: meta.version });
    const download = images.images?.[nodeId];
    assert(download && new URL(download).protocol === 'https:', 'Figma did not return a PNG download URL');
    // Never forward the Figma token to a signed image CDN URL.
    const response = await fetch(download, { signal: AbortSignal.timeout(60000) });
    assert(response.ok, `Figma PNG download HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert(bytes.length >= 24 && bytes.readUInt32BE(16) * bytes.readUInt32BE(20) <= 60000000, 'Export is too large');
    const png = PNG.sync.read(bytes);
    assert(png.width === view.width, `Export width ${png.width} != ${view.width}; check effects or frame bounds`);
    staged.push({ target, bytes });
    view.designVersion = meta.version;
  }
  assert(new Set(staged.map(item => item.target)).size === staged.length, 'Design output paths must be distinct');
  for (const { target, bytes } of staged) { await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes, { flag: 'wx' }); }
  await writeJson(configFile, config);
  console.log(`Exported ${staged.length} 1x Figma frame(s); widths and versions recorded in config.`);
};
cli(import.meta.url, exportFigma);

