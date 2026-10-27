import http from 'node:http';
import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID, createHash, createPublicKey, verify, timingSafeEqual } from 'node:crypto';
import { atomicJson, readJson, SerialQueue } from './storage';
import type { AiModel } from '../shared/ai';
export type SubscriptionKind = 'siwc' | 'antigravity';
export const RESOURCE = 'https://api.openai.com/v1';
export const GOOGLE_CLIENT = [
  '1071006060591-',
  'tmhssin2h21lc',
  're235vtolojh4g403ep.',
  'apps.googleusercontent.com',
].join('');
const GOOGLE_PUBLIC_SECRET = ['GOCSPX-', 'K58FWR486Ld', 'LJ1mLB8sXC4z6qDAf'].join('');
export const ANTIGRAVITY_UA =
  'antigravity/ide/2.5.5 (os_type=windows; arch=amd64; aidev_client; auth_method=oauth)';
type Tokens = {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_at: number;
  scope: string;
  earliest_refresh_at?: number;
  recordId?: string;
  project?: string;
};
type Registration = {
  id: string;
  clientId: string;
  subject: string;
  label: string;
  secret?: string;
  authorized: boolean;
  project?: string;
};
type Saved = { hostId: string; active: string | null; registrations: Registration[] };
export interface CredentialProtection {
  encrypt: (value: string) => string;
  decrypt: (value: string) => string;
}
const random = () => randomBytes(32).toString('base64url');
function tokenExpiry(value: unknown) {
  const seconds = value === undefined ? 3600 : Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) throw Error('授权返回的有效期无效');
  return Date.now() + seconds * 1000;
}
export function pkce(verifier: string) {
  return createHash('sha256').update(verifier).digest('base64url');
}
const scopes = (j: any, previous = '') =>
  typeof j.scope === 'string' ? j.scope : Array.isArray(j.scopes) ? j.scopes.join(' ') : previous;
const equal = (a: string, b: string) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
export function validateCallback(
  target: string,
  redirect: string,
  state: string,
  oldClient: string,
  kind: SubscriptionKind,
) {
  if (!target.startsWith('/') || target.startsWith('//') || target.length > 16384)
    throw Error('无效的登录回调');
  const u = new URL(target, new URL(redirect).origin),
    expected = new URL(redirect);
  if (u.origin !== expected.origin || u.pathname !== expected.pathname || u.hash)
    throw Error('登录回调地址不匹配');
  const names = [...u.searchParams.keys()];
  if (new Set(names).size !== names.length) throw Error('登录回调参数重复');
  if (!equal(u.searchParams.get('state') || '', state)) throw Error('登录状态不匹配');
  if (u.searchParams.has('error')) throw Error('用户取消授权或服务未授予权限');
  const code = u.searchParams.get('code');
  if (!code) throw Error('授权码缺失');
  const returned = u.searchParams.get('client_id');
  if (oldClient && returned && returned !== oldClient) throw Error('应用注册身份发生变化');
  const clientId = kind === 'antigravity' ? GOOGLE_CLIENT : oldClient || returned || '';
  if (!clientId || clientId === 'dynamic_agent_client') throw Error('未收到独立应用注册 ID');
  return { code, clientId };
}
export function verifyIdentity(
  jwt: string,
  jwks: any,
  clientId: string,
  nonce?: string,
  now = Date.now() / 1000,
) {
  const parts = jwt.split('.');
  if (parts.length !== 3) throw Error('身份令牌格式无效');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
  if (header.alg !== 'RS256' || !header.kid) throw Error('身份令牌签名算法不支持');
  const key = jwks.keys?.find(
    (k: any) =>
      k.kid === header.kid && k.kty === 'RSA' && (!k.use || k.use === 'sig') && (!k.alg || k.alg === 'RS256'),
  );
  if (
    !key ||
    !verify(
      'RSA-SHA256',
      Buffer.from(parts[0] + '.' + parts[1]),
      createPublicKey({ key, format: 'jwk' }),
      Buffer.from(parts[2], 'base64url'),
    )
  )
    throw Error('身份令牌签名验证失败');
  const j = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  if (
    j.iss !== 'https://auth.openai.com' ||
    !(j.aud === clientId || (Array.isArray(j.aud) && j.aud.includes(clientId))) ||
    (Array.isArray(j.aud) && j.aud.length > 1 && j.azp !== clientId) ||
    typeof j.exp !== 'number' ||
    !Number.isFinite(j.exp) ||
    j.exp <= now ||
    typeof j.iat !== 'number' ||
    !Number.isFinite(j.iat) ||
    j.iat > now + 60 ||
    (j.nbf !== undefined && (typeof j.nbf !== 'number' || !Number.isFinite(j.nbf) || j.nbf > now + 60)) ||
    typeof j.sub !== 'string' ||
    !j.sub ||
    (nonce !== undefined && !equal(j.nonce || '', nonce))
  )
    throw Error('身份令牌身份、有效期或 nonce 不匹配');
  return j as { sub: string; email?: string };
}
export class SubscriptionAuth extends EventEmitter {
  private saved: Saved = { hostId: '', active: null, registrations: [] };
  private queue = new SerialQueue();
  private ready: Promise<void>;
  private refreshing: Promise<Tokens> | null = null;
  private attempt: {
    server: http.Server;
    controller: AbortController;
    state: string;
    nonce: string;
    verifier: string;
    redirect: string;
    record: Registration;
    timer: ReturnType<typeof setTimeout>;
    accepting: boolean;
  } | null = null;
  constructor(
    readonly kind: SubscriptionKind,
    private file: string,
    private protection: CredentialProtection,
    private request: typeof fetch = fetch,
  ) {
    super();
    this.ready = this.load();
  }
  private async load() {
    this.saved = await readJson(this.file, this.saved);
    if (!this.saved.hostId) {
      this.saved.hostId = 'urn:uuid:' + randomUUID();
      await this.persist();
    }
  }
  private persist() {
    return this.queue.run(() => atomicJson(this.file, this.saved));
  }
  async view() {
    await this.ready;
    const r = this.saved.registrations.find((r) => r.id === this.saved.active);
    return {
      account: r?.subject
        ? {
            id: r.id,
            label: r.label,
            plan: r.authorized
              ? this.kind === 'siwc'
                ? 'ChatGPT 订阅已授权'
                : 'Antigravity 实验接入'
              : '未授权使用套餐',
            authorized: r.authorized && !!r.secret,
          }
        : null,
      accounts: this.saved.registrations
        .filter((r) => r.subject)
        .map((r) => ({ id: r.id, label: r.label, authorized: r.authorized && !!r.secret })),
    };
  }
  private async json(url: string, options: RequestInit = {}) {
    const response = await this.request(url, {
      ...options,
      redirect: 'error',
      signal: options.signal || AbortSignal.timeout(25000),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as any;
      const code = typeof body?.error === 'string' ? body.error : body?.error?.code;
      throw Object.assign(
        Error(
          response.status === 401
            ? '登录已过期，请重新授权。'
            : response.status === 403
              ? '账户或组织不允许访问该订阅服务。'
              : response.status === 429
                ? '订阅额度或速率已达限制，请到服务商查看。'
                : `授权服务返回 HTTP ${response.status}，请稍后重试。`,
        ),
        { status: response.status, code: typeof code === 'string' ? code : undefined },
      );
    }
    const text = await response.text();
    if (text.length > 4_000_000) throw Error('授权服务响应过大');
    return text ? JSON.parse(text) : {};
  }
  async begin(newAccount = false) {
    await this.ready;
    if (this.attempt) throw Error('已有登录正在进行，请完成或先取消。');
    const pending = this.saved.registrations.findLast((r) => !r.subject && !!r.clientId);
    const current = this.saved.registrations.find((r) => r.id === this.saved.active) || pending;
    const record =
      !newAccount && current
        ? current
        : pending || { id: randomUUID(), clientId: '', subject: '', label: '', authorized: false };
    const state = random(),
      nonce = random(),
      verifier = random(),
      controller = new AbortController();
    const server = http.createServer((req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      const a = this.attempt;
      if (!a || a.server !== server || a.accepting) {
        res.writeHead(409).end('No pending sign-in');
        return;
      }
      const target = req.url || '';
      if (req.method !== 'GET' || req.headers.host !== new URL(a.redirect).host) {
        res.writeHead(400).end('Invalid callback');
        return;
      }
      let result: ReturnType<typeof validateCallback>;
      try {
        result = validateCallback(target, a.redirect, a.state, a.record.clientId, this.kind);
      } catch (e) {
        res.writeHead(400).end('Authorization not completed. Return to Study Mate.');
        try {
          const u = new URL(target, a.redirect);
          if (
            u.origin === new URL(a.redirect).origin &&
            equal(u.searchParams.get('state') || '', a.state) &&
            u.searchParams.has('error')
          ) {
            this.cancel();
            this.emit('notice', '授权未完成，原来的登录保持不变。');
          }
        } catch {
          /* A malformed callback must not escape the HTTP handler. */
        }
        return;
      }
      a.accepting = true;
      res.end('Authorization received. Return to Study Mate.');
      void this.finish(a, result)
        .then((authorized) =>
          this.emit(
            'notice',
            authorized
              ? '授权完成。请读取模型列表并发送问题验证访问。'
              : '账号身份已验证，但未获得套餐使用权限。请重新授权，或选择其他接入方式。',
          ),
        )
        .catch(() =>
          this.emit('notice', '授权未完成：请检查授权权限、网络或重新登录。原有有效账户未被覆盖。'),
        )
        .finally(() => {
          if (this.attempt === a) this.cancel();
        });
    });
    server.headersTimeout = 5000;
    server.requestTimeout = 10000;
    server.maxHeadersCount = 30;
    await new Promise<void>((resolve, reject) => {
      server.once('error', () =>
        reject(
          Error(
            this.kind === 'antigravity'
              ? '登录端口 51121 被占用，请先结束其他 Google 登录。'
              : '无法启动本机授权回调。',
          ),
        ),
      );
      server.listen(this.kind === 'antigravity' ? 51121 : 0, '127.0.0.1', () => resolve());
    });
    const redirect = `http://127.0.0.1:${(server.address() as any).port}${this.kind === 'siwc' ? '/auth/callback' : '/callback'}`;
    const timer = setTimeout(
      () => {
        this.cancel();
        this.emit('notice', '登录已超时，请重新发起授权。');
      },
      5 * 60 * 1000,
    );
    this.attempt = { server, controller, state, nonce, verifier, redirect, record, timer, accepting: false };
    const q = new URLSearchParams({
      client_id: this.kind === 'siwc' ? record.clientId || 'dynamic_agent_client' : GOOGLE_CLIENT,
      response_type: 'code',
      redirect_uri: redirect,
      state,
      code_challenge_method: 'S256',
      code_challenge: pkce(verifier),
    });
    if (this.kind === 'siwc') {
      q.set('nonce', nonce);
      q.set('ext_agent_host_id', this.saved.hostId);
      q.set('resource', RESOURCE);
      q.set('scope', 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct');
      if (!record.clientId) q.set('agent_name_hint', 'Study Mate');
      else {
        if (record.label) q.set('login_hint', record.label);
        if (record.subject && !record.authorized) q.set('prompt', 'consent');
      }
    } else {
      q.set(
        'scope',
        ['cloud-platform', 'userinfo.email', 'userinfo.profile', 'cclog', 'experimentsandconfigs']
          .map((s) => 'https://www.googleapis.com/auth/' + s)
          .join(' '),
      );
      q.set('access_type', 'offline');
      q.set('prompt', 'consent select_account');
    }
    return {
      id: state,
      url:
        (this.kind === 'siwc'
          ? 'https://auth.openai.com/api/accounts/authorize'
          : 'https://accounts.google.com/o/oauth2/v2/auth') +
        '?' +
        q,
    };
  }
  private async finish(
    a: NonNullable<SubscriptionAuth['attempt']>,
    callback: { code: string; clientId: string },
  ) {
    const isOpenAI = this.kind === 'siwc',
      record = a.record;
    if (isOpenAI && !record.clientId) {
      record.clientId = callback.clientId;
      if (!this.saved.registrations.some((r) => r.id === record.id))
        this.saved.registrations.push({ ...record });
      await this.persist();
    }
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: callback.clientId,
      code: callback.code,
      code_verifier: a.verifier,
      redirect_uri: a.redirect,
    });
    if (isOpenAI) form.set('resource', RESOURCE);
    else form.set('client_secret', GOOGLE_PUBLIC_SECRET);
    const token = await this.json(
      isOpenAI ? 'https://auth.openai.com/api/accounts/oauth/token' : 'https://oauth2.googleapis.com/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form,
        signal: a.controller.signal,
      },
    );
    if (
      (!isOpenAI && (!token.access_token || !token.refresh_token)) ||
      (token.access_token && !/^Bearer$/i.test(token.token_type))
    )
      throw Error('授权未返回完整凭据');
    let subject: string, label: string, project: string | undefined;
    if (isOpenAI) {
      const metadata = await this.discovery();
      const jwks = await this.json(metadata.jwks_uri, { signal: a.controller.signal });
      const identity = verifyIdentity(token.id_token || '', jwks, callback.clientId, a.nonce);
      subject = identity.sub;
      label = identity.email || 'ChatGPT 账号';
    } else {
      const identity = await this.json('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: 'Bearer ' + token.access_token },
        signal: a.controller.signal,
      });
      subject = identity.id;
      label = identity.email || 'Google 账号';
      if (!subject) throw Error('未返回 Google 账号身份');
      project = await this.discoverProject(token.access_token, a.controller.signal);
    }
    if (record.subject && record.subject !== subject) throw Error('账户身份变化，请使用添加账户入口。');
    if (a.controller.signal.aborted || this.attempt !== a) throw Error('登录已取消');
    const scope = scopes(token),
      next: Registration = {
        ...record,
        clientId: callback.clientId,
        subject,
        label,
        project,
        authorized:
          !!token.access_token && (!isOpenAI || scope.split(/\s+/).includes('chatgpt.tokens.use.direct')),
        secret: this.protection.encrypt(
          JSON.stringify({
            ...token,
            scope,
            expires_at: tokenExpiry(token.expires_in),
          }),
        ),
      };
    const index = this.saved.registrations.findIndex((r) => r.id === record.id);
    if (index < 0) this.saved.registrations.push(next);
    else this.saved.registrations[index] = next;
    this.saved.active = next.id;
    await this.persist();
    return next.authorized;
  }
  private async discovery() {
    const d = await this.json('https://auth.openai.com/.well-known/openid-configuration');
    if (d.issuer !== 'https://auth.openai.com') throw Error('授权签发方不匹配');
    for (const k of ['jwks_uri', 'revocation_endpoint']) {
      const u = new URL(d[k]);
      if (u.origin !== 'https://auth.openai.com' || u.username || u.password)
        throw Error('授权发现地址不受信任');
    }
    return d;
  }
  cancel() {
    const a = this.attempt;
    this.attempt = null;
    if (a) {
      clearTimeout(a.timer);
      a.controller.abort();
      a.server.close();
      a.server.closeAllConnections();
    }
  }
  async select(id: string) {
    await this.ready;
    if (this.refreshing) await this.refreshing.catch(() => {});
    if (!this.saved.registrations.some((r) => r.id === id && r.subject)) throw Error('账户不存在');
    if (this.attempt) throw Error('请先结束当前授权');
    this.saved.active = id;
    await this.persist();
  }
  async credentials() {
    await this.ready;
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.fresh().finally(() => (this.refreshing = null));
    return this.refreshing;
  }
  private async fresh(): Promise<Tokens> {
    const r = this.saved.registrations.find((r) => r.id === this.saved.active);
    if (!r?.secret || !r.authorized) throw Error('请先登录并明确授权使用订阅额度。');
    const old = JSON.parse(this.protection.decrypt(r.secret)) as Tokens;
    if (old.expires_at > Date.now() + 60000) return { ...old, recordId: r.id, project: r.project };
    if (!old.refresh_token) throw Error('登录已过期，请重新授权');
    if (old.earliest_refresh_at && Date.now() / 1000 < old.earliest_refresh_at)
      throw Error('尚未到允许续期时间，请稍后重试。');
    const isOpenAI = this.kind === 'siwc';
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: r.clientId,
      refresh_token: old.refresh_token,
    });
    if (isOpenAI) form.set('resource', RESOURCE);
    else form.set('client_secret', GOOGLE_PUBLIC_SECRET);
    let token: any;
    try {
      token = await this.json(
        isOpenAI ? 'https://auth.openai.com/api/accounts/oauth/token' : 'https://oauth2.googleapis.com/token',
        { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form },
      );
    } catch (e) {
      if (
        [
          'invalid_grant',
          'invalid_refresh_token',
          'token_expired',
          'refresh_token_expired',
          'refresh_token_invalidated',
          'refresh_token_reused',
        ].includes((e as any)?.code)
      ) {
        delete r.secret;
        r.authorized = false;
        await this.persist();
        throw Error('订阅授权已失效，本地无效令牌已清除，请重新登录。');
      }
      throw e;
    }
    const scope = scopes(token, old.scope);
    if (
      !token.access_token ||
      !/^Bearer$/i.test(token.token_type) ||
      (isOpenAI && (!token.refresh_token || !scope.split(/\s+/).includes('chatgpt.tokens.use.direct')))
    )
      throw Error('订阅授权续期未完成，请重新登录');
    if (isOpenAI && token.id_token) {
      const d = await this.discovery();
      const identity = verifyIdentity(token.id_token, await this.json(d.jwks_uri), r.clientId);
      if (identity.sub !== r.subject) throw Error('续期账户身份不匹配');
    }
    const next = {
      ...old,
      ...token,
      scope,
      expires_at: tokenExpiry(token.expires_in),
    };
    r.secret = this.protection.encrypt(JSON.stringify(next));
    await this.persist();
    return { ...next, recordId: r.id, project: r.project };
  }
  async logout() {
    await this.ready;
    this.cancel();
    if (this.refreshing) await this.refreshing.catch(() => {});
    const r = this.saved.registrations.find((r) => r.id === this.saved.active);
    if (!r) return true;
    let revoked = false;
    try {
      const token = r.secret ? JSON.parse(this.protection.decrypt(r.secret)) : {};
      if (token.refresh_token) {
        const form = new URLSearchParams({ token: token.refresh_token });
        if (this.kind === 'siwc') {
          form.set('client_id', r.clientId);
          form.set('token_type_hint', 'refresh_token');
        }
        const url =
          this.kind === 'siwc'
            ? (await this.discovery()).revocation_endpoint
            : 'https://oauth2.googleapis.com/revoke';
        await this.json(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form,
        });
        revoked = true;
      }
    } catch {}
    delete r.secret;
    r.authorized = false;
    await this.persist();
    return revoked;
  }
  private async discoverProject(access: string, signal: AbortSignal) {
    const headers = {
      Authorization: 'Bearer ' + access,
      'User-Agent': ANTIGRAVITY_UA,
      'Content-Type': 'application/json',
    };
    const get = (j: any): string => {
      for (const key of ['cloudaicompanionProject', 'projectId', 'project']) {
        const v = j?.[key];
        if (typeof v === 'string' && v) return v;
        if (v?.id) return v.id;
      }
      return '';
    };
    const loaded = await this.json('https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist', {
      method: 'POST',
      headers,
      body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } }),
      signal,
    });
    const found = get(loaded);
    if (found) return found;
    for (let i = 0; i < 5; i++) {
      const j = await this.json('https://daily-cloudcode-pa.googleapis.com/v1internal:onboardUser', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          tier_id: 'free-tier',
          metadata: { ide_type: 'ANTIGRAVITY', ide_name: 'antigravity', ide_version: '2.5.5' },
        }),
        signal,
      });
      const p = get(j.response || j);
      if (p) return p;
      if (i < 4)
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, 2000);
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(t);
              reject(Error('已取消'));
            },
            { once: true },
          );
        });
    }
    throw Error('Google 账户未返回可用项目；Gemini 订阅不保证此接口可用。');
  }
  async project() {
    await this.ready;
    return this.saved.registrations.find((r) => r.id === this.saved.active)?.project || '';
  }
  async models(): Promise<AiModel[]> {
    const tokens = await this.credentials();
    const openai = this.kind === 'siwc';
    const json = await this.json(
      openai
        ? RESOURCE + '/models'
        : 'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
      {
        method: openai ? 'GET' : 'POST',
        headers: {
          Authorization: 'Bearer ' + tokens.access_token,
          ...(!openai ? { 'User-Agent': ANTIGRAVITY_UA, 'Content-Type': 'application/json' } : {}),
        },
        ...(!openai ? { body: JSON.stringify({ project: tokens.project }) } : {}),
      },
    );
    if (openai)
      return (json.models || [])
        .filter((m: any) => m.visibility === 'list')
        .slice(0, 500)
        .map((m: any) => ({
          id: m.slug,
          displayName: m.display_name,
          efforts: (m.supported_reasoning_levels || []).map((e: any) =>
            typeof e === 'string' ? e : e.effort || e.reasoning_effort,
          ),
          contextSize: m.context_window,
        }));
    return Object.entries(json.models || {})
      .filter(([, m]: any) => !m.isInternal)
      .slice(0, 500)
      .map(([id, m]: any) => ({
        id,
        displayName: m.displayName || id,
        efforts: [],
        contextSize: m.maxInputTokens || m.contextWindow,
      }));
  }
  async close() {
    this.cancel();
    await this.ready;
    await this.refreshing?.catch(() => {});
    await this.queue.flush();
  }
}
