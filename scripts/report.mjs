import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert, cli, readJson, validateViews } from './common.mjs';

export const validateReview = (review, views) => {
  for (const view of views) view.id ??= String(view.width);
  validateViews(views);
  const byWidth = (width) => {
    const matches = views.filter(v => v.width === width);
    assert(matches.length === 1, 'Legacy width references must match exactly one frame; use viewId');
    return matches[0];
  };
  const reviewed = review.reviewedViews ?? (Array.isArray(review.reviewedWidths) ? review.reviewedWidths.map(w => byWidth(w).id) : undefined);
  assert(Array.isArray(reviewed) && reviewed.every(id => views.some(v => v.id === id)) && new Set(reviewed).size === reviewed.length, 'reviewedViews must contain unique known frame IDs');
  assert(Array.isArray(review.issues), 'issues must be an array');
  const ids = new Set();
  for (const issue of review.issues) {
    assert(typeof issue.id === 'string' && issue.id && !ids.has(issue.id), 'Issue IDs must be non-empty and unique'); ids.add(issue.id);
    const view = issue.viewId === undefined ? byWidth(issue.width) : views.find(v => v.id === issue.viewId);
    assert(view && reviewed.includes(view.id), 'Issue frame must have completed visual review');
    assert(issue.width === undefined || issue.width === view.width, 'Issue width must match frame width');
    issue.viewId = view.id;
    issue.width = view.width;
    assert(['major','minor','detail'].includes(issue.severity), 'severity must be major, minor or detail');
    for (const key of ['where','description']) assert(typeof issue[key] === 'string' && issue[key].trim(), `Issue ${key} is required`);
    assert(issue.suggestion === undefined || typeof issue.suggestion === 'string', 'suggestion must be text');
    for (const [key, width, height] of [['region', view.actualWidth ?? view.width, view.actualHeight], ['designRegion', view.width, view.designHeight]]) {
      const r = issue[key];
      if (key === 'designRegion' && r === undefined) continue;
      assert(r && ['x','y','width','height'].every(k => Number.isFinite(r[k])), `${key} must contain numeric x,y,width,height`);
      assert(r.x >= 0 && r.y >= 0 && r.width > 0 && r.height > 0 && r.x + r.width <= width && r.y + r.height <= height, `${key} lies outside the source image`);
    }
  }
  return { reviewedViews: reviewed, issues: review.issues };
};
export const report = async (directory) => {
  assert(directory, 'Usage: node scripts/report.mjs <run-directory>');
  const data = await readJson(path.join(directory, 'comparison.json'));
  const review = await readJson(path.join(directory, 'issues.json'));
  Object.assign(data, validateReview(review, data.views));
  for (const view of data.views) {
    view.images = {};
    for (const name of ['design','actual','diff','overlay']) {
      const bytes = await fs.readFile(path.join(directory, view.id, `${name}.png`));
      view.images[name] = `data:image/png;base64,${bytes.toString('base64')}`;
    }
  }
  const template = await fs.readFile(fileURLToPath(new URL('../assets/report.html', import.meta.url)), 'utf8');
  assert(template.split('__AUDIT_DATA__').length === 2, 'Report template must have exactly one data placeholder');
  const json = JSON.stringify(data).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
  const target = path.join(directory, 'report.html');
  await fs.writeFile(target, template.replace('__AUDIT_DATA__', () => json));
  console.log(target);
  return target;
};
cli(import.meta.url, report);
