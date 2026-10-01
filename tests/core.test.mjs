import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blank } from '../scripts/common.mjs';
import { compareImages } from '../scripts/compare.mjs';
import { validateReview } from '../scripts/report.mjs';
import { parseFigma, exportFigma } from '../scripts/export-figma.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { report } from '../scripts/report.mjs';
import { crop } from '../scripts/crop.mjs';
import { readPng, savePng, writeJson, loadConfig, validateViews } from '../scripts/common.mjs';
import { PNG } from 'pngjs';

test('identical and fully different pixels produce correct percentages', () => {
  assert.equal(compareImages(blank(20, 20), blank(20, 20)).mismatchPercent, 0);
  assert.equal(compareImages(blank(20, 20), blank(20, 20, [0,0,0,255])).mismatchPercent, 100);
});
test('missing white area remains a mismatch without stretching either original', () => {
  const result = compareImages(blank(20, 20), blank(20, 40));
  assert.equal(result.mismatchPercent, 50);
  assert.deepEqual([...result.diff.data.subarray(20*20*4, 20*20*4+4)], [255,0,0,255]);
});
test('horizontal overflow counts missing canvas and preserves original size', () => {
  const result = compareImages(blank(20, 20), blank(40, 20));
  assert.equal(result.width, 40);
  assert.equal(result.mismatchPercent, 50);
});
test('transparent source is composited on white for comparison', () => {
  assert.equal(compareImages(blank(20, 20, [0,0,0,0]), blank(20, 20)).mismatchPercent, 0);
});
test('review rejects unreviewed widths, duplicate IDs and out-of-image boxes', () => {
  const views = [{ width: 360, actualHeight: 800, designHeight: 700 }];
  const issue = { id: 'V01', width: 360, severity: 'minor', where: 'Title', description: 'Wrap', region: {x: 10,y: 10,width: 200,height: 50} };
  assert.doesNotThrow(() => validateReview({ reviewedWidths: [360], issues: [issue] }, views));
  assert.throws(() => validateReview({ reviewedWidths: [], issues: [issue] }, views), /completed/);
  assert.throws(() => validateReview({ reviewedWidths: [360], issues: [issue, issue] }, views), /unique/);
  assert.throws(() => validateReview({ reviewedWidths: [360], issues: [{...issue, region: {...issue.region, y: 790}}] }, views), /outside/);
});
test('Figma URL parsing rejects unrelated hosts and missing frame IDs', () => {
  assert.deepEqual(parseFigma('https://www.figma.com/design/ABC/Title?node-id=12-34'), {key:'ABC',nodeId:'12:34'});
  assert.throws(() => parseFigma('https://evil.example/design/ABC/Title?node-id=12-34'));
  assert.throws(() => parseFigma('https://figma.com/design/ABC/Title'));
});

test('report is self-contained, escapes embedded script data, and keeps unreviewed state', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'visual-audit-report-'));
  const view = {width:360,viewportHeight:800,actualHeight:20,designHeight:20,heightDelta:0,mismatchPercent:0,warnings:[],figmaUrl:'https://figma.com/design/ABC/A?node-id=1-2'};
  await fs.mkdir(path.join(dir,'360'));
  for (const name of ['actual','design','diff','overlay']) await savePng(path.join(dir,'360',name+'.png'), blank(360,20));
  await writeJson(path.join(dir,'comparison.json'), {title:'</script><script>window.injected=true</script>',url:'http://localhost',createdAt:new Date().toISOString(),views:[view]});
  await writeJson(path.join(dir,'issues.json'), {reviewedWidths:[],issues:[]});
  const html = await fs.readFile(await report(dir),'utf8');
  assert.ok(!html.includes('</script><script>window.injected'));
  assert.ok(html.includes('\\u003c/script>'));
  assert.ok(html.includes('"reviewedViews":[]'));
  assert.equal((html.match(/data:image\/png;base64,/g) ?? []).length,4);
  assert.ok(!html.includes('__AUDIT_DATA__'));
});

test('crop preserves original pixels and rejects out-of-bounds requests', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'visual-audit-crop-'));
  const input = path.join(dir,'input.png'), output = path.join(dir,'crop.png');
  const png = blank(20,20); png.data.set([10,20,30,255], (5*20+5)*4);
  await savePng(input,png);
  await crop(input,output,'5','5','10','10');
  const result = await readPng(output);
  assert.deepEqual([...result.data.subarray(0,4)],[10,20,30,255]);
  assert.equal(result.width,10);
  await assert.rejects(crop(input,output,'19','19','10','10'),/inside/);
});

test('single frame uses original PNG width when omitted and a finite default height', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'visual-audit-config-'));
  await savePng(path.join(dir,'design.png'), blank(853,20));
  const file = path.join(dir,'config.json');
  await writeJson(file,{title:'Single',url:'http://localhost',output:'run',views:[{design:'design.png',figmaUrl:'https://figma.com/design/ABC/A?node-id=1-2'}]});
  const config = await loadConfig(file);
  assert.equal(config.views.length,1);
  assert.equal(config.views[0].width,853);
  assert.equal(config.views[0].viewportHeight,900);
  assert.equal(config.views[0].id,'frame-1');
  config.views[0].width = 854;
  await writeJson(file, config);
  await assert.rejects(loadConfig(file),/export at 1x/);
});

test('any positive integer widths and count supported; unsafe or duplicate IDs rejected', () => {
  const views = [1440,1024,390,853].map(width => ({width}));
  assert.doesNotThrow(() => validateViews(views));
  assert.deepEqual(views.map(v => v.width),[1440,1024,390,853]);
  assert.throws(() => validateViews([]),/At least one/);
  assert.throws(() => validateViews([{width:390.5}]),/positive integer/);
  assert.throws(() => validateViews([{id:'../x',width:390}]),/safe/);
  assert.throws(() => validateViews([{id:'same',width:390},{id:'same',width:1024}]),/unique/);
});

test('same-width frames keep independent review state and issue association', () => {
  const views = ['first','second'].map(id => ({id,width:853,actualHeight:800,designHeight:800}));
  const issue = {id:'V01',viewId:'second',severity:'minor',where:'Title',description:'Different',region:{x:0,y:0,width:200,height:50}};
  assert.throws(() => validateReview({reviewedViews:['first'],issues:[issue]},views),/completed/);
  const result = validateReview({reviewedViews:['second'],issues:[issue]},views);
  assert.deepEqual(result.reviewedViews,['second']);
  assert.equal(result.issues[0].width,853);
  assert.throws(() => validateReview({reviewedWidths:[853],issues:[]},views),/exactly one/);
});

test('REST export discovers actual frame width and records it without preset sizes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'visual-audit-export-'));
  const file = path.join(dir,'config.json');
  await savePng(path.join(dir,'image.png'), blank(413,20));
  await writeJson(file,{views:[{design:'design.png',figmaUrl:'https://figma.com/design/ABC/A?node-id=1-2'},{design:'image.png'}]});
  const originalFetch = globalThis.fetch, originalToken = process.env.FIGMA_TOKEN;
  process.env.FIGMA_TOKEN = 'test-only-token';
  globalThis.fetch = async (input, options) => {
    const url = new URL(input);
    if (url.hostname === 'api.figma.com') {
      assert.equal(options.headers['X-Figma-Token'],'test-only-token');
      if (url.pathname.endsWith('/nodes')) return Response.json({version:'v1',nodes:{'1:2':{document:{type:'FRAME',absoluteBoundingBox:{width:853,height:20}}}}});
      assert.equal(url.searchParams.get('scale'),'1');
      assert.equal(url.searchParams.get('version'),'v1');
      return Response.json({images:{'1:2':'https://cdn.example/frame.png'}});
    }
    assert.equal(options.headers,undefined);
    return new Response(PNG.sync.write(blank(853,20)));
  };
  try {
    await exportFigma(file);
    const config = JSON.parse(await fs.readFile(file,'utf8'));
    assert.equal(config.views[0].width,853);
    assert.equal(config.views[0].designVersion,'v1');
    assert.equal(config.views[1].figmaUrl,undefined);
    assert.equal((await readPng(path.join(dir,'image.png'))).width,413);
    assert.equal((await readPng(path.join(dir,'design.png'))).width,853);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.FIGMA_TOKEN; else process.env.FIGMA_TOKEN = originalToken;
  }
});

test('image references need no Figma URL and each uses its own original width', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'visual-audit-images-'));
  const views = [];
  for (const width of [1467, 987, 413]) {
    const design = `image-${width}.png`;
    await savePng(path.join(dir, design), blank(width, 20));
    views.push({ design });
  }
  const file = path.join(dir, 'config.json');
  await writeJson(file, { title: 'Images', url: 'http://localhost', output: 'run', views });
  const config = await loadConfig(file);
  assert.deepEqual(config.views.map(view => view.width), [1467, 987, 413]);
  assert.ok(config.views.every(view => view.figmaUrl === undefined));
  config.views[0].figmaUrl = 'file:///invalid';
  await writeJson(file, config);
  await assert.rejects(loadConfig(file), /figmaUrl must be HTTPS/);
});

