import { session } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import type { VaultService } from '../core/vault';

const mime: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
};
export class NoteAssets {
  private tokens = new Map<string, { vaultId: string; path: string }>();
  constructor(private readonly vault: () => VaultService) {}
  initialize(): void {
    session.defaultSession.protocol.handle('study-note', async (request) => {
      try {
        const entry = this.tokens.get(new URL(request.url).pathname.slice(1));
        const vault = this.vault();
        if (!entry || entry.vaultId !== vault.id) return new Response(null, { status: 404 });
        if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
        const file = await vault.imagePath(entry.path),
          stat = await fs.stat(file);
        return new Response(
          request.method === 'HEAD' ? null : (Readable.toWeb(createReadStream(file)) as ReadableStream),
          {
            headers: {
              'Content-Type': mime[path.extname(file).toLowerCase()]!,
              'Content-Length': String(stat.size),
              'Cache-Control': 'no-cache',
              'X-Content-Type-Options': 'nosniff',
              'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
            },
          },
        );
      } catch {
        return new Response(null, { status: 404 });
      }
    });
  }
  async image(base: string, target: string, wiki: boolean): Promise<string> {
    const vault = this.vault();
    const resolved = await vault.resolveLink(base, target, wiki);
    await vault.imagePath(resolved.path);
    const token = randomUUID();
    if (this.tokens.size >= 10000) this.tokens.delete(this.tokens.keys().next().value!);
    this.tokens.set(token, { vaultId: vault.id, path: resolved.path });
    return 'study-note://image/' + token;
  }
}
