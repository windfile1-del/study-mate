import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { RemoteHost, type RemoteBackend } from '../apps/desktop/src/core/remote-host';
import { qrPairCode, RemoteAuth } from '../apps/desktop/src/core/remote-auth';
import { localFileResponse } from '../apps/desktop/src/core/remote-media';
import { StudyTools } from '../apps/desktop/src/core/study-tools';
import type { RemoteChatState } from '../apps/desktop/src/shared/remote';
import { workspace } from './helpers';
import {VaultService} from '../apps/desktop/src/core/vault';
import {LearningService} from '../apps/desktop/src/core/learning';
import {SourceRegistry} from '../apps/desktop/src/core/sources';

const encryptionKey = randomBytes(32);
const protection = {
  encrypt: (text: string) => {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', encryptionKey, iv),
      data = Buffer.concat([cipher.update(text), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
  },
  decrypt: (text: string) => {
    const data = Buffer.from(text, 'base64'),
      decipher = createDecipheriv('aes-256-gcm', encryptionKey, data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString();
  },
};
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
test('LAN authentication: one-time pairing, explicit approval, refresh rotation, expiration and encrypted identity', async (t) => {
  const dir = await workspace(t),
    root = path.join(dir, 'remote');
  let now = Date.now();
  const auth = new RemoteAuth(root, protection, () => now);
  await auth.initialize();
  const code = auth.issueCode(['192.168.1.2'], 48123),
    pending = auth.begin(code.secret, '平板');
  const compact = qrPairCode(code);
  assert.equal('certificate' in compact, false);
  assert.equal('hostname' in compact, false);
  assert.equal(compact.pin, code.pin);
  assert.ok(JSON.stringify(compact).length * 3 < JSON.stringify(code).length);
  assert.throws(() => auth.begin(code.secret, '伪造'), /配对码/);
  assert.deepEqual(auth.poll(pending.pairingId, pending.pollToken), { status: 'pending' });
  assert.throws(() => auth.poll(pending.pairingId, 'x'.repeat(43)), /失效/);
  await auth.approve(pending.pairingId, 'vault-one');
  const approved = auth.poll(pending.pairingId, pending.pollToken) as any;
  assert.equal(approved.status, 'approved');
  assert.equal(auth.authenticate('Bearer ' + approved.accessToken).vaultId, 'vault-one');
  const raw = await fs.readFile(path.join(root, 'identity.json'), 'utf8');
  assert.ok(!raw.includes('BEGIN RSA PRIVATE KEY'));
  assert.ok(!(await fs.readFile(path.join(root, 'devices.json'), 'utf8')).includes(approved.refreshToken));
  now += 16 * 60000;
  assert.throws(() => auth.authenticate('Bearer ' + approved.accessToken), /过期/);
  const next = await auth.refresh(approved.refreshToken);
  await assert.rejects(auth.refresh(approved.refreshToken), /失效/);
  const resumed = new RemoteAuth(root, protection, () => now);
  await resumed.initialize();
  assert.equal(resumed.pin, auth.pin);
  const refreshed = await resumed.refresh(next.refreshToken);
  await resumed.revoke(refreshed.deviceId);
  assert.throws(() => resumed.authenticate('Bearer ' + refreshed.accessToken), /过期/);
  await assert.rejects(resumed.refresh(refreshed.refreshToken), /失效/);
  const expired = auth.issueCode([], 1);
  now += 180001;
  assert.throws(() => auth.begin(expired.secret, '迟到'), /过期/);
});
test('Real HTTPS/WSS rejects unauthenticated and browser requests; chat IDs deduplicate and media uses ranges', async (t) => {
  const dir = await workspace(t),
    media = path.join(dir, 'sample.mp4');
  await fs.writeFile(media, Buffer.from('0123456789'));
  let vaultId = 'vault-one',
    sends = 0;
  let resumes = 0;
  const chat: RemoteChatState = {
    conversationId: randomUUID(),
    conversations: [],
    messages: [],
    busy: false,
    model: 'fixture',
    notice: '',
  };
  const backend: RemoteBackend = {
    videos: () => [{ id: 'a'.repeat(24), title: '课程', kind: 'local-video', supported: true, desktop: { position: 8, duration: 100, rate: 1 } }],
    resumePlayback: async (offer, assertActive) => { assertActive(); assert.equal(offer.position, 21); resumes++; },
    vaultId: () => vaultId,
    snapshot: async () => ({ vaultId }),
    notes: async () => [{ path: '安全.md' }],
    note: async (p) => {
      if(p==='private.md')throw Object.assign(new Error('secret-path D:/private/data/key.txt'),{code:'ENOENT'});
      return { path: p, content: '真实内容', version: 'v1' };
    },
    resolve: async () => ({ path: '安全.md', anchor: '' }),
    image: async () => ({ bytes: Buffer.from('image'), mime: 'image/png' }),
    search: async () => [{ path: '安全.md' }],
    chat: async () => structuredClone(chat),
    send: async (input) => {
      sends++;
      if (input.text === 'internal-failure') throw Object.assign(new Error('EPERM D:/private/request-ledger.tmp'), { code: 'EPERM' });
      chat.busy = true;
      chat.messages.push({
        id: randomUUID(),
        role: 'assistant',
        text: input.text,
        status: 'streaming',
        tools: [],
        createdAt: '',
      });
      setTimeout(() => {
        chat.messages.at(-1)!.text += '完成';
        chat.messages.at(-1)!.status = 'complete';
        chat.busy = false;
      }, 500);
    },
    conversation: async () => chat,
    cancel: async () => {
      chat.busy = false;
    },
    media: async (_id, range, head) => localFileResponse(media, range, head),
  };
  const host = new RemoteHost(dir, backend, protection);
  await host.initialize();
  await host.start('127.0.0.1', true);
  t.after(() => host.stop());
  const request = (route: string, body?: unknown, bearer?: string, extra: Record<string, string> = {}) =>
    new Promise<{ status: number; body: any }>((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const req = https.request(
        {
          hostname: '127.0.0.1',
          port: host.state().port,
          servername: host.auth.hostname,
          ca: host.auth.identity.certificate,
          path: route,
          method: data ? 'POST' : 'GET',
          headers: {
            ...(data
              ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(data)) }
              : {}),
            ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}),
            ...extra,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString();
            try {
              resolve({ status: res.statusCode!, body: JSON.parse(text) });
            } catch {
              resolve({ status: res.statusCode!, body: text });
            }
          });
        },
      );
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  assert.equal((await request('/v1/notes')).status, 401);
  assert.equal(
    (await request('/v1/hello', undefined, undefined, { Origin: 'https://evil.example' })).status,
    403,
  );
  const code = host.auth.issueCode(['127.0.0.1'], host.state().port),
    pair = await request('/v1/pair', { secret: code.secret, name: '真实TLS客户端' });
  assert.equal(pair.status, 200);
  const waiting = await request('/v1/pair/status', {
    pairingId: pair.body.pairingId,
    pollToken: pair.body.pollToken,
  });
  assert.equal(waiting.body.status, 'pending');
  await host.control({ action: 'approve', id: pair.body.pairingId });
  const approved = await request('/v1/pair/status', {
      pairingId: pair.body.pairingId,
      pollToken: pair.body.pollToken,
    }),
    credentials = approved.body;
  assert.equal(
    (await request('/v1/notes', undefined, credentials.accessToken)).body.notes[0].path,
    '安全.md',
  );
  const hiddenFailure=await request('/v1/notes/read',{path:'private.md'},credentials.accessToken);
  assert.equal(hiddenFailure.status,500);assert.equal(hiddenFailure.body.error.code,'INTERNAL');
  assert.doesNotMatch(JSON.stringify(hiddenFailure.body),/secret-path|key.txt|ENOENT/);
  const authToken = credentials.accessToken;
  assert.equal((await request('/v1/playback/start', { sourceId: 'f'.repeat(24) }, authToken)).status, 404);
  const videoStart = await request('/v1/playback/start', { sourceId: 'a'.repeat(24) }, authToken);
  assert.equal(videoStart.status, 200);
  const progress = { sourceId: 'a'.repeat(24), sessionId: videoStart.body.sessionId, sequence: 1, position: 21, duration: 100, rate: 1.25 };
  assert.equal((await request('/v1/playback/progress', progress)).status, 401);
  assert.equal((await request('/v1/playback/progress', { ...progress, position: 500 }, authToken)).status, 400);
  assert.equal((await request('/v1/playback/progress', progress, authToken)).status, 200);
  const offer = await request('/v1/playback/handoff', { ...progress, requestId: randomUUID() }, authToken);
  assert.equal(offer.status, 200); assert.equal(resumes, 0);
  const videos = (await request('/v1/videos', undefined, authToken)).body.videos;
  assert.equal(videos[0].checkpoint.position, 21); assert.equal(videos[0].desktop.position, 8);
  assert.equal(host.state().playbackOffers.length, 1);
  await host.control({ action: 'accept-playback', id: offer.body.id });
  assert.equal(resumes, 1); assert.equal(host.state().playbackOffers.length, 0);
  await assert.rejects(host.control({ action: 'accept-playback', id: offer.body.id }), /失效/);
  const events: any[] = [];
  const socket = new WebSocket('wss://127.0.0.1:' + host.state().port + '/v1/events', {
    agent: new https.Agent({ servername: host.auth.hostname, ca: host.auth.identity.certificate }),
    headers: { Authorization: 'Bearer ' + credentials.accessToken },
  });
  t.after(() => socket.terminate());
  socket.on('message', (b) => events.push(JSON.parse(b.toString())));
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  const input = {
    requestId: randomUUID(),
    conversationId: chat.conversationId,
    text: '只调用一次',
    context: { resources: [] },
  };
  const [first, second] = await Promise.all([
    request('/v1/chat/requests', input, credentials.accessToken),
    request('/v1/chat/requests', input, credentials.accessToken),
  ]);
  assert.equal(first.status, 202);
  assert.equal(second.status, 202);
  for (let n = 0; n < 100 && !sends; n++) await delay(10);
  assert.equal(sends, 1);
  assert.equal(
    (await request('/v1/chat/requests', { ...input, requestId: randomUUID() }, credentials.accessToken))
      .status,
    409,
  );
  assert.equal(
    (await request('/v1/chat/requests', { ...input, allowWrite: true }, credentials.accessToken)).status,
    400,
  );
  await delay(900);
  assert.equal(
    (await request('/v1/chat/requests/' + input.requestId, undefined, credentials.accessToken)).body.status,
    'complete',
  );
  assert.ok(events.some((e) => e.type === 'chat.delta' || e.type === 'chat.snapshot'));
  const part = await request('/v1/media/' + 'a'.repeat(24), undefined, credentials.accessToken, {
    Range: 'bytes=3-6',
  });
  assert.equal(part.status, 206);
  assert.equal(String(part.body), '3456');
  assert.equal(
    (await request('/v1/media/' + 'a'.repeat(24), undefined, credentials.accessToken, { Range: 'bytes=99-' }))
      .status,
    416,
  );
  const privateJobId = randomUUID();
  // Asynchronous request failures must hide native storage paths, like route failures.
  assert.equal((await request('/v1/chat/requests', { ...input, requestId: privateJobId, text: 'internal-failure' }, authToken)).status, 202);
  let privateJob: any;
  for (let attempt = 0; attempt < 100; attempt++) {
    privateJob = (await request('/v1/chat/requests/' + privateJobId, undefined, authToken)).body;
    if (privateJob.status === 'failed') break;
    await delay(10);
  }
  assert.equal(privateJob.status, 'failed');
  assert.doesNotMatch(privateJob.message, /EPERM|private|\.tmp/);
  vaultId = 'vault-two';
  assert.equal((await request('/v1/notes', undefined, credentials.accessToken)).status, 403);
  await host.control({ action: 'grant', id: credentials.deviceId });
  assert.equal((await request('/v1/notes', undefined, credentials.accessToken)).status, 200);
  await host.control({ action: 'revoke', id: credentials.deviceId });
  assert.equal((await request('/v1/notes', undefined, credentials.accessToken)).status, 401);
});
test('Server principal denies a daily task even when the supplied tool callback would write', async () => {
  let created = false;
  const tools = new StudyTools({
    remoteReadOnly: true,
    vaultId: 'v',
    requestId: 'r',
    allowWrite: true,
    dirtyPaths: [],
    currentVault: () => ({ id: 'v' }) as any,
    context: async () => null,
    analyze: async () => {
      throw Error('not used');
    },
    createDailyTask: async () => {
      created = true;
    },
  });
  await assert.rejects(
    tools.execute(
      {
        id: 'tool-1',
        name: 'create_daily_task',
        arguments: JSON.stringify({ title: '每日', instruction: '写任务', time: '09:00' }),
      },
      new AbortController().signal,
    ),
    /只读/,
  );
  assert.equal(created, false);
  await assert.rejects(
    tools.execute(
      {
        id: 'tool-2',
        name: 'save_note',
        arguments: JSON.stringify({ path: 'x.md', content: 'overwrite', expected_version: null }),
      },
      new AbortController().signal,
    ),
    /只读/,
  );
});

test('Remote questions retain the tablet time and reject a selected note changed after submission',async t=>{
  const dir=await workspace(t),root=path.join(dir,'vault'),vault=await VaultService.open(root,path.join(dir,'state'));
  t.after(()=>vault.close());const note=await vault.write({path:'A.md',content:'旧的冻结内容',expectedVersion:null,operationId:'remote-version-fixture'});
  const tools=new StudyTools({remoteReadOnly:true,expectedNoteVersions:{'A.md':note.version},vaultId:vault.id,requestId:'request',allowWrite:false,dirtyPaths:[],currentVault:()=>vault,context:async()=>null,analyze:async()=>{throw Error('not used');}});
  await fs.writeFile(path.join(root,'A.md'),'外部编辑后的内容');
  await assert.rejects(tools.execute({id:'read-new-version',name:'read_note',arguments:JSON.stringify({path:'A.md',start_line:1,line_count:20})},new AbortController().signal),/提问后已更新/);
  const sources=new SourceRegistry(path.join(dir,'sources.json'));await sources.initialize();const learning=new LearningService(path.join(dir,'evidence'),sources);t.after(async()=>{await learning.close();await sources.flush();});
  const first=sources.bind('https://example.com/course-one');
  await learning.observe({binding:first,seq:1,url:first.url,title:'第一门课',currentTime:10,duration:1000,paused:true,playbackRate:1,frameStatus:'unavailable',subtitle:'第一门课字幕',frame:null});
  const frozen=await learning.freezeRemote(first.sourceId,842,7,'tablet-one');
  const second=sources.bind('https://example.com/course-two');
  await learning.observe({binding:second,seq:1,url:second.url,title:'第二门课',currentTime:30,duration:1000,paused:true,playbackRate:1,frameStatus:'unavailable',subtitle:'第二门课字幕',frame:null});
  const context=await learning.context(frozen);assert.equal(context.anchor.mediaTime,842);assert.equal(context.anchor.sourceId,first.sourceId);assert.equal(context.anchor.generation,7);assert.equal(context.anchor.visitId,'remote:tablet-one');assert.ok(context.subtitles.every(s=>!s.text.includes('第二门课')));
});

test('Remote request ledger survives restart and a reused ID cannot change the question',async t=>{
  const dir=await workspace(t);let sends=0;
  const chat:RemoteChatState={conversationId:randomUUID(),conversations:[],messages:[],busy:false,model:'fixture',notice:''};
  const backend:RemoteBackend={vaultId:()=> 'v',snapshot:async()=>({}),notes:async()=>[],note:async()=>({}),resolve:async()=>({path:'A.md',anchor:''}),image:async()=>({bytes:Buffer.alloc(0),mime:'image/png'}),search:async()=>[],chat:async()=>chat,conversation:async()=>chat,cancel:async()=>{},send:async()=>{sends++;}};
  const host=new RemoteHost(dir,backend,protection);await host.initialize();
  const code=host.auth.issueCode([],1),pending=host.auth.begin(code.secret,'tablet');await host.auth.approve(pending.pairingId,'v');const credentials=host.auth.poll(pending.pairingId,pending.pollToken) as any;
  const device=host.auth.authenticate('Bearer '+credentials.accessToken),input={requestId:randomUUID(),conversationId:chat.conversationId,text:'原始问题',context:{resources:[]}};
  await host.submit(input,device);for(let n=0;n<100&&sends===0;n++)await delay(10);assert.equal(sends,1);await delay(30);await host.stop();
  const resumed=new RemoteHost(dir,backend,protection);await resumed.initialize();t.after(()=>resumed.stop());const refreshed=await resumed.auth.refresh(credentials.refreshToken),same=resumed.auth.authenticate('Bearer '+refreshed.accessToken);
  await resumed.submit(input,same);assert.equal(sends,1);await assert.rejects(resumed.submit({...input,text:'变更后的问题'},same),/另一条问题/);assert.equal(sends,1);
});
