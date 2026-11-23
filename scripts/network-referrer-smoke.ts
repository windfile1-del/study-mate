import { _electron } from 'playwright-core';
import electronPath from 'electron';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { referrerHeaders } from '../apps/desktop/src/core/http-referrer';

const root = process.cwd(),
  data = path.join(root, '.cache', 'referrer-smoke-' + Date.now());
const output = path.join(root, 'artifacts', 'network-referrer');
await fs.mkdir(output, { recursive: true });
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ referer: req.headers.referer || null, range: req.headers.range || null }));
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const target = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
const env = { ...process.env, STUDYMATE_DATA_DIR: data, STUDYMATE_SMOKE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
try {
  app = await _electron.launch({ executablePath: electronPath, args: [root], env });
  const cases = [
    { name: 'same-origin', from: target + '/course?p=2#private-fragment', expected: target + '/course?p=2' },
    {
      name: 'cross-origin',
      from: 'http://127.0.0.1:1/course?private-query=1',
      expected: 'http://127.0.0.1:1/',
    },
    { name: 'https-downgrade', from: 'https://www.bilibili.com/video/BV1CAxaeHEeH/', expected: null },
  ];
  const checks = [];
  for (const item of cases) {
    const headers = referrerHeaders(item.from, target + '/check', { Range: 'bytes=0-3' });
    const actual = await app.evaluate(
      async ({ session }, input) => {
        const response = await session
          .fromPartition('persist:study-mate-browser')
          .fetch(input.url, { headers: input.headers, signal: AbortSignal.timeout(5000) });
        return { status: response.status, body: await response.json() };
      },
      { url: target + '/check', headers },
    );
    assert.equal(actual.status, 200);
    assert.equal(actual.body.referer, item.expected);
    assert.equal(actual.body.range, 'bytes=0-3');
    checks.push({ case: item.name, ...actual });
  }
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify(
      {
        passed: true,
        scope: 'Actual Electron session.fetch to local HTTP server; no Bilibili playback claim',
        checks,
      },
      null,
      2,
    ),
  );
  console.log('PASS: Electron actual same-origin/cross-origin/downgrade referrer and Range headers');
} finally {
  await app?.close();
  server.close();
}
