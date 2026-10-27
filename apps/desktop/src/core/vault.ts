import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import chokidar, { type FSWatcher } from 'chokidar';
import Fuse from 'fuse.js';
import type { NoteDocument, NoteFile, SaveNoteInput, SearchHit, ImportReport } from '../shared/contracts';
import { AppError } from './errors';
import { atomicJson, readJson, requireDDrive, SerialQueue } from './storage';
import { linkCandidates, type NoteLink } from './note-links';

const MAX_NOTE_BYTES = 2 * 1024 * 1024;
const ignored = new Set(['.git', '.obsidian', '.studymate', 'node_modules']);
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
interface Operation {
  fingerprint: string;
  path: string;
  version: string;
}

export class VaultService extends EventEmitter {
  readonly id: string;
  readonly root: string;
  private writes = new SerialQueue();
  private operations: Record<string, Operation> = {};
  private watcher?: FSWatcher;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private treeCache?: Promise<NoteFile[]>;
  private resourceCache?: { expires: number; files: Promise<string[]> };
  private searchCache = new Map<string, Promise<SearchHit & { text: string }>>();
  private constructor(
    root: string,
    private readonly stateDir: string,
  ) {
    super();
    this.root = root;
    this.id = hash(root.toLowerCase()).slice(0, 24);
  }
  static async open(root: string, stateDir: string): Promise<VaultService> {
    requireDDrive(stateDir);
    await fs.mkdir(root, { recursive: true });
    const actual = await fs.realpath(root);
    const service = new VaultService(actual, stateDir);
    service.operations = await readJson<Record<string, Operation>>(service.operationsFile, {});
    return service;
  }
  private get operationsFile(): string {
    return path.join(this.stateDir, 'vault-' + this.id + '-operations.json');
  }
  private segments(relative: string): string[] {
    if (!relative || path.isAbsolute(relative) || /^[a-z]:/i.test(relative) || relative.includes(':'))
      throw new AppError('PATH_DENIED', '仅能访问当前知识库内的相对路径。');
    const parts = relative.split(/[\\/]/);
    if (
      parts.some(
        (p) =>
          !p ||
          p === '.' ||
          p === '..' ||
          p.length > 240 ||
          /[<>:"|?*\u0000-\u001f]/.test(p) ||
          /[. ]$/.test(p) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(p) ||
          ignored.has(p.toLowerCase()) ||
          p.startsWith('.studymate-'),
      )
    ) {
      throw new AppError('PATH_DENIED', '文件路径包含不允许的目录或 Windows 文件名。');
    }
    return parts;
  }
  private async checkedPath(relative: string, createParents = false): Promise<string> {
    const parts = this.segments(relative);
    let current = this.root;
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      let stat;
      try {
        stat = await fs.lstat(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (i < parts.length - 1 && createParents) {
          await fs.mkdir(current);
          stat = await fs.lstat(current);
        } else if (i === parts.length - 1) return current;
        else throw new AppError('NOT_FOUND', '笔记目录不存在。');
      }
      if (stat.isSymbolicLink())
        throw new AppError('PATH_DENIED', '不能通过符号链接或目录联接访问知识库外文件。');
      if (i < parts.length - 1 && !stat.isDirectory())
        throw new AppError('PATH_DENIED', '文件的上级路径不是目录。');
      const actual = await fs.realpath(current);
      const rel = path.relative(this.root, actual);
      if (rel.startsWith('..') || path.isAbsolute(rel))
        throw new AppError('PATH_DENIED', '文件超出了授权知识库范围。');
    }
    return current;
  }
  private async readAt(target: string, relative: string): Promise<NoteDocument> {
    const stat = await fs.stat(target);
    if (!stat.isFile() || stat.size > MAX_NOTE_BYTES)
      throw new AppError('NOTE_SIZE', '当前版本支持不超过 2 MiB 的 Markdown 笔记。');
    const bytes = await fs.readFile(target);
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new AppError('NOTE_ENCODING', '请将笔记保存为 UTF-8 编码后再打开。');
    }
    return {
      path: relative.replaceAll('\\', '/'),
      content,
      version: hash(bytes),
      modifiedAt: stat.mtime.toISOString(),
    };
  }
  async read(relative: string): Promise<NoteDocument> {
    this.segments(relative);
    if (!/\.md$/i.test(relative)) throw new AppError('NOTE_TYPE', '笔记服务只支持 Markdown 文件。');
    try {
      return await this.readAt(await this.checkedPath(relative), relative);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new AppError('NOT_FOUND', '笔记不存在，可能已被其他应用移动。');
      throw error;
    }
  }
  async write(input: SaveNoteInput): Promise<NoteDocument> {
    return this.writes.run(async () => {
      this.segments(input.path);
      if (!/\.md$/i.test(input.path)) throw new AppError('NOTE_TYPE', '笔记文件名需要以 .md 结尾。');
      const target = await this.checkedPath(input.path, true);
      const fingerprint = hash(JSON.stringify([input.path, input.content, input.expectedVersion]));
      const previous = this.operations[input.operationId];
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new AppError('OPERATION_REUSED', '同一次操作不能用于不同的笔记内容。');
        const document = await this.read(input.path);
        if (document.version !== previous.version)
          throw new AppError('CONFLICT', '该操作已完成，但笔记随后发生了修改，请刷新。');
        return document;
      }
      let current: NoteDocument | null = null;
      try {
        current = await this.read(input.path);
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== 'NOT_FOUND') throw error;
      }
      if ((current?.version ?? null) !== input.expectedVersion)
        throw new AppError('CONFLICT', '笔记已在其他地方修改。请先刷新或另存一份，原文件未被覆盖。');
      const newline = (current?.content ?? input.content).includes('\r\n') ? '\r\n' : '\n';
      let content = input.content.replace(/\r?\n/g, newline);
      if (current?.content.startsWith('\uFEFF') && !content.startsWith('\uFEFF'))
        content = '\uFEFF' + content;
      const bytes = Buffer.from(content, 'utf8');
      if (bytes.length > MAX_NOTE_BYTES) throw new AppError('NOTE_SIZE', '笔记超过 2 MiB，未保存。');
      const staging = path.join(this.stateDir, 'staging');
      await fs.mkdir(staging, { recursive: true });
      const temporary = path.join(staging, randomUUID() + '.tmp');
      try {
        const handle = await fs.open(temporary, 'wx');
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await this.checkedPath(input.path);
        if (current) {
          const backupDir = path.join(this.stateDir, 'backups', this.id);
          await fs.mkdir(backupDir, { recursive: true });
          await fs
            .writeFile(path.join(backupDir, current.version + '.md'), current.content, {
              encoding: 'utf8',
              flag: 'wx',
            })
            .catch((error) => {
              if (error.code !== 'EEXIST') throw error;
            });
          if ((await this.read(input.path)).version !== current.version)
            throw new AppError('CONFLICT', '保存前检测到外部修改，原文件未被覆盖。');
          try {
            await fs.rename(temporary, target);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
            // Cross-volume replacement retains a D-drive backup but cannot be atomic.
            await fs.copyFile(temporary, target);
          }
        } else {
          // link is an atomic create-if-absent on the same filesystem.
          try {
            await fs.link(temporary, target);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
              await fs.copyFile(temporary, target, constants.COPYFILE_EXCL);
            } else if ((error as NodeJS.ErrnoException).code === 'EEXIST')
              throw new AppError('CONFLICT', '同名笔记已存在，未覆盖。');
            else throw error;
          }
        }
      } finally {
        await fs.unlink(temporary).catch(() => {});
      }
      const document = await this.read(input.path);
      this.treeCache = undefined;
      this.resourceCache = undefined;
      this.searchCache.delete(input.path.replaceAll('\\', '/'));
      this.operations[input.operationId] = { fingerprint, path: input.path, version: document.version };
      await atomicJson(this.operationsFile, this.operations);
      this.emit('changed');
      return document;
    });
  }
  async resolveNotePath(relative: string): Promise<string> {
    if(!/\.md$/i.test(relative))throw new AppError('NOTE_TYPE','请选择Markdown笔记。');
    const target=await this.checkedPath(relative),stat=await fs.stat(target);
    if(!stat.isFile()||stat.size>MAX_NOTE_BYTES)throw new AppError('NOTE_SIZE','笔记不存在或超过2MiB。');
    return target;
  }
  async resolveLink(base: string, target: string, wiki: boolean): Promise<NoteLink> {
    this.segments(base);
    const parsed = linkCandidates(base, target, wiki);
    for (const candidate of parsed.candidates) {
      try {
        const checked = await this.checkedPath(candidate);
        if ((await fs.stat(checked)).isFile()) return { path: candidate, anchor: parsed.anchor };
      } catch (error) {
        if (error instanceof AppError && error.code === 'PATH_DENIED') throw error;
        if (
          !(error instanceof AppError && error.code === 'NOT_FOUND') &&
          (error as NodeJS.ErrnoException).code !== 'ENOENT'
        )
          throw error;
      }
    }
    if (wiki) {
      const matches = (await this.resources()).filter(
        (file) =>
          file.toLowerCase() === parsed.suffix.toLowerCase() ||
          file.toLowerCase().endsWith('/' + parsed.suffix.toLowerCase()),
      );
      if (matches.length > 1)
        throw new AppError('LINK_AMBIGUOUS', '有多个同名文件，请在双链中补全目录：' + target);
      if (matches[0]) {
        await this.checkedPath(matches[0]);
        return { path: matches[0], anchor: parsed.anchor };
      }
    }
    throw new AppError('LINK_NOT_FOUND', '未找到知识库文件：' + target);
  }
  async imagePath(relative: string): Promise<string> {
    if (!/\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(relative))
      throw new AppError('IMAGE_TYPE', '此附件不是支持的图片格式。');
    const target = await this.checkedPath(relative);
    const stat = await fs.stat(target);
    if (!stat.isFile() || stat.size > 20 * 1024 * 1024)
      throw new AppError('IMAGE_SIZE', '图片不存在或超过20MiB。');
    return target;
  }
  async listImages(): Promise<string[]> {
    return (await this.resources()).filter((file) => !/\.md$/i.test(file));
  }
  async importImages(selected: string[]): Promise<ImportReport> {
    const report: ImportReport = { paths: [], errors: [] };
    for (const original of selected.slice(0, 16)) {
      try {
        const extension = path.extname(original).toLowerCase();
        if (!/^\.(png|jpe?g|gif|webp|svg|avif|bmp)$/.test(extension)) throw Error('请选择支持的图片文件。');
        const stat = await fs.stat(original);
        if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw Error('图片超过20MiB或不是普通文件。');
        const bytes = await fs.readFile(original);
        if (bytes.length > 20 * 1024 * 1024) throw Error('图片超过20MiB。');
        const relative = 'attachments/study-mate/' + hash(bytes).slice(0, 32) + extension;
        await this.writes.run(async () => {
          const target = await this.checkedPath(relative, true);
          try {
            await fs.writeFile(target, bytes, { flag: 'wx' });
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
          }
          this.resourceCache = undefined;
        });
        report.paths.push(relative);
      } catch (e) {
        report.errors.push(path.basename(original) + '：' + (e instanceof Error ? e.message : '导入失败'));
      }
    }
    return report;
  }
  async saveImage(bytes: Buffer): Promise<string> {
    if (
      bytes.length > 4 * 1024 * 1024 ||
      bytes.toString('ascii', 0, 4) !== 'RIFF' ||
      bytes.toString('ascii', 8, 12) !== 'WEBP'
    )
      throw new AppError('IMAGE_TYPE', '仅能导入本工具生成的 WebP 画面，大小不得超过 4MiB。');
    const relative = 'attachments/study-mate/' + hash(bytes).slice(0, 32) + '.webp';
    return this.writes.run(async () => {
      const target = await this.checkedPath(relative, true);
      try {
        await fs.writeFile(target, bytes, { flag: 'wx' });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
      this.resourceCache = undefined;
      return relative;
    });
  }
  private resources(): Promise<string[]> {
    if (this.resourceCache && this.resourceCache.expires > Date.now()) return this.resourceCache.files;
    const files: string[] = [];
    const walk = async (dir: string, relative: string, depth: number): Promise<void> => {
      if (depth > 16 || files.length >= 20000) return;
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (
          entry.isSymbolicLink() ||
          ignored.has(entry.name.toLowerCase()) ||
          entry.name.startsWith('.studymate-')
        )
          continue;
        const rel = relative ? relative + '/' + entry.name : entry.name;
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel, depth + 1);
        else if (entry.isFile() && /\.(md|png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(entry.name))
          files.push(rel);
      }
    };
    const pending = walk(this.root, '', 0).then(() => files);
    this.resourceCache = { expires: Date.now() + 10000, files: pending };
    return pending;
  }
  async importFiles(files: string[]): Promise<ImportReport> {
    const report: ImportReport = { paths: [], errors: [] };
    for (const selected of files.slice(0, 32)) {
      try {
        if (!/\.md$/i.test(selected)) throw new AppError('NOTE_TYPE', '请选择 .md 文件。');
        const original = await fs.realpath(selected);
        const document = await this.readAt(original, path.basename(original));
        const relative = path.relative(this.root, original);
        if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
          await this.read(relative);
          report.paths.push(relative.replaceAll('\\', '/'));
          continue;
        }
        const stem = path.basename(selected).replace(/\.md$/i, '');
        for (let suffix = 1; suffix <= 1000; suffix++) {
          const name = stem + (suffix === 1 ? '' : ' (' + suffix + ')') + '.md';
          try {
            await this.write({
              path: name,
              content: document.content,
              expectedVersion: null,
              operationId: randomUUID(),
            });
            report.paths.push(name);
            break;
          } catch (error) {
            if (error instanceof AppError && error.code === 'CONFLICT' && suffix < 1000) continue;
            throw error;
          }
        }
      } catch (error) {
        report.errors.push(
          path.basename(selected) + '：' + (error instanceof Error ? error.message : String(error)),
        );
      }
    }
    return report;
  }
  async list(): Promise<NoteFile[]> {
    if (!this.treeCache)
      this.treeCache = this.scanTree().catch((error) => {
        this.treeCache = undefined;
        throw error;
      });
    return this.treeCache;
  }
  private async scanTree(): Promise<NoteFile[]> {
    let count = 0;
    const walk = async (directory: string, relative: string, depth: number): Promise<NoteFile[]> => {
      if (depth > 16 || count > 5000) return [];
      const entries = await fs.readdir(directory, { withFileTypes: true });
      const result: NoteFile[] = [];
      for (const entry of entries.sort(
        (a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, 'zh-CN'),
      )) {
        if (
          entry.isSymbolicLink() ||
          ignored.has(entry.name.toLowerCase()) ||
          entry.name.startsWith('.studymate-')
        )
          continue;
        const rel = relative ? relative + '/' + entry.name : entry.name;
        if (entry.isDirectory()) {
          const children = await walk(path.join(directory, entry.name), rel, depth + 1);
          if (children.length)
            result.push({
              id: rel,
              name: entry.name,
              path: rel,
              children,
            });
        } else if (entry.isFile() && /\.md$/i.test(entry.name) && ++count <= 5000)
          result.push({ id: rel, name: entry.name, path: rel });
      }
      return result;
    };
    return walk(this.root, '', 0);
  }
  async search(query: string): Promise<SearchHit[]> {
    const needle = query.trim().toLowerCase().slice(0, 200);
    if (!needle) return [];
    const flatten = (nodes: NoteFile[]): NoteFile[] =>
      nodes.flatMap((n) => (n.children ? flatten(n.children) : [n]));
    const allNotes = flatten(await this.list());
    const named = allNotes.filter((note) => note.name.toLowerCase().includes(needle));
    if (named.length)
      return named.slice(0, 30).map((note) => ({ path: note.path, name: note.name, snippet: note.path }));
    const notes = allNotes.slice(0, 500);
    const entries: Array<SearchHit & { text: string }> = [];
    for (let offset = 0; offset < notes.length; offset += 12) {
      const batch = await Promise.all(
        notes.slice(offset, offset + 12).map(async (note) => {
          try {
            let pending = this.searchCache.get(note.path);
            if (!pending) {
              pending = (async () => {
                const handle = await fs.open(await this.checkedPath(note.path), 'r');
                try {
                  const buffer = Buffer.alloc(64_000);
                  const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
                  return {
                    path: note.path,
                    name: note.name,
                    text: buffer.subarray(0, bytesRead).toString('utf8'),
                    snippet: '',
                  };
                } finally {
                  await handle.close();
                }
              })();
              this.searchCache.set(note.path, pending);
            }
            return await pending;
          } catch {
            this.searchCache.delete(note.path);
            return null;
          }
        }),
      );
      entries.push(...batch.filter((item): item is SearchHit & { text: string } => Boolean(item)));
    }
    const exact = entries.filter((e) => (e.name + '\n' + e.text).toLowerCase().includes(needle));
    const fuzzy = new Fuse(
      allNotes.map((note) => ({ path: note.path, name: note.name, text: '', snippet: '' })),
      { keys: ['name'], threshold: 0.35, ignoreLocation: true },
    )
      .search(needle)
      .map((r) => r.item);
    return [...new Map([...exact, ...fuzzy].map((e) => [e.path, e])).values()].slice(0, 30).map((e) => {
      const offset = Math.max(0, e.text.toLowerCase().indexOf(needle) - 40);
      return { path: e.path, name: e.name, snippet: e.text.slice(offset, offset + 160).replace(/\s+/g, ' ') };
    });
  }
  watch(): Promise<void> {
    this.watcher = chokidar.watch(this.root, {
      ignoreInitial: true,
      followSymlinks: false,
      depth: 16,
      ignored: (target: string, stat) =>
        Boolean(stat?.isFile() && !/\.md$/i.test(target)) ||
        path
          .relative(this.root, target)
          .split(path.sep)
          .some((p) => ignored.has(p.toLowerCase()) || p.startsWith('.studymate-')),
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    });
    this.watcher.on('all', (_event, target: string) => {
      this.treeCache = undefined;
      this.resourceCache = undefined;
      this.searchCache.delete(path.relative(this.root, target).replaceAll('\\', '/'));
      clearTimeout(this.refreshTimer);
      this.refreshTimer = setTimeout(() => this.emit('changed'), 120);
    });
    this.watcher.on('error', (error) => this.emit('watch-error', error));
    return new Promise((resolve, reject) => {
      this.watcher!.once('ready', resolve);
      this.watcher!.once('error', reject);
    });
  }
  async close(): Promise<void> {
    clearTimeout(this.refreshTimer);
    await this.watcher?.close();
    await this.writes.flush();
  }
}
