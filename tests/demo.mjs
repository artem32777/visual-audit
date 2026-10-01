import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';
import { capture } from '../scripts/capture.mjs';
import { compare } from '../scripts/compare.mjs';
import { report } from '../scripts/report.mjs';
import { defaultViewportHeight, writeJson } from '../scripts/common.mjs';
const widths = (process.argv[3] ?? '1440,1024,390').split(',').map(Number);

// Synthetic fixture only: these images are not actual Figma exports.
const output = path.resolve(process.argv[2] ?? 'demo-output');
const channel = process.env.AUDIT_TEST_CHANNEL || 'msedge';
await fs.mkdir(output, { recursive: true });
const pageHtml = (design) => `<!doctype html><html lang="ru"><meta charset="utf-8"><title>Тестовая страница</title><style>
*{box-sizing:border-box}body{margin:0;font:18px Arial;background:#faf9f5;color:#21332d}header{height:96px;padding:32px 6%;border-bottom:1px solid #ddd;display:flex;justify-content:space-between}main{padding:80px 6%}h1{font-size:64px;font-weight:500;max-width:900px;margin:0 0 32px}.lead{max-width:650px;line-height:1.6}button{border:0;background:${design ? '#235c49' : '#b44327'};color:white;padding:20px 36px;font:inherit;margin:20px 0 50px}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:${design ? 24 : 48}px}.card{height:360px;background:#e1e8da;padding:30px;border-radius:12px}.card:nth-child(2){background:#e8dfca}.card:nth-child(3){background:#d9e6ea}.spacer{height:850px;background:linear-gradient(#faf9f5,#e7ebe2);padding:70px 6%}.end{padding:60px 6%;background:#21332d;color:white;height:${design ? 300 : 360}px} @media(max-width:1300px){h1{font-size:52px}.card{height:280px}}@media(max-width:600px){header{height:80px;padding:28px 20px;font-size:14px}main{padding:48px 20px}h1{font-size:${design ? 36 : 42}px}.cards{grid-template-columns:1fr;gap:24px}.card{height:230px}.spacer{height:500px}}
</style><header><b>СЕВЕР / ЖИЛЫЕ ПРОСТРАНСТВА</b><span>Каталог</span></header><main><h1>Место для вашей новой истории</h1><p class="lead">Демонстрационная страница для проверки visual-audit. Макет и браузер намеренно отличаются цветом кнопки, интервалами и высотой подвала.</p><button>Выбрать квартиру</button><div class="cards"><div class="card">01<br><h2>У парка</h2>Тишина рядом с городом</div><div class="card">02<br><h2>У реки</h2>Пространство для прогулок</div><div class="card">03<br><h2>В центре</h2>Всё важное рядом</div></div></main><section class="spacer"><h2>Пространство для жизни</h2><p>Нижняя часть страницы проверяет длинную прокрутку.</p></section><footer class="end"><h2>Начните свою историю</h2><p>Тестовый подвал</p></footer></html>`;
const server = http.createServer((req,res) => { res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'}); res.end(pageHtml(req.url === '/design')); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
try {
  const browser = await chromium.launch({ channel });
  try {
    for (const width of widths) {
      const context = await browser.newContext({ viewport: {width,height:defaultViewportHeight},deviceScaleFactor:1 });
      const page = await context.newPage();
      await page.goto(baseUrl + '/design');
      await page.screenshot({ path: path.join(output, `design-${width}.png`),fullPage:true });
      await context.close();
    }
  } finally { await browser.close(); }
  const configFile = path.join(output, 'config.json');
  await writeJson(configFile, { title:'Демонстрация · намеренные расхождения',url:baseUrl + '/actual',output:'run',channel,notes:['Тестовый пример: эталоны созданы из HTML, это не реальный аудит Figma.'],views:widths.map(width => ({ width,design:`design-${width}.png`,figmaUrl:`https://www.figma.com/design/DEMO/Fixture?node-id=1-${width}` })) });
  const run = await capture(configFile);
  await compare(run);
  await writeJson(path.join(run, 'issues.json'), { reviewedWidths:widths, issues:widths.map((width,i) => ({id:`V0${i+1}`,width,severity:'minor',where:'Подвал страницы',description:'В тестовой версии подвал на 60 px выше эталона.',suggestion:'Проверить высоту и внутренние отступы подвала.',region:{x:0,y:0,width:Math.min(300,width),height:70}})) });
  // Read measured dimensions rather than assuming the fixture's total height.
  const comparison = JSON.parse(await fs.readFile(path.join(run,'comparison.json'),'utf8'));
  const review = JSON.parse(await fs.readFile(path.join(run,'issues.json'),'utf8'));
  for (const issue of review.issues) { const view = comparison.views.find(v => v.width === issue.width); issue.region = {x:0,y:view.actualHeight-360,width:issue.width,height:360};issue.designRegion={x:0,y:view.designHeight-300,width:issue.width,height:300}; }
  await writeJson(path.join(run,'issues.json'), review);
  await report(run);
} finally { await new Promise(resolve => server.close(resolve)); }
