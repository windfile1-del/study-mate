import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { generateKeyPairSync, sign, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import {
  SubscriptionAuth,
  pkce,
  validateCallback,
  verifyIdentity,
  RESOURCE,
  GOOGLE_CLIENT,
} from '../apps/desktop/src/core/subscription-auth';
import { apiRequest, streamApi, emptyUsage } from '../apps/desktop/src/core/ai-providers';
import { defaultAiConfig } from '../apps/desktop/src/shared/ai';
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'fixture-key', use: 'sig', alg: 'RS256' };
const jwt = (claims: any) => {
  const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid })).toString('base64url'),
    p = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return (
    h + '.' + p + '.' + sign('RSA-SHA256', Buffer.from(h + '.' + p), keys.privateKey).toString('base64url')
  );
};
const protection = () => {
  const key = randomBytes(32);
  return {
    encrypt(value: string) {
      const iv = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', key, iv);
      const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64');
    },
    decrypt(value: string) {
      const bytes = Buffer.from(value, 'base64'),
        dec = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      dec.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([dec.update(bytes.subarray(28)), dec.final()]).toString();
    },
  };
};
async function fixture(kind: 'siwc' | 'antigravity' = 'siwc') {
  const root = path.resolve('.cache', 'auth-fixture-' + Date.now() + '-' + randomBytes(3).toString('hex'));
  await fs.mkdir(root, { recursive: true });
  let nonce = '',
    scope = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
    subject = 'subject-one',
    issued = 'oaiapp_fixture',
    expires = 3600,
    refreshes = 0,
    revokeFail = false,
    identityOnly = false,
    refreshError = '';
  const calls: { url: string; body: string; headers: any }[] = [];
  const transport: typeof fetch = async (input, options = {}) => {
    const url = String(input),
      body = String(options.body || '');
    calls.push({ url, body, headers: options.headers });
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (url.endsWith('openid-configuration'))
      return Response.json({
        issuer: 'https://auth.openai.com',
        jwks_uri: 'https://auth.openai.com/jwks',
        revocation_endpoint: 'https://auth.openai.com/revoke',
      });
    if (url.endsWith('/jwks')) return Response.json({ keys: [jwk] });
    if (url.endsWith('/revoke')) return new Response('', { status: revokeFail ? 503 : 200 });
    if (url.endsWith('/token')) {
      const params = new URLSearchParams(body),
        refresh = params.get('grant_type') === 'refresh_token';
      if (refresh) refreshes++;
      if (refresh && refreshError) return Response.json({ error: refreshError }, { status: 400 });
      return Response.json({
        token_type: 'Bearer',
        ...(!identityOnly
          ? {
              access_token: refresh ? 'refreshed-access-private' : 'access-private',
              refresh_token: refresh ? 'rotated-private' : 'refresh-private',
            }
          : {}),
        expires_in: refresh ? 3600 : expires,
        ...(!refresh
          ? {
              id_token: jwt({
                iss: 'https://auth.openai.com',
                aud: issued,
                sub: subject,
                email: 'same@example.com',
                iat: Math.floor(Date.now() / 1000),
                exp: Math.floor(Date.now() / 1000) + 3600,
                nonce,
              }),
              scope,
            }
          : {}),
      });
    }
    if (url.endsWith('/userinfo')) return Response.json({ id: subject, email: 'same@example.com' });
    if (url.includes('loadCodeAssist')) return Response.json({ cloudaicompanionProject: 'fixture-project' });
    if (url.includes('fetchAvailableModels'))
      return Response.json({
        models: { 'gemini-fixture': { displayName: 'Gemini fixture', maxInputTokens: 32768 } },
      });
    if (url === RESOURCE + '/models')
      return Response.json({
        models: [
          {
            slug: 'model-visible',
            display_name: 'Visible',
            visibility: 'list',
            supported_reasoning_levels: [{ effort: 'high' }],
            context_window: 32768,
          },
          { slug: 'hidden', visibility: 'hide' },
        ],
      });
    throw Error('unexpected network endpoint');
  };
  const cipher = protection(),
    file = path.join(root, 'accounts.json'),
    auth = new SubscriptionAuth(kind, file, cipher, transport);
  async function login(newAccount = false, client = issued) {
    const attempt = await auth.begin(newAccount),
      u = new URL(attempt.url);
    nonce = u.searchParams.get('nonce') || '';
    issued = client;
    const done = new Promise<string>((r) => auth.once('notice', r));
    const redirect = u.searchParams.get('redirect_uri')!;
    const response = await fetch(
      redirect +
        '?' +
        new URLSearchParams({
          state: u.searchParams.get('state')!,
          code: 'fixture-code',
          ...(kind === 'siwc' ? { client_id: client } : {}),
        }),
    );
    assert.equal(response.status, 200);
    const notice = await done;
    return { u, notice };
  }
  return {
    auth,
    file,
    cipher,
    calls,
    login,
    get refreshes() {
      return refreshes;
    },
    setScope(v: string) {
      scope = v;
    },
    setIdentityOnly(v: boolean) {
      identityOnly = v;
    },
    setSubject(v: string) {
      subject = v;
    },
    setExpires(v: number) {
      expires = v;
    },
    setRevokeFail() {
      revokeFail = true;
    },
    setRefreshError(code: string) {
      refreshError = code;
    },
  };
}
test('SIWC authorizes Study Mate with stable host, real PKCE/nonce, issued client and signed identity', async () => {
  const f = await fixture();
  try {
    const start = await f.auth.begin(),
      u = new URL(start.url),
      redirect = u.searchParams.get('redirect_uri')!;
    assert.equal(u.hostname, 'auth.openai.com');
    assert.equal(u.searchParams.get('client_id'), 'dynamic_agent_client');
    assert.equal(u.searchParams.get('agent_name_hint'), 'Study Mate');
    assert.match(u.searchParams.get('ext_agent_host_id')!, /^urn:uuid:/);
    assert.equal(u.searchParams.get('resource'), RESOURCE);
    assert.ok(u.searchParams.get('scope')!.includes('chatgpt.tokens.use.direct'));
    assert.equal((await fetch(redirect + '?state=wrong&code=x&client_id=oaiapp_x')).status, 400);
    assert.equal((await fetch(redirect + '?state=x&state=y&code=x')).status, 400);
    const malformed = await new Promise<number>((resolve, reject) => {
      const request = http.get(
        { hostname: '127.0.0.1', port: new URL(redirect).port, path: '//[' },
        (response) => {
          response.resume();
          resolve(response.statusCode!);
        },
      );
      request.on('error', reject);
    });
    assert.equal(malformed, 400);
    f.auth.cancel();
    const { u: valid } = await f.login();
    assert.equal((await f.auth.view()).account?.authorized, true);
    const tokenCall = f.calls.find((c) => c.body.includes('authorization_code'))!;
    const p = new URLSearchParams(tokenCall.body);
    assert.equal(pkce(p.get('code_verifier')!), valid.searchParams.get('code_challenge'));
    assert.equal(p.get('client_id'), 'oaiapp_fixture');
    assert.ok(!p.has('client_secret'));
    assert.equal(p.get('redirect_uri'), valid.searchParams.get('redirect_uri'));
    const state = await fs.readFile(f.file, 'utf8');
    assert.ok(!state.includes('access-private') && !state.includes('refresh-private'));
    assert.ok(!JSON.stringify(await f.auth.view()).includes('access-private'));
    const models = await f.auth.models();
    assert.deepEqual(
      models.map((m) => m.id),
      ['model-visible'],
    );
    assert.deepEqual(models[0].efforts, ['high']);
    const repeat = await f.auth.begin();
    const again = new URL(repeat.url);
    assert.equal(again.searchParams.get('ext_agent_host_id'), valid.searchParams.get('ext_agent_host_id'));
    assert.equal(again.searchParams.get('client_id'), 'oaiapp_fixture');
    assert.equal(again.searchParams.has('agent_name_hint'), false);
    assert.equal(again.searchParams.has('id_token_hint'), false);
    f.auth.cancel();
  } finally {
    await f.auth.close();
  }
});
test('ID token validation rejects tampering, wrong audience, nonce, issuer, expiry and substituted callback client', () => {
  const now = Math.floor(Date.now() / 1000),
    good = {
      iss: 'https://auth.openai.com',
      aud: 'oaiapp_x',
      sub: 'sub',
      iat: now,
      exp: now + 3600,
      nonce: 'nonce',
    };
  assert.equal(verifyIdentity(jwt(good), { keys: [jwk] }, 'oaiapp_x', 'nonce').sub, 'sub');
  for (const bad of [
    { aud: 'other' },
    { iss: 'https://attacker.test' },
    { exp: now - 1 },
    { nbf: 'tomorrow' },
    { iat: null },
    { nonce: 'wrong' },
    { aud: ['oaiapp_x', 'other'], azp: 'other' },
  ])
    assert.throws(() => verifyIdentity(jwt({ ...good, ...bad }), { keys: [jwk] }, 'oaiapp_x', 'nonce'));
  const parts = jwt(good).split('.');
  parts[1] = Buffer.from(JSON.stringify({ ...good, sub: 'forged' })).toString('base64url');
  assert.throws(() => verifyIdentity(parts.join('.'), { keys: [jwk] }, 'oaiapp_x', 'nonce'), /签名/);
  assert.throws(() =>
    validateCallback(
      '/auth/callback?state=s&code=x&client_id=other',
      'http://127.0.0.1:123/auth/callback',
      's',
      'oaiapp_x',
      'siwc',
    ),
  );
  assert.throws(() =>
    validateCallback('/wrong?state=s&code=x', 'http://127.0.0.1:123/auth/callback', 's', '', 'siwc'),
  );
});
test('Missing plan grant stays disabled; account registrations stay separate and cannot substitute identities', async () => {
  const f = await fixture();
  try {
    f.setScope('openid email');
    f.setIdentityOnly(true);
    const identity = await f.login();
    assert.match(identity.notice, /身份已验证/);
    assert.ok((await f.auth.view()).account);
    assert.equal((await f.auth.view()).account?.authorized, false);
    await assert.rejects(f.auth.credentials(), /明确授权/);
    f.setScope('chatgpt.tokens.use.direct openid email');
    f.setIdentityOnly(false);
    await f.login();
    const first = (await f.auth.view()).account!;
    f.setSubject('subject-two');
    await f.login(true, 'oaiapp_two');
    const all = await f.auth.view();
    assert.equal(all.accounts.length, 2);
    assert.notEqual(first.id, all.account?.id);
    await f.auth.select(first.id);
    const old = await f.auth.view();
    f.setSubject('substituted');
    const result = await f.login(false, 'oaiapp_fixture');
    assert.match(result.notice, /未完成/);
    assert.deepEqual(await f.auth.view(), old);
  } finally {
    await f.auth.close();
  }
});
test('Rotating refresh is serialized and logout clears local tokens even if remote revoke is unconfirmed', async () => {
  const f = await fixture();
  try {
    f.setExpires(1);
    await f.login();
    const [a, b] = await Promise.all([f.auth.credentials(), f.auth.credentials()]);
    assert.equal(f.refreshes, 1);
    assert.equal(a.access_token, b.access_token);
    assert.equal(a.access_token, 'refreshed-access-private');
    f.setRevokeFail();
    assert.equal(await f.auth.logout(), false);
    assert.equal((await f.auth.view()).account?.authorized, false);
    assert.ok(!(await fs.readFile(f.file, 'utf8')).includes('rotated-private'));
    const next = new URL((await f.auth.begin()).url);
    assert.equal(next.searchParams.get('client_id'), 'oaiapp_fixture');
    assert.equal(next.searchParams.get('prompt'), 'consent');
    f.auth.cancel();
  } finally {
    await f.auth.close();
  }
});
test('Terminal refresh rejection clears unusable tokens but keeps the issued application identity', async () => {
  const f = await fixture();
  try {
    f.setExpires(1);
    await f.login();
    f.setRefreshError('invalid_grant');
    await assert.rejects(f.auth.credentials(), /无效令牌已清除/);
    assert.equal((await f.auth.view()).account?.authorized, false);
    assert.equal(new URL((await f.auth.begin()).url).searchParams.get('client_id'), 'oaiapp_fixture');
  } finally {
    await f.auth.close();
  }
});

test('Antigravity follows Harness-Mate OAuth scopes, project discovery, catalog and wrapped streaming', async () => {
  const f = await fixture('antigravity');
  try {
    const { u } = await f.login();
    assert.equal(u.hostname, 'accounts.google.com');
    assert.equal(u.searchParams.get('client_id'), GOOGLE_CLIENT);
    assert.equal(new URL(u.searchParams.get('redirect_uri')!).port, '51121');
    assert.ok(u.searchParams.get('scope')!.includes('/cclog'));
    assert.equal(await f.auth.project(), 'fixture-project');
    assert.equal((await f.auth.models())[0].id, 'gemini-fixture');
    let wire: any = null,
      text = '',
      usage = emptyUsage();
    await streamApi(
      {
        ...defaultAiConfig,
        preset: 'antigravity',
        protocol: 'antigravity',
        baseUrl: 'https://ignored.test',
        model: 'gemini-fixture',
      },
      'access-private',
      [{ role: 'user', content: '学习' }],
      new AbortController().signal,
      (s) => (text += s),
      (u) => (usage = u),
      {
        project: 'fixture-project',
        fetcher: async (url, opts) => {
          assert.equal(
            String(url),
            'https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse',
          );
          wire = JSON.parse(String(opts?.body));
          assert.equal((opts!.headers as any).Authorization, 'Bearer access-private');
          return new Response(
            'data: ' +
              JSON.stringify({
                response: {
                  candidates: [{ content: { parts: [{ text: '回答' }] }, finishReason: 'STOP' }],
                  usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3, totalTokenCount: 15 },
                },
              }) +
              '\n\n',
            { headers: { 'Content-Type': 'text/event-stream' } },
          );
        },
      },
    );
    assert.equal(wire.project, 'fixture-project');
    assert.equal(wire.requestType, 'agent');
    assert.ok(wire.request.sessionId.startsWith('-'));
    assert.equal(text, '回答');
    assert.equal(usage.total, 15);
  } finally {
    await f.auth.close();
  }
});
test('SIWC inference cannot be routed to backend-api or a user-configured endpoint', () => {
  const request = apiRequest(
    { ...defaultAiConfig, baseUrl: 'https://attacker.test/v1', model: 'example' },
    'fixture',
    [{ role: 'user', content: '学习' }],
  );
  assert.equal(request.url, RESOURCE + '/responses');
  assert.equal(request.body.store, false);
  assert.equal(request.body.stream, true);
});

test('SIWC late structured quota failure preserves partial text but never counts as success', async () => {
  let text = '';
  await assert.rejects(
    streamApi(
      { ...defaultAiConfig, model: 'fixture' },
      'private-fixture',
      [{ role: 'user', content: '学习' }],
      new AbortController().signal,
      (s) => {
        text += s;
      },
      () => {},
      {
        fetcher: async () =>
          new Response(
            'data: ' +
              JSON.stringify({ type: 'response.output_text.delta', delta: '部分回答' }) +
              '\n\n' +
              'data: ' +
              JSON.stringify({
                type: 'response.failed',
                response: {
                  error: {
                    code: 'subscription_sharing_usage_limit_exceeded',
                    message: 'PRIVATE_PROVIDER_MESSAGE',
                  },
                },
              }) +
              '\n\n',
            { headers: { 'Content-Type': 'text/event-stream' } },
          ),
      },
    ),
    /订阅使用限制/,
  );
  assert.equal(text, '部分回答');
});
