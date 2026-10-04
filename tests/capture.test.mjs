import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { once } from 'node:events';
import { capture } from '../scripts/capture.mjs';
import { run } from '../scripts/run.mjs';
import { blank, savePng, readPng, readJson, writeJson, loadConfig } from '../scripts/common.mjs';

test('selectors inherit from config and view overrides take precedence; invalid selectors rejected', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'audit-selectors-'));
  await savePng(path.join(dir, 'design.png'), blank(400, 150));
  const file = path.join(dir, 'config.json');
  const config = { title: 'Selectors', url: 'http://localhost', output: 'results', captureSelector: '#shared', readySelector: '#ready', views: [{ design: 'design.png' }, { design: 'design.png', captureSelector: '#override' }] };
  await writeJson(file, config);
  const loaded = await loadConfig(file);
  assert.equal(loaded.views[0].captureSelector, '#shared');
  assert.equal(loaded.views[1].captureSelector, '#override');
  assert.equal(loaded.views[1].readySelector, '#ready');
  config.captureSelector = '';
  await writeJson(file, config);
  await assert.rejects(loadConfig(file), /non-empty selector/);
});

test('capture pipeline preserves overflow and full-page evidence; report validates reviewed and unreviewed views', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'audit-pipeline-'));
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><html><body style="margin:0"><div style="height:200px"></div><section id="target" style="height:150px;background:#eee"><div style="width:430px;height:10px;background:red"></div>Target</section><div style="height:750px"></div><div class="duplicate"></div><div class="duplicate"></div></body></html>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const channel = process.platform === 'win32' ? 'msedge' : undefined;
  const config = { title: 'Pipeline', url: `http://127.0.0.1:${server.address().port}`, output: 'results', channel, captureSelector: '#target', views: [{ id: 'section', design: 'design.png' }, { id: 'full', design: 'design.png', captureSelector: 'body' }] };
  await savePng(path.join(dir, 'design.png'), blank(400, 150));
  const file = path.join(dir, 'config.json');
  await writeJson(file, config);
  try {
    const result = await run('capture', file);
    const actual = await readPng(path.join(result, 'section', 'actual.png'));
    const full = await readPng(path.join(result, 'section', 'actual-full-page.png'));
    assert.equal(actual.width, 430);
    assert.equal(actual.height, 150);
    assert.equal(full.height, 1100);
    const bounds = await readJson(path.join(result, 'section', 'capture-region.json'));
    assert.equal(bounds.y, 200);
    assert.deepEqual([...actual.data.subarray(0,4)], [...full.data.subarray(200*430*4,200*430*4+4)]);
    const compared = await readJson(path.join(result, 'comparison.json'));
    assert.equal(compared.views[0].actualWidth, 430);
    assert.ok(compared.views[0].warnings.some(w => w.includes('переполнение')));
    await writeJson(path.join(result, 'issues.json'), { reviewedViews: ['section'], issues: [{ id: 'V01', viewId: 'section', severity: 'minor', where: 'Target', description: 'Overflow retained', region: { x: 0, y: 0, width: 430, height: 30 }, designRegion: { x: 0, y: 0, width: 400, height: 30 } }] });
    await run('report', result);
    const check = await readJson(path.join(result, 'report-check.json'));
    assert.equal(check.passed, true);
    assert.ok(check.checks.includes('section:issue-1'));
    assert.ok(check.checks.includes('full:overlay'));
    config.output = 'duplicate-results';
    config.captureSelector = '.duplicate';
    config.views = [{ design: 'design.png' }];
    await writeJson(file, config);
    await assert.rejects(capture(file), /exactly one element/);
    await assert.rejects(fs.stat(path.join(dir, config.output)), { code: 'ENOENT' });
    config.output = 'failed-navigation';
    config.url = 'http://127.0.0.1:1';
    await writeJson(file, config);
    await assert.rejects(capture(file));
    await assert.rejects(fs.stat(path.join(dir, config.output)), { code: 'ENOENT' });
  } finally { server.close(); }
});
