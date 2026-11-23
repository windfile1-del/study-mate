import { _electron } from 'playwright-core';
import electronPath from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { randomUUID, X509Certificate } from 'node:crypto';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import QRCode from 'qrcode';
import { spawn } from 'node:child_process';

const android = process.argv.includes('--android');
const stage3 = process.argv.includes('--video');
const stage4 = process.argv.includes('--stable');
const androidSerial = process.env.STUDYMATE_ANDROID_SERIAL || 'emulator-5554';
const reuse = process.env.STUDYMATE_REMOTE_SMOKE_REUSE;
assert.ok(!reuse || /^remote-smoke-\d+$/.test(reuse), '只能复用本测试在 .cache 创建的隔离目录名');
const root = process.cwd(),
  data = path.join(root, '.cache', reuse || 'remote-smoke-' + Date.now()),
  output = path.join(
    root,
    'artifacts',
    android
      ? 'remote-android-' +
          androidSerial.replaceAll(':', '_') +
          (stage4 ? '-stage4' : '') +
          (stage3 ? '-stage3' : '') +
          (process.env.STUDYMATE_BILIBILI_URL ? '-course' : '')
      : 'remote',
  );
await fs.mkdir(data, { recursive: true });
assert.equal(
  path.dirname(await fs.realpath(data)),
  await fs.realpath(path.join(root, '.cache')),
  '隔离 profile 不能通过链接指向工程缓存目录之外',
);
const marker = path.join(data, 'remote-smoke-profile.json');
if (reuse) assert.equal(JSON.parse(await fs.readFile(marker, 'utf8')).kind, 'study-mate-isolated-smoke');
else await fs.writeFile(marker, JSON.stringify({ kind: 'study-mate-isolated-smoke', version: 1 }));
await fs.mkdir(output, { recursive: true });
try {
  await fs.access(path.join(output, 'result.json'));
  const history = path.join(output, 'attempts', String(Date.now()));
  await fs.mkdir(history, { recursive: true });
  for (const entry of await fs.readdir(output, { withFileTypes: true }))
    if (entry.isFile()) await fs.copyFile(path.join(output, entry.name), path.join(history, entry.name));
} catch {}
for (const entry of await fs.readdir(output, { withFileTypes: true }))
  if (entry.isFile()) await fs.unlink(path.join(output, entry.name));
const calls = [];
const provider = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw),
    results = body.messages
      .slice(body.messages.findLastIndex((m) => m.role === 'user') + 1)
      .filter((m) => m.role === 'tool');
  calls.push(body);
  const tools = [
    ['read_note', { path: '测试笔记.md', start_line: 1, line_count: 50 }],
    ['create_daily_task', { title: '越权任务', instruction: '不应创建', time: '09:00' }],
    ['save_note', { path: '测试笔记.md', content: '不应覆盖', expected_version: null }],
  ];
  let delta, finish_reason;
  if (results.length < tools.length) {
    const [name, args] = tools[results.length];
    delta = {
      tool_calls: [
        {
          index: 0,
          id: 'call-' + results.length,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    };
    finish_reason = 'tool_calls';
  } else {
    delta = { content: '已读取测试笔记：传递函数 G(s)=1/(s+1)。平板只读，任务与笔记写入均已拒绝。' };
    finish_reason = 'stop';
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end(
    'data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] }) + '\n\ndata: [DONE]\n\n',
  );
});
await new Promise((r) => provider.listen(0, '127.0.0.1', r));
let app, socket;
const checks = [];
let host;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn) {
  for (let n = 0; n < 200; n++) {
    const result = await fn();
    if (result) return result;
    await delay(100);
  }
  throw Error('等待状态超时');
}
async function hiddenBrowser() {
  await until(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((w) => w.contentView.children.every((v) => !v.getVisible()))));
}
async function desktopScreenshot(file) {
  await hiddenBrowser();
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('index.html'));
    if (!window) throw Error('缺少桌面工作台窗口');
    const image = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    if (image.isEmpty()) throw Error('桌面截图为空');
    return image.toPNG().toString('base64');
  });
  await fs.writeFile(file, Buffer.from(png, 'base64'));
}
try {
  const env = { ...process.env, STUDYMATE_DATA_DIR: data, STUDYMATE_SMOKE: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  app = await _electron.launch({
    executablePath: electronPath,
    args: [root],
    env,
    cwd: root,
    timeout: 30000,
  });
  const page = await app.firstWindow();
  if (stage3) await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('index.html'));
    if (!window) throw Error('没有找到隔离验收窗口');
    window.setTitle('Study Mate · 阶段3平板验收（隔离测试）'); window.show();
  });
  await page.getByRole('button', { name: '平板连接', exact: true }).waitFor();
  const original =
    '# 测试笔记\n\n传递函数：$G(s)=\\frac{1}{s+1}$。\n\n[[相关笔记]]\n\n![[images/实验 图.png|64]]\n\n```mermaid\nflowchart LR\nA-->B\n```\n';
  await page.evaluate(
    async ({ base, original }) => {
      const s = await window.studyMate.ai({ action: 'state' });
      await window.studyMate.ai({
        action: 'configure',
        config: {
          ...s.config,
          preset: 'custom',
          protocol: 'chat',
          baseUrl: base,
          model: 'fixture',
          contextSize: 32768,
          maxOutput: 2048,
        },
      });
      await window.studyMate.ai({ action: 'conversation', operation: 'create' });
      for (const [path, content] of [
        ['测试笔记.md', original],
        ['相关笔记.md', '# 相关笔记\n\n双链真实目标。'],
      ]) {
        const previous = await window.studyMate.readNote(path).catch(() => null);
        if (previous?.content !== content)
          await window.studyMate.saveNote({
            path,
            content,
            expectedVersion: previous?.version || null,
            operationId: 'remote-fixture-' + crypto.randomUUID(),
          });
      }
    },
    { base: 'http://127.0.0.1:' + provider.address().port, original },
  );
  await page.getByRole('button', { name: '平板连接', exact: true }).click();
  const fixtureVault = (await page.evaluate(() => window.studyMate.state())).vaultPath;
  assert.ok(
    path
      .resolve(fixtureVault)
      .toLowerCase()
      .startsWith(path.resolve(data).toLowerCase() + path.sep),
  );
  await fs.mkdir(path.join(fixtureVault, 'images'), { recursive: true });
  await fs.writeFile(
    path.join(fixtureVault, 'images', '实验 图.png'),
    await QRCode.toBuffer('Study Mate image proof', { width: 96 }),
  );
  await page.getByRole('dialog', { name: '平板连接' }).waitFor();
  const state = await page.evaluate(() => window.studyMate.remote({ action: 'state' }));
  const address =
    state.interfaces.find((i) => i.address.startsWith('192.168.1.'))?.address || state.interfaces[0]?.address;
  assert.ok(address, '没有可用局域网网卡');
  await page.evaluate((address) => window.studyMate.remote({ action: 'enable', address }), address);
  host = await page.evaluate(() => window.studyMate.remote({ action: 'pair-code' }));
  assert.ok(host.qr?.startsWith('data:image/png;'));
  checks.push('桌面服务开关与配对二维码');
  const code = host.pairCode,
    cert = new X509Certificate(Buffer.from(code.certificate, 'base64')).toString();
  function request(route, body, bearer, headers = {}) {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const req = https.request(
        {
          hostname: address,
          port: host.port,
          servername: host.hostname,
          ca: cert,
          path: route,
          method: data ? 'POST' : 'GET',
          headers: {
            ...(data
              ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
              : {}),
            ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}),
            ...headers,
          },
        },
        (res) => {
          let text = '';
          res.on('data', (c) => (text += c));
          res.on('end', () => {
            try {
              resolve({ status: res.statusCode, body: JSON.parse(text) });
            } catch {
              resolve({ status: res.statusCode, body: text });
            }
          });
        },
      );
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }
  assert.equal((await request('/v1/notes')).status, 401);
  assert.equal((await request('/v1/notes/offline')).status, 401);
  const acceptanceName = 'Android 验收客户端 ' + randomUUID().slice(0, 8);
  const pair = await request('/v1/pair', { secret: code.secret, name: acceptanceName });
  assert.equal(pair.status, 200);
  await until(() => page.getByText(acceptanceName, { exact: true }).isVisible());
  await page.getByRole('button', { name: '允许配对' }).click();
  const approved = await until(async () => {
    const result = await request('/v1/pair/status', {
      pairingId: pair.body.pairingId,
      pollToken: pair.body.pollToken,
    });
    return result.body.status === 'approved' ? result : null;
  });
  const token = approved.body.accessToken;
  checks.push('真实 Electron 批准设备与 TLS 认证');
  const note = (await request('/v1/notes/read', { path: '测试笔记.md' }, token)).body;
  const emptyCopy = await request('/v1/notes/offline', undefined, token);
  assert.deepEqual(emptyCopy.body.notes, []);
  await page.getByText(/同步笔记到平板（已选/).click();
  const selection = page.getByRole('checkbox', { name: '测试笔记.md', exact: true });
  await selection.click();
  const readCopy = async (count) => {
    for (let i = 0; i < 40; i++) {
      const response = await request('/v1/notes/offline', undefined, token);
      if (response.status === 200 && response.body.notes?.length === count) return response.body;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw Error('没有收到预期的离线笔记副本');
  };
  const copy = await readCopy(1);
  assert.equal(copy.notes[0].path, note.path);
  assert.equal(copy.notes[0].content, note.content);
  assert.ok(Object.values(copy.notes[0].links).every((link) => link.path !== '相关笔记.md'));
  assert.ok(Object.keys(copy.images).length > 0, '离线副本包含笔记直接引用的图片');
  const unchanged = await request(`/v1/notes/offline?source=${copy.source}&revision=${copy.revision}`, undefined, token);
  assert.deepEqual(unchanged.body, { unchanged: true });
  await page.waitForFunction(() => Array.from(document.querySelectorAll('input[type="checkbox"]')).some((box) => box.checked && !box.disabled && box.labels?.[0]?.innerText.trim() === '测试笔记.md'));
  await selection.click();
  assert.ok((await readCopy(0)).revision > copy.revision);
  assert.equal(note.content, original);
  const link = (
    await request('/v1/notes/resolve', { base: '测试笔记.md', target: '相关笔记', wiki: true }, token)
  ).body;
  assert.equal(link.path, '相关笔记.md');
  checks.push('真实知识库笔记与双链读取');
  assert.notEqual((await request('/v1/notes/read', { path: '../../package.json' }, token)).status, 200);
  assert.equal(
    (await request('/v1/notes/read', { path: '测试笔记.md', allowWrite: true }, token)).status,
    400,
  );
  checks.push('路径边界与伪造字段拒绝');
  const initial = (await request('/v1/conversations', undefined, token)).body,
    events = [];
  socket = new WebSocket('wss://' + address + ':' + host.port + '/v1/events', {
    agent: new https.Agent({ servername: host.hostname, ca: cert }),
    headers: { Authorization: 'Bearer ' + token },
  });
  socket.on('message', (b) => events.push(JSON.parse(b.toString())));
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const input = {
    requestId: randomUUID(),
    conversationId: initial.conversationId,
    text: '解释这篇笔记，然后尝试创建每日任务和覆盖它',
    context: {
      resources: [
        {
          kind: 'note',
          vaultId: (await request('/v1/session', undefined, token)).body.vaultId,
          path: note.path,
          version: note.version,
        },
      ],
    },
  };
  assert.equal((await request('/v1/chat/requests', input, token)).status, 202);
  assert.equal((await request('/v1/chat/requests', input, token)).status, 202);
  await until(async () => {
    const result = (await request('/v1/chat/requests/' + input.requestId, undefined, token)).body;
    if (result.status === 'failed') throw Error(result.message);
    return result.status === 'complete';
  });
  const final = (await request('/v1/conversations', undefined, token)).body;
  assert.match(final.messages.at(-1).text, /传递函数/);
  assert.equal(final.messages.filter((m) => m.role === 'user').length, 1);
  assert.ok(events.some((e) => e.type.startsWith('chat.')));
  assert.equal(calls.length, 4);
  assert.ok(calls.some((r) => r.messages.some((m) => m.role === 'tool' && m.content.includes('传递函数'))));
  assert.ok(calls.at(-1).messages.filter((m) => m.role === 'tool' && m.content.includes('只读')).length >= 2);
  assert.equal(
    (await page.evaluate(() => window.studyMate.schedules({ action: 'list' }))).schedules.length,
    0,
  );
  assert.equal((await page.evaluate(() => window.studyMate.readNote('测试笔记.md'))).content, original);
  checks.push('受控 Provider 真实读笔记、拒绝任务/保存、消息流与请求去重');
  const bad = {
    ...input,
    requestId: randomUUID(),
    context: { resources: [{ ...input.context.resources[0], version: 'stale' }] },
  };
  await request('/v1/chat/requests', bad, token);
  const stale = await until(async () => {
    const result = (await request('/v1/chat/requests/' + bad.requestId, undefined, token)).body;
    return result.status === 'failed' ? result : null;
  });
  assert.match(stale.message, /更新/);
  assert.equal(calls.length, 4);
  checks.push('笔记版本过期时不调用模型');
  if (android) {
    const adb = path.join(root, '.cache/android-sdk/platform-tools/adb.exe');
    async function adbRun(args) {
      return new Promise((resolve, reject) => {
        const child = spawn(adb, ['-s', androidSerial, ...args], {
          cwd: root,
          env: process.env,
          windowsHide: true,
        });
        let stdout = '',
          stderr = '';
        child.stdout.on('data', (b) => (stdout += b));
        child.stderr.on('data', (b) => (stderr += b));
        child.on('error', reject);
        child.on('close', (code) =>
          code === 0 ? resolve(stdout) : reject(Error('Android 检查失败：' + stdout + '\n' + stderr)),
        );
      });
    }
    await adbRun([
      'install',
      '-r',
      path.join(root, 'apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk'),
    ]);
    await adbRun([
      'install',
      '-r',
      path.join(
        root,
        'apps/mobile/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk',
      ),
    ]);
    const sdk = Number((await adbRun(['shell', 'getprop', 'ro.build.version.sdk'])).trim());
    const deviceModel = (await adbRun(['shell', 'getprop', 'ro.product.model'])).trim();
    if (sdk >= 37 && androidSerial.startsWith('emulator-')) {
      for (let attempt = 0; attempt < 2; attempt++) {
        await adbRun([
          'shell',
          'pm',
          'revoke',
          'dev.studymate.mobile',
          'android.permission.ACCESS_LOCAL_NETWORK',
        ]);
        const denied = await adbRun([
          'shell',
          'am',
          'instrument',
          '-w',
          '-r',
          '-e',
          'class',
          'dev.studymate.mobile.LocalNetworkPermissionTest',
          '-e',
          'address',
          address,
          '-e',
          'port',
          String(host.port),
          'dev.studymate.mobile.test/androidx.test.runner.AndroidJUnitRunner',
        ]);
        await fs.writeFile(path.join(output, 'permission-denied-' + attempt + '.txt'), denied);
        assert.match(denied, /OK \(1 test\)/);
        assert.doesNotMatch(denied, /FAILURES|INSTRUMENTATION_FAILED/);
        await adbRun([
          'shell',
          'pm',
          'grant',
          'dev.studymate.mobile',
          'android.permission.ACCESS_LOCAL_NETWORK',
        ]);
      }
      checks.push('Android 17 局域网权限拒绝、撤销及重新授权');
    }
    let mediaId = '';
    const candidates = (await fs.readdir(path.join(root, '.cache'), { withFileTypes: true })).filter(
      (e) => e.isDirectory() && e.name.startsWith('media-smoke-'),
    );
    for (const candidate of candidates) {
      const file = path.join(root, '.cache', candidate.name, '中文 视频 960x540.mp4');
      try {
        await fs.access(file);
        const fixture = path.join(data, 'native-sample.mp4');
        await fs.copyFile(file, fixture);
        await app.evaluate(({ dialog }, file) => {
          dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
        }, fixture);
        await page.evaluate(() => window.studyMate.openLocal());
        mediaId = (await page.evaluate(() => window.studyMate.state())).activeBinding.sourceId;
        break;
      } catch {}
    }
    assert.ok(mediaId, '缺少原生播放器验收样片，请先运行 smoke:media 创建带索引的 MP4。');
    if (stage3) {
      await page.getByRole('button', { name: '关闭平板连接', exact: true }).click();
      await page.locator('.nav-item').filter({ hasText: '课程浏览器' }).click();
      await until(async () => (await page.evaluate(() => window.studyMate.player({ action: 'state' }))).duration > 0);
      await page.evaluate(() => window.studyMate.player({ action: 'pause' }));
      await page.evaluate(() => window.studyMate.player({ action: 'seek', time: 0 }));
      await page.getByRole('button', { name: '平板连接', exact: true }).click();
    }
    let courseId = '';
    if (process.env.STUDYMATE_BILIBILI_URL) {
      if (process.env.STUDYMATE_INTERACTIVE_COURSE === '1') {
        await page.getByRole('button', { name: '关闭平板连接', exact: true }).click();
        await page.locator('.nav-item').filter({ hasText: '课程浏览器' }).click();
        await app.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows().find((w) =>
            w.webContents.getURL().includes('index.html'),
          );
          if (!window) throw Error('没有找到学习工作台窗口');
          window.setTitle('Study Mate · 平板课程验收（隔离测试）');
          window.show();
          window.focus();
        });
      }
      await page.evaluate((url) => window.studyMate.openWeb(url), process.env.STUDYMATE_BILIBILI_URL);
      courseId = (await page.evaluate(() => window.studyMate.state())).activeBinding.sourceId;
      if (process.env.STUDYMATE_INTERACTIVE_COURSE === '1') {
        const readyFile = path.join(data, 'course-ready');
        await fs.writeFile(
          path.join(output, 'interactive-course.json'),
          JSON.stringify({ profile: data, readyFile, source: process.env.STUDYMATE_BILIBILI_URL }, null, 2),
        );
        console.log('WAIT_FOR_COURSE: ' + readyFile);
        let ready = false;
        const expires = Date.now() + 15 * 60000;
        while (Date.now() < expires) {
          if (
            await fs.access(readyFile).then(
              () => true,
              () => false,
            )
          ) {
            ready = true;
            break;
          }
          await delay(500);
        }
        assert.ok(ready, '未收到隔离课程窗口正常播放的确认；未继续请求平台。');
      }
      const prepared = await request('/v1/media/' + courseId + '/prepare', {}, token);
      await fs.writeFile(
        path.join(output, 'course-prepare.json'),
        JSON.stringify({ status: prepared.status, body: prepared.body }, null, 2),
      );
      assert.equal(
        prepared.status,
        200,
        '电脑课程准备失败，请查看隔离 profile 的 logs/app.ndjson：' + JSON.stringify(prepared.body),
      );
    }
    const code = (await page.evaluate(() => window.studyMate.remote({ action: 'pair-code' }))).pairCode;
    await adbRun([
      'shell',
      'rm',
      '-f',
      ...[
        'learning-stage2.png',
        'learning-stage2-landscape.png',
        'video-stage0.png',
        'reader-geometry.txt',
        'reader-failure.png',
        'course-stage0.png',
        'course-stage0.json',
        'player-failure.png', 'player-failure.txt',
        'drop-request',
        ...['local', 'bilibili'].flatMap((prefix) => ['landscape.png', 'portrait.png', 'fullscreen.png', 'json'].map((suffix) => prefix + '-player' + (suffix === 'json' ? '.json' : '-' + suffix))),
      ].map((file) => '/sdcard/Android/data/dev.studymate.mobile/files/' + file),
    ]);
    const nativeTask = adbRun([
      'shell',
      'am',
      'instrument',
      '-w',
      '-r',
      '-e',
      'class',
      'dev.studymate.mobile.LanLearningTest',
      '-e',
      'pairCode',
      Buffer.from(JSON.stringify(code)).toString('base64'),
      '-e',
      'mediaId',
      mediaId,
      ...(stage4 ? ['-e', 'stage4', 'true'] : []),
      ...(stage3 ? ['-e', 'stage3', 'true'] : []),
      ...(courseId ? ['-e', 'courseId', courseId] : []),
      'dev.studymate.mobile.test/androidx.test.runner.AndroidJUnitRunner',
    ]);
    let settled = false,
      nativeOutput = '';
    const nativeDone = nativeTask.then(
      (value) => {
        settled = true;
        nativeOutput = value;
      },
      (error) => {
        settled = true;
        throw error;
      },
    );
    const handledOffers = new Set();
    let dropped = false;
    let nativeDeviceId = '';
    const deadline = Date.now() + (stage3 ? 360000 : courseId ? 240000 : 120000);
    while (!settled && Date.now() < deadline) {
      if (stage4 && !dropped && (await adbRun(['shell', 'ls', '/sdcard/Android/data/dev.studymate.mobile/files/drop-request']).catch(() => '')).includes('drop-request')) {
        dropped = true;
        await page.evaluate(() => window.studyMate.remote({ action: 'disable' }));
        await delay(5000);
        host = await page.evaluate(address => window.studyMate.remote({ action: 'enable', address }), address);
        checks.push('真实服务中断 5 秒、离线缓存阅读、mDNS 新端口重连');
      }
      const state = await page.evaluate(() => window.studyMate.remote({ action: 'state' }));
      for (const p of state.pending.filter((p) => p.name === deviceModel)) {
        const next = await page.evaluate((id) => window.studyMate.remote({ action: 'approve', id }), p.id);
        nativeDeviceId = next.devices.find((d) => !state.devices.some((old) => old.id === d.id))?.id || nativeDeviceId;
      }
      if (stage3) for (const offer of state.playbackOffers.filter((o) => o.deviceId === nativeDeviceId && !handledOffers.has(o.id))) {
        handledOffers.add(offer.id);
        if (!(await page.getByRole('dialog', { name: '平板连接' }).count())) await page.getByRole('button', { name: '平板连接', exact: true }).click();
        const tile = page.locator(`[data-playback-offer="${offer.id}"]`);
        await tile.getByRole('button', { name: '在电脑继续播放', exact: true }).waitFor();
        await hiddenBrowser();
        await desktopScreenshot(path.join(output, 'desktop-handoff-' + offer.sourceId + '.png'));
        await tile.getByRole('button', { name: '在电脑继续播放', exact: true }).click();
        try {
          await until(async () => {
            const alert = page.getByRole('dialog', { name: '平板连接' }).getByRole('alert');
            const error = await alert.count() ? await alert.textContent() : '';
            if (error) throw Error('电脑接力失败：' + error);
            return !(await page.evaluate(() => window.studyMate.remote({ action: 'state' }))).playbackOffers.some((o) => o.id === offer.id);
          });
        } catch (error) {
          if (!(await page.getByRole('dialog', { name: '平板连接' }).count())) await page.getByRole('button', { name: '平板连接', exact: true }).click();
          await hiddenBrowser();
          await desktopScreenshot(path.join(output, 'desktop-handoff-failure.png'));
          const actual = await page.evaluate(() => window.studyMate.player({ action: 'state' }));
          await fs.writeFile(path.join(output, 'desktop-handoff-failure.json'), JSON.stringify({ error: error.message, actual, offer }, null, 2));
          throw error;
        }
        const actual = await page.evaluate(() => window.studyMate.player({ action: 'state' }));
        assert.ok(actual.time >= offer.position - 0.7 && actual.time <= offer.position + 3, JSON.stringify({ actual, offer }));
        assert.equal(actual.rate, offer.rate);
        checks.push('真实电脑确认平板接力 ' + offer.title + ' @ ' + offer.position);
      }
      await delay(300);
    }
    if (!settled) throw Error('Android instrumentation 尚未结束，请检查设备日志。');
    if (stage4) assert.ok(dropped, '未执行真实断线测试，不能视为稳定性通过');
    await nativeDone;
    await fs.writeFile(path.join(output, 'instrumentation.txt'), nativeOutput);
    for (const [deviceFile, localFile] of [
      ['learning-stage2.png', 'android-learning.png'],
      ['learning-stage2-landscape.png', 'android-learning-landscape.png'],
      ['video-stage0.png', 'android-video-first-frame.png'],
      ['reader-geometry.txt', 'reader-geometry.txt'],
      ['reader-failure.png', 'reader-failure.png'],
      ['course-stage0.png', 'android-bilibili.png'],
      ['course-stage0.json', 'android-bilibili.json'],
      ['player-failure.png', 'player-failure.png'], ['player-failure.txt', 'player-failure.txt'],
      ...['local', 'bilibili'].flatMap((prefix) => ['landscape.png', 'portrait.png', 'fullscreen.png', 'json'].map((suffix) => {
        const file = prefix + '-player' + (suffix === 'json' ? '.json' : '-' + suffix); return [file, file];
      })),
    ]) {
      if (
        !(await adbRun([
          'shell',
          'ls',
          '/sdcard/Android/data/dev.studymate.mobile/files/' + deviceFile,
        ]).catch(() => ''))
      )
        continue;
      const screenshot = await new Promise((resolve, reject) => {
        const child = spawn(
            adb,
            [
              '-s',
              androidSerial,
              'exec-out',
              'cat',
              '/sdcard/Android/data/dev.studymate.mobile/files/' + deviceFile,
            ],
            { windowsHide: true },
          ),
          chunks = [];
        child.stdout.on('data', (b) => chunks.push(b));
        child.on('error', reject);
        child.on('close', (code) =>
          code === 0 ? resolve(Buffer.concat(chunks)) : reject(Error('设备截图读取失败')),
        );
      });
      await fs.writeFile(path.join(output, localFile), screenshot);
    }
    if (!/OK \(1 test\)/.test(nativeOutput) || /FAILURES|INSTRUMENTATION_FAILED/.test(nativeOutput))
      throw Error(
        'Android 设备验收失败：' +
          (nativeOutput.match(/stack=([^\r\n]+)/)?.[1] || nativeOutput.slice(-300)) +
          '；完整记录：' +
          path.join(output, 'instrumentation.txt'),
      );
    assert.equal((await page.evaluate(() => window.studyMate.readNote('测试笔记.md'))).content, original);
    assert.equal(
      (await page.evaluate(() => window.studyMate.schedules({ action: 'list' }))).schedules.length,
      0,
    );
    if (stage3) for (const prefix of ['local', ...(courseId ? ['bilibili'] : [])]) {
      const proof = JSON.parse(await fs.readFile(path.join(output, prefix + '-player.json'), 'utf8'));
      const call = calls.find((call) => call.messages.some((message) => message.role === 'user' && JSON.stringify(message.content).includes('阶段3视频时间点问题 ' + prefix)));
      assert.ok(call, '缺少视频时间点问题的真实模型协议请求');
      const payload = JSON.stringify(call.messages);
      assert.ok(payload.includes('\\"time\\":' + proof.frozenQuestionPosition), '冻结位置未进入模型请求');
      assert.ok(payload.includes('\\"duration\\":' + proof.duration), '平板时长未进入模型请求');
      checks.push('正式播放器界面、横竖屏/全屏、进度条、倍速、冻结提问、进度恢复及后台释放：' + prefix);
    }
    checks.push('Android 实际 TLS 固定、电脑批准、知识库读取、重复问答、原生 WebView 中文公式及 Media3 解码');
    if (courseId)
      checks.push(
        '真实免登录 B站课程经电脑 HTTPS 代理，平板独立 H.264/AAC 轨道合并、视频帧和音频缓冲持续输出',
      );
  }
  if (!(await page.getByRole('dialog', { name: '平板连接' }).count())) {
    await page.getByRole('button', { name: '平板连接', exact: true }).click();
    await page.getByRole('dialog', { name: '平板连接' }).waitFor();
  }
  await hiddenBrowser();
  await desktopScreenshot(path.join(output, 'desktop-pairing.png'));
  await page.evaluate((id) => window.studyMate.remote({ action: 'revoke', id }), approved.body.deviceId);
  assert.equal((await request('/v1/notes', undefined, token)).status, 401);
  checks.push('桌面撤销立即拒绝旧凭据');
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify(
      {
        passed: true,
        checks,
        providerRequests: calls.length,
        scope:
          'Electron production build + real HTTPS/WSS + isolated vault + controlled provider; Android and real Bilibili validated separately',
      },
      null,
      2,
    ),
  );
  console.log('PASS: ' + checks.join('；'));
} catch (error) {
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify({ passed: false, checks, error: error.stack }, null, 2),
  );
  throw error;
} finally {
  socket?.terminate();
  if (app) await app.close().catch(() => {});
  provider.close();
}
