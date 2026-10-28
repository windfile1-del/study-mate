import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as CFB from 'cfb';
import { workspace } from './helpers';
import {
  DocumentRegistry,
  extractLegacyPpt,
  inspectPresentationZip,
} from '../apps/desktop/src/core/document-registry';
import {
  documentContextSchema,
  parseDocumentCitation,
  documentCitation,
} from '../apps/desktop/src/shared/documents';
import { StudyTools, STUDY_TOOLS } from '../apps/desktop/src/core/study-tools';
import { VaultService } from '../apps/desktop/src/core/vault';
function record(type: number, bytes: Buffer, header = 0) {
  const h = Buffer.alloc(8);
  h.writeUInt16LE(header);
  h.writeUInt16LE(type, 2);
  h.writeUInt32LE(bytes.length, 4);
  return Buffer.concat([h, bytes]);
}
test('Document snapshots retain original bytes and stable page citations across restarts/revisions', async (t) => {
  const root = await workspace(t),
    registry = new DocumentRegistry(path.join(root, 'docs'));
  await registry.initialize();
  const file = path.join(root, '课程.pdf'),
    original = Buffer.from('%PDF-1.7\nfixture');
  await fs.writeFile(file, original);
  const one = await registry.register(file);
  assert.equal((await registry.register(file)).id, one.id);
  await fs.writeFile(file, Buffer.from('%PDF-1.7\nchanged'));
  const two = await registry.register(file);
  assert.notEqual(one.id, two.id);
  assert.deepEqual(await fs.readFile(registry.file(one.id)), original);
  await registry.update(one.id, { pages: 3, lastPage: 2 });
  await registry.close();
  const restored = new DocumentRegistry(path.join(root, 'docs'));
  await restored.initialize();
  assert.equal(restored.get(one.id).lastPage, 2);
  assert.deepEqual(parseDocumentCitation(documentCitation(one.id, 2)), { id: one.id, page: 2 });
  assert.equal(parseDocumentCitation('study-cite://' + one.id + '/2?file=C:/secret'), null);
  assert.throws(() => registry.file('../secret'));
  assert.equal(
    documentContextSchema.safeParse({
      id: one.id,
      revision: one.revision,
      page: 1,
      selection: { text: '', region: { x: 0.9, y: 0, width: 0.4, height: 1 } },
    }).success,
    false,
  );
});
test('Legacy PPT extracts Unicode text from real compound binary records; unsupported/encrypted files fail clearly', () => {
  const binary = CFB.utils.cfb_new();
  CFB.utils.cfb_add(
    binary,
    'PowerPoint Document',
    record(
      4080,
      Buffer.concat([
        record(1011, Buffer.alloc(16)),
        record(4000, Buffer.from('第一张\r数学课程', 'utf16le')),
        record(1011, Buffer.alloc(16)),
        record(4000, Buffer.from('第二张', 'utf16le')),
      ]),
      15,
    ),
  );
  const bytes = Buffer.from(CFB.write(binary, { type: 'buffer' }));
  assert.deepEqual(extractLegacyPpt(bytes), ['第一张\n数学课程', '第二张']);
  assert.throws(() => extractLegacyPpt(Buffer.from('bad')));
  assert.throws(() => inspectPresentationZip(Buffer.from('bad')));
  const zip = Buffer.alloc(68);
  zip.writeUInt32LE(0x02014b50);
  zip.writeUInt32LE(200 * 1024 * 1024, 24);
  zip.writeUInt32LE(0x06054b50, 46);
  zip.writeUInt16LE(1, 56);
  assert.throws(() => inspectPresentationZip(zip), /预算/);
});
test('Document tools scope imported IDs, freeze current page, bound text, expose pixels only on demand', async (t) => {
  const root = await workspace(t),
    vault = await VaultService.open(path.join(root, 'vault'), path.join(root, 'state'));
  t.after(() => vault.close());
  const id = 'doc-' + 'a'.repeat(24),
    calls: unknown[] = [];
  const doc = {
    id,
    revision: 'b'.repeat(64),
    title: '课件.pptx',
    kind: 'pptx' as const,
    pages: 20,
    outline: [],
    locked: false,
    warning: '',
    lastPage: 1,
    size: 200,
    createdAt: '',
  };
  const tools = new StudyTools({
    vaultId: vault.id,
    requestId: 'docs',
    allowWrite: false,
    dirtyPaths: [],
    currentVault: () => vault,
    context: async () => null,
    analyze: async () => {
      throw Error('unused');
    },
    allowedDocuments: [doc],
    selectedDocument: { id, revision: doc.revision, page: 3 },
    documents: {
      page: async (...args: any[]) => {
        calls.push(args);
        return {
          document: doc,
          page: {
            number: args[1],
            text: 'A'.repeat(20000),
            notes: 'speaker',
            blocks: [],
            width: 100,
            height: 60,
            gaps: [],
            citation: documentCitation(id, args[1]),
            image: args[2] ? 'data:image/webp;base64,aW1hZ2U=' : undefined,
          },
        };
      },
      search: async () => ({ document: doc, hits: [] }),
    },
  });
  const execute = (name: string, args: unknown) =>
    tools.execute(
      { id: String(calls.length) + name, name, arguments: JSON.stringify(args) },
      new AbortController().signal,
    );
  const read = await execute('read_document_page', { document_id: null, page: null });
  assert.equal(JSON.parse(read.text).page, 3);
  assert.equal(JSON.parse(read.text).text.length, 16000);
  assert.equal(read.images?.length || 0, 0);
  const view = await execute('view_document_page', {
    document_id: null,
    page: 4,
    region: { x: 0, y: 0, width: 0.5, height: 0.5 },
  });
  assert.equal(view.images?.[0].mime, 'image/webp');
  assert.match(JSON.parse(view.text).images[0].image, /^frame:doc-/);
  await assert.rejects(execute('read_document_page', { document_id: 'other', page: 1 }), /授权列表/);
  assert.equal(STUDY_TOOLS.length, 28);
});
