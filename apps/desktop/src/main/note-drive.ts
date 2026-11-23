import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import { net, safeStorage, shell } from 'electron';
import { z } from 'zod';
import { atomicJson, readJson } from '../core/storage';
import {
  handwritingPadListSchema,
  mergeHandwritingPads,
  type SharedHandwritingPad,
  type VaultInkDriveDocument,
} from '../shared/note-ink';
import type { ReadingSnapshot } from '../shared/note-sync';

const scope = 'https://www.googleapis.com/auth/drive.appdata';
const api = 'https://www.googleapis.com/drive/v3';
const upload = 'https://www.googleapis.com/upload/drive/v3';
const credential = z.object({ installed: z.object({
  client_id: z.string().regex(/^[\w.-]+\.apps\.googleusercontent\.com$/),
  client_secret: z.string().min(1).max(256),
}) });
type Client = z.infer<typeof credential>['installed'];
type Grant = Client & { refresh: string; account: string; owner: string };

export class NoteDrive {
  private readonly file: string;
  private authorizing = false;
  private access?: { token: string; expires: number };
  private ids = new Map<string, string>();

  constructor(dataDir: string) { this.file = path.join(dataDir, 'state', 'note-drive.json'); }

  private async grant(): Promise<Grant | null> {
    const saved = await readJson<{ encrypted: string } | null>(this.file, null);
    return saved ? JSON.parse(safeStorage.decryptString(Buffer.from(saved.encrypted, 'base64'))) as Grant : null;
  }

  async account() { return (await this.grant())?.account ?? ''; }

  async disconnect() {
    if (this.authorizing) throw Error('请先完成浏览器授权。');
    await fs.unlink(this.file).catch((e) => { if (e.code !== 'ENOENT') throw e; });
    this.access = undefined;
    this.ids.clear();
  }

  async connect(raw: string) {
    if (this.authorizing) throw Error('浏览器授权已经开始。');
    if (await this.grant()) throw Error('请先断开当前 Google Drive 账号。');
    if (this.authorizing) throw Error('浏览器授权已经开始。');
    if (!safeStorage.isEncryptionAvailable()) throw Error('系统凭据加密不可用。');
    let client: Client;
    try { client = credential.parse(JSON.parse(raw)).installed; }
    catch { throw Error('请选择 Google Cloud 下载的桌面应用 OAuth 客户端 JSON。'); }
    this.authorizing = true;
    try {
      const tokens = await this.authorize(client);
      if (!tokens.refresh_token) throw Error('Google 未返回长期访问凭据，请重新授权。');
      const user = (await (await this.request(tokens.access_token, api + '/about?fields=user(emailAddress,permissionId)')).json()).user;
      if (!user?.permissionId || !user.emailAddress) throw Error('无法识别 Google Drive 账号。');
      const grant: Grant = { ...client, refresh: tokens.refresh_token, account: user.emailAddress, owner: user.permissionId };
      await atomicJson(this.file, { encrypted: safeStorage.encryptString(JSON.stringify(grant)).toString('base64') });
      this.access = undefined;
      this.ids.clear();
    } finally { this.authorizing = false; }
  }

  private async authorize(client: Client) {
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    let accept!: (code: string) => void, reject!: (error: Error) => void;
    const result = new Promise<string>((resolve, fail) => { accept = resolve; reject = fail; });
    void result.catch(() => {});
    const server = createServer((req, res) => {
      const query = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method !== 'GET' || query.pathname !== '/oauth' || query.searchParams.get('state') !== state) {
        res.writeHead(404).end(); return;
      }
      const code = query.searchParams.get('code');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
        .end(code ? '授权响应已收到，请返回 Study Mate。' : '授权未完成，请返回 Study Mate。');
      if (code) accept(code); else reject(Error('Google Drive 授权被取消。'));
    });
    const timer = setTimeout(() => reject(Error('Google Drive 授权超时。')), 180_000);
    try {
      await new Promise<void>((resolve, fail) => {
        server.once('error', fail);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw Error('无法启动授权回调。');
      const redirect_uri = 'http://127.0.0.1:' + address.port + '/oauth';
      const query = new URLSearchParams({ client_id: client.client_id, redirect_uri, response_type: 'code',
        scope, state, code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent select_account' });
      await shell.openExternal('https://accounts.google.com/o/oauth2/v2/auth?' + query);
      const code = await result;
      return await this.token(client, { grant_type: 'authorization_code', code, redirect_uri, code_verifier: verifier });
    } finally { clearTimeout(timer); server.close(); server.closeAllConnections(); }
  }

  private async token(client: Client, params: Record<string, string>) {
    const response = await net.fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', body: new URLSearchParams({ client_id: client.client_id, client_secret: client.client_secret, ...params }),
      redirect: 'error', signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw Error('Google 授权已过期或失败，请重新连接 Google Drive。');
    return z.object({ access_token: z.string().min(1), refresh_token: z.string().optional(), expires_in: z.number() }).parse(await response.json());
  }

  private async request(token: string, url: string, init: RequestInit = {}) {
    const response = await net.fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(35_000),
      headers: { Authorization: 'Bearer ' + token, ...init.headers } });
    if (!response.ok) throw Error('Google Drive 请求失败（HTTP ' + response.status + '）。');
    return response;
  }

  private async ensureAccessToken(): Promise<string | null> {
    const grant = await this.grant();
    if (!grant) return null;
    if (!this.access || Date.now() > this.access.expires) {
      const result = await this.token(grant, { grant_type: 'refresh_token', refresh_token: grant.refresh });
      this.access = { token: result.access_token, expires: Date.now() + (result.expires_in - 60) * 1000 };
    }
    return this.access.token;
  }

  async publish(snapshot: ReadingSnapshot) {
    const token = await this.ensureAccessToken();
    if (!token) return;
    const name = 'study-mate-notes-v1-' + snapshot.source + '.json';
    let id = this.ids.get(name);
    if (!id) {
      const query = new URLSearchParams({ spaces: 'appDataFolder', q: "name = '" + name + "'", fields: 'files(id,description)', pageSize: '100' });
      const { files } = await (await this.request(token, api + '/files?' + query)).json();
      if (files?.length > 1) throw Error('Drive 中存在重复的同步目录，请检查应用数据。');
      id = files?.[0]?.id;
      if (id && files[0].description === String(snapshot.revision)) {
        this.ids.set(name, id);
        return;
      }
    }
    const data = Buffer.from(JSON.stringify(snapshot));
    const creating = !id;
    if (!id) {
      const result = await (await this.request(token, api + '/files/generateIds?space=appDataFolder&count=1')).json();
      id = z.object({ ids: z.array(z.string().min(1)).min(1) }).parse(result).ids[0];
    }
    const opened = await this.request(token, upload + '/files' + (creating ? '' : '/' + encodeURIComponent(id)) + '?uploadType=resumable&fields=id', {
      method: creating ? 'POST' : 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-Upload-Content-Type': 'application/json', 'X-Upload-Content-Length': String(data.length) },
      body: JSON.stringify({ name, description: String(snapshot.revision), ...(creating ? { id, parents: ['appDataFolder'] } : {}) }),
    }).catch((error) => { this.ids.delete(name); throw error; });
    const location = new URL(opened.headers.get('location') ?? '');
    if (location.origin !== 'https://www.googleapis.com' || !location.pathname.startsWith('/upload/drive/v3/files'))
      throw Error('Drive 返回了无效的上传地址。');
    const saved = await this.request(token, location.href, { method: 'PUT', body: new Uint8Array(data),
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(data.length) } });
    const file = z.object({ id: z.string().min(1) }).parse(await saved.json());
    this.ids.set(name, file.id);
  }

  /**
   * Bidirectionally pulls, merges, and publishes handwriting pads for a sync source
   * in a dedicated appDataFolder file (`study-mate-ink-v1-<source>.json`) so Desktop
   * markdown syncs never overwrite or drop tablet handwriting pads.
   */
  async syncInk(
    source: string,
    localNotes: Record<string, SharedHandwritingPad[]>,
  ): Promise<Record<string, SharedHandwritingPad[]> | null> {
    const token = await this.ensureAccessToken();
    if (!token) return null;
    const name = 'study-mate-ink-v1-' + source + '.json';
    const query = new URLSearchParams({
      spaces: 'appDataFolder',
      q: "name = '" + name + "'",
      fields: 'files(id,description)',
      pageSize: '20',
    });
    const { files } = await (await this.request(token, api + '/files?' + query)).json();
    let id: string | undefined = files?.[0]?.id;
    let remoteNotes: Record<string, SharedHandwritingPad[]> = {};

    if (id) {
      const resp = await this.request(token, api + '/files/' + encodeURIComponent(id) + '?alt=media');
      const raw = (await resp.json().catch(() => null)) as Partial<VaultInkDriveDocument> | null;
      if (raw && raw.schema === 1 && raw.notes && typeof raw.notes === 'object') {
        for (const [notePath, rawPads] of Object.entries(raw.notes)) {
          const parsed = handwritingPadListSchema.safeParse(rawPads);
          if (parsed.success && parsed.data.length > 0) {
            remoteNotes[notePath] = parsed.data;
          }
        }
      }
    }

    const allPaths = new Set([...Object.keys(localNotes), ...Object.keys(remoteNotes)]);
    const merged: Record<string, SharedHandwritingPad[]> = {};
    for (const notePath of [...allPaths].sort()) {
      const combined = mergeHandwritingPads(localNotes[notePath] ?? [], remoteNotes[notePath] ?? []);
      if (combined.length > 0) merged[notePath] = combined;
    }

    const remoteChanged = JSON.stringify(merged) !== JSON.stringify(remoteNotes);
    if (remoteChanged && (id || Object.keys(merged).length > 0)) {
      const doc: VaultInkDriveDocument = {
        schema: 1,
        source,
        updatedAt: Date.now(),
        notes: merged,
      };
      const data = Buffer.from(JSON.stringify(doc));
      if (data.length > 16 * 1024 * 1024) {
        throw Error('云端手写栏数据超过 16 MiB 限制，请清理部分旧手写栏。');
      }
      const creating = !id;
      if (!id) {
        const result = await (await this.request(token, api + '/files/generateIds?space=appDataFolder&count=1')).json();
        id = z.object({ ids: z.array(z.string().min(1)).min(1) }).parse(result).ids[0];
      }
      const opened = await this.request(
        token,
        upload + '/files' + (creating ? '' : '/' + encodeURIComponent(id)) + '?uploadType=resumable&fields=id',
        {
          method: creating ? 'POST' : 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'X-Upload-Content-Type': 'application/json',
            'X-Upload-Content-Length': String(data.length),
          },
          body: JSON.stringify({
            name,
            description: String(doc.updatedAt),
            ...(creating ? { id, parents: ['appDataFolder'] } : {}),
          }),
        },
      );
      const location = new URL(opened.headers.get('location') ?? '');
      if (location.origin !== 'https://www.googleapis.com' || !location.pathname.startsWith('/upload/drive/v3/files')) {
        throw Error('Drive 返回了无效的手写栏上传地址。');
      }
      await this.request(token, location.href, {
        method: 'PUT',
        body: new Uint8Array(data),
        headers: { 'Content-Type': 'application/json', 'Content-Length': String(data.length) },
      });
    }

    return merged;
  }
}
