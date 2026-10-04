import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { capture } from './capture.mjs';
import { compare } from './compare.mjs';
import { report } from './report.mjs';
import { verifyReport } from './verify-report.mjs';
import { assert, cli, readJson, writeJson } from './common.mjs';

export const run = async (command, target) => {
  assert(['capture', 'report'].includes(command) && target, 'Usage: run.mjs capture <config.json> | report <results-directory>');
  const started = performance.now();
  if (command === 'capture') {
    const directory = await capture(target);
    const captured = performance.now();
    await compare(directory);
    await writeJson(path.join(directory, 'timing.json'), { captureMs: captured-started, compareMs: performance.now()-captured, totalMs: performance.now()-started });
    console.log('Next: visually inspect images and fill issues.json; then run.mjs report <results-directory>');
    return directory;
  }
  const data = await readJson(path.join(target, 'comparison.json'));
  await report(target);
  const generated = performance.now();
  await verifyReport(target, data.channel);
  await writeJson(path.join(target, 'report-timing.json'), { reportMs: generated-started, verifyMs: performance.now()-generated, totalMs: performance.now()-started });
  return path.join(target, 'report.html');
};
cli(import.meta.url, run);
