import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { KnowledgeHit, KnowledgeStatus, Backlink } from '../shared/knowledge';
import { linkCandidates } from './note-links';
export const EMBEDDING_VERSION = 'multilingual-minilm-l12-q8-384-v1';
const ignored = new Set(['.git', '.obsidian', '.studymate', 'node_modules']);
export function terms(text: string) {
  const normalized = text.normalize('NFKC').toLocaleLowerCase(),
    words =
      normalized.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+|[\p{L}\p{N}_]+/gu) || [];
  return words
    .flatMap((w) =>
      /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(w)
        ? [...w, ...Array.from({ length: Math.max(0, w.length - 1) }, (_, i) => w.slice(i, i + 2))]
        : [w],
    )
    .join(' ');
}
export function chunkNote(text: string) {
  const lines = text.replace(/^\uFEFF/, '').split('\n'),
    result: { text: string; lineStart: number; lineEnd: number }[] = [];
  let current = '',
    start = 1;
  for (let i = 0; i < lines.length; i++) {
    if (current.length + lines[i].length > 400 && current) {
      result.push({ text: current, lineStart: start, lineEnd: i });
      current = '';
      start = i + 1;
    }
    if (!current) start = i + 1;
    const line = lines[i];
    if (line.length > 400) {
      if (current) {
        result.push({ text: current, lineStart: start, lineEnd: i });
        current = '';
      }
      for (let j = 0; j < line.length; j += 400)
        result.push({ text: line.slice(j, j + 400), lineStart: i + 1, lineEnd: i + 1 });
      start = i + 2;
    } else current += line + '\n';
  }
  if (current.trim()) result.push({ text: current, lineStart: start, lineEnd: lines.length });
  if (!result.length) result.push({ text: '', lineStart: 1, lineEnd: 1 });
  return result;
}
export function noteLinks(text: string) {
  const output: { target: string; line: number }[] = [];
  const lines = text.split('\n');
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const line = lines[i].replace(/`[^`]*`/g, '');
    for (const m of line.matchAll(
      /!?\[\[([^\]|]+)(?:\|[^\]]*)?\]\]|(?<!!)\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g,
    )) {
      let target = m[1] || m[2];
      try {
        target = decodeURIComponent(target.replace(/^<|>$/g, ''));
      } catch {}
      if (!target || /^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith('#')) continue;
      target = target.split('#')[0];
      if (/\.[a-z\d]+$/i.test(target) && !target.toLowerCase().endsWith('.md')) continue;
      output.push({ target, line: i + 1 });
    }
  }
  return output;
}
export function noteAliases(front: string) {
  const match = /^aliases?:[ \t]*(.*)$/m.exec(front);
  if (!match) return [];
  const inline = match[1].trim();
  const unquote = (s: string) => s.trim().replace(/^['"]|['"]$/g, '');
  if (!inline) {
    const tail = front.slice(match.index + match[0].length);
    const block = /^\r?\n((?:[ \t]+-[^\n]*(?:\n|$))+)/.exec(tail)?.[1] || '';
    return block
      .split('\n')
      .map((line) => /^\s*-\s*(.*)/.exec(line)?.[1])
      .filter((v): v is string => !!v)
      .map(unquote);
  }
  if (inline.startsWith('[')) {
    return (inline.slice(1, inline.lastIndexOf(']')).match(/"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^,]+/g) || [])
      .map(unquote)
      .filter(Boolean);
  }
  return inline === 'null' ? [] : [unquote(inline)];
}
export class KnowledgeDb {
  private db: DatabaseSync;
  private status: KnowledgeStatus;
  private scanningSeen: Set<string> | null = null;
  constructor(
    readonly root: string,
    readonly vaultId: string,
    file: string,
  ) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
 CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY,name TEXT,mtime REAL,size INTEGER,digest TEXT,error TEXT DEFAULT '');
 CREATE TABLE IF NOT EXISTS chunks(id INTEGER PRIMARY KEY AUTOINCREMENT,path TEXT,ordinal INTEGER,start INTEGER,end INTEGER,text TEXT,vector BLOB,vector_version TEXT);
 CREATE INDEX IF NOT EXISTS chunk_path ON chunks(path);
 CREATE VIRTUAL TABLE IF NOT EXISTS lookup USING fts5(terms, tokenize='unicode61');
 CREATE TABLE IF NOT EXISTS links(source TEXT,target TEXT,line INTEGER);
 CREATE INDEX IF NOT EXISTS link_source ON links(source);
 CREATE TABLE IF NOT EXISTS aliases(path TEXT,alias TEXT);
 CREATE INDEX IF NOT EXISTS alias_name ON aliases(alias);
 `);
    this.status = {
      vaultId,
      phase: 'starting',
      files: 0,
      chunks: 0,
      skipped: 0,
      embedded: 0,
      embedding: false,
      message: '正在连接持久化索引',
      updatedAt: '',
    };
    this.counts();
  }
  counts() {
    const one = (sql: string) => (this.db.prepare(sql).get() as any).n;
    Object.assign(this.status, {
      files: one("SELECT count(*) n FROM files WHERE error=''"),
      skipped: one("SELECT count(*) n FROM files WHERE error!=''"),
      chunks: one('SELECT count(*) n FROM chunks'),
      embedded: (
        this.db.prepare('SELECT count(*) n FROM chunks WHERE vector_version=?').get(EMBEDDING_VERSION) as any
      ).n,
      updatedAt: new Date().toISOString(),
    });
    return { ...this.status };
  }
  private remove(relative: string) {
    this.db.prepare('DELETE FROM lookup WHERE rowid IN (SELECT id FROM chunks WHERE path=?)').run(relative);
    this.db.prepare('DELETE FROM chunks WHERE path=?').run(relative);
    this.db.prepare('DELETE FROM links WHERE source=?').run(relative);
    this.db.prepare('DELETE FROM aliases WHERE path=?').run(relative);
    this.db.prepare('DELETE FROM files WHERE path=?').run(relative);
  }
  async update(relative: string) {
    if (
      !relative ||
      path.isAbsolute(relative) ||
      relative
        .split(/[\\/]/)
        .some((p) => p === '..' || ignored.has(p.toLowerCase()) || p.startsWith('.studymate-')) ||
      !relative.toLowerCase().endsWith('.md')
    )
      return;
    this.scanningSeen?.add(relative);
    const file = path.join(this.root, relative);
    let stat;
    try {
      const actual = await fs.realpath(file);
      if (!actual.toLowerCase().startsWith(this.root.toLowerCase() + path.sep)) throw Error('范围外文件');
      stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw Error('非普通文件');
    } catch {
      this.remove(relative);
      return;
    }
    const old = this.db.prepare('SELECT * FROM files WHERE path=?').get(relative) as any;
    if (old && old.mtime === stat.mtimeMs && old.size === stat.size) return;
    let text = '',
      error = '';
    if (stat.size > 2 * 1024 * 1024) error = '超过单笔记2MiB读取预算';
    else
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(await fs.readFile(file));
      } catch {
        error = '无法读取UTF-8笔记';
      }
    const digest = createHash('sha256').update(text).digest('hex');
    if (old?.digest === digest && !error) {
      this.db.prepare('UPDATE files SET mtime=?,size=? WHERE path=?').run(stat.mtimeMs, stat.size, relative);
      return;
    }
    this.db.exec('BEGIN');
    try {
      this.remove(relative);
      this.db
        .prepare('INSERT INTO files VALUES(?,?,?,?,?,?)')
        .run(relative, path.basename(relative, '.md'), stat.mtimeMs, stat.size, digest, error);
      if (!error) {
        const add = this.db.prepare('INSERT INTO chunks(path,ordinal,start,end,text) VALUES(?,?,?,?,?)'),
          fts = this.db.prepare('INSERT INTO lookup(rowid,terms) VALUES(?,?)');
        chunkNote(text).forEach((c, i) => {
          const id = add.run(relative, i, c.lineStart, c.lineEnd, c.text).lastInsertRowid;
          fts.run(id, terms(relative + '\n' + c.text));
        });
        for (const link of noteLinks(text))
          this.db.prepare('INSERT INTO links VALUES(?,?,?)').run(relative, link.target, link.line);
        this.db
          .prepare('INSERT INTO aliases VALUES(?,?)')
          .run(relative, path.basename(relative, '.md').toLocaleLowerCase());
        const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] || '';
        for (const alias of noteAliases(front))
          this.db.prepare('INSERT INTO aliases VALUES(?,?)').run(relative, alias.toLocaleLowerCase());
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  async scan(progress: (s: KnowledgeStatus) => void) {
    this.status.phase = 'scanning';
    progress(this.counts());
    const seen = new Set<string>();
    this.scanningSeen = seen;
    let inaccessible = 0;
    const stack = [{ directory: this.root, relative: '' }];
    let visited = 0;
    while (stack.length) {
      const current = stack.pop()!;
      let entries;
      try {
        entries = await fs.readdir(current.directory, { withFileTypes: true });
      } catch {
        inaccessible++;
        continue;
      }
      for (const entry of entries) {
        if (
          entry.isSymbolicLink() ||
          ignored.has(entry.name.toLowerCase()) ||
          entry.name.startsWith('.studymate-')
        )
          continue;
        const relative = current.relative ? current.relative + '/' + entry.name : entry.name;
        if (entry.isDirectory())
          stack.push({ directory: path.join(current.directory, entry.name), relative });
        else if (entry.isFile() && /\.md$/i.test(entry.name)) {
          seen.add(relative);
          await this.update(relative);
          if (++visited % 100 === 0) {
            this.status.message = `已扫描 ${visited} 篇，检索可继续使用已有索引`;
            progress(this.counts());
            await new Promise((r) => setTimeout(r, 0));
          }
        }
      }
    }
    this.scanningSeen = null;
    if (!inaccessible)
      for (const row of this.db.prepare('SELECT path FROM files').all() as any[])
        if (!seen.has(row.path)) this.remove(row.path);
    this.status.phase = inaccessible ? 'error' : 'ready';
    this.status.message = inaccessible
      ? `有 ${inaccessible} 个目录无法读取，保留上次索引，请检查权限`
      : this.status.skipped
        ? '索引就绪，部分文件因大小或编码限制被跳过'
        : '全文索引就绪';
    progress(this.counts());
    return this.counts();
  }
  keyword(query: string, limit = 30): KnowledgeHit[] {
    const tokens = [...new Set(terms(query).split(' ').filter(Boolean))];
    if (!tokens.length) return [];
    const expression = tokens.map((t) => '"' + t.replaceAll('"', '""') + '"').join(' AND ');
    const rows = this.db
      .prepare(
        'SELECT c.*,bm25(lookup) rank FROM lookup JOIN chunks c ON c.id=lookup.rowid WHERE lookup MATCH ? ORDER BY rank',
      )
      .iterate(expression) as any;
    const results = new Map<string, KnowledgeHit>();
    for (const r of rows) {
      if (results.has(r.path)) continue;
      const at = Math.max(0, r.text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()) - 70);
      results.set(r.path, {
        path: r.path,
        name: path.basename(r.path, '.md'),
        snippet: r.text.slice(at, at + 300).trim(),
        lineStart: r.start,
        lineEnd: r.end,
        score: -r.rank,
        match: 'keyword',
      });
      if (results.size >= limit) break;
    }
    return [...results.values()];
  }
  pending(limit = 12) {
    return this.db
      .prepare(
        'SELECT id,path,text,start,end FROM chunks WHERE vector_version IS NULL OR vector_version!=? LIMIT ?',
      )
      .all(EMBEDDING_VERSION, limit);
  }
  vectors(rows: { id: number; vector: number[] }[]) {
    const statement = this.db.prepare('UPDATE chunks SET vector=?,vector_version=? WHERE id=?');
    for (const row of rows) {
      if (row.vector.length !== 384 || row.vector.some((x) => !Number.isFinite(x)))
        throw Error('语义向量格式无效');
      statement.run(Buffer.from(new Float32Array(row.vector).buffer), EMBEDDING_VERSION, row.id);
    }
    return this.counts();
  }
  semantic(vector: number[], limit = 30): KnowledgeHit[] {
    if (vector.length !== 384) throw Error('查询向量维度无效');
    const best = new Map<string, { row: any; score: number }>();
    for (const row of this.db
      .prepare('SELECT * FROM chunks WHERE vector_version=?')
      .iterate(EMBEDDING_VERSION) as any) {
      const bytes = row.vector as Uint8Array,
        values = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      let score = 0;
      for (let i = 0; i < 384; i++) score += vector[i] * values[i];
      const previous = best.get(row.path);
      if (!previous || score > previous.score) best.set(row.path, { row, score });
    }
    return [...best.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ row, score }) => ({
        path: row.path,
        name: path.basename(row.path, '.md'),
        snippet: row.text.slice(0, 300).trim(),
        lineStart: row.start,
        lineEnd: row.end,
        score,
        match: 'semantic',
      }));
  }
  backlinks(target: string): Backlink[] {
    const files = this.db.prepare("SELECT path FROM files WHERE error=''").all() as any[],
      byPath = new Map(files.map((f) => [f.path.toLocaleLowerCase(), f.path]));
    const resolve = (source: string, raw: string) => {
      let value = raw.replaceAll('\\', '/').replace(/\.md$/i, '');
      for (const candidate of [
        path.posix.normalize(path.posix.join(path.posix.dirname(source), value)) + '.md',
        value + '.md',
      ])
        if (byPath.has(candidate.toLocaleLowerCase())) return byPath.get(candidate.toLocaleLowerCase());
      const found = this.db
        .prepare('SELECT DISTINCT path FROM aliases WHERE alias=?')
        .all(path.posix.basename(value).toLocaleLowerCase()) as any[];
      return found.length === 1 ? found[0].path : null;
    };
    return (this.db.prepare('SELECT * FROM links').all() as any[])
      .flatMap((link) =>
        resolve(link.source, link.target)?.toLocaleLowerCase() === target.toLocaleLowerCase()
          ? [
              {
                path: link.source,
                name: path.basename(link.source, '.md'),
                line: link.line,
                target: link.target,
                resolved: true,
              },
            ]
          : [],
      )
      .slice(0, 500);
  }
  resolve(base: string, target: string, wiki: boolean) {
    const parsed = linkCandidates(base, target, wiki);
    for (const candidate of parsed.candidates) {
      const row = this.db
        .prepare("SELECT path FROM files WHERE lower(path)=lower(?) AND error='' LIMIT 1")
        .get(candidate) as any;
      if (row) return { path: row.path, anchor: parsed.anchor };
    }
    if (wiki) {
      const stem = path.posix.basename(parsed.suffix.replace(/\.md$/i, '')).toLocaleLowerCase(),
        rows = this.db.prepare('SELECT DISTINCT path FROM aliases WHERE alias=?').all(stem) as any[];
      if (rows.length > 1) throw Error('链接有多个同名或别名目标，请补全目录');
      if (rows[0]) return { path: rows[0].path, anchor: parsed.anchor };
    }
    throw Error('索引中未找到链接目标');
  }
  issues() {
    return this.db.prepare("SELECT path,error FROM files WHERE error!='' LIMIT 200").all();
  }
  close() {
    this.db.close();
  }
}
