import chokidar from 'chokidar';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { KnowledgeDb } from '../core/knowledge-db';
const db = new KnowledgeDb(workerData.root, workerData.vaultId, workerData.file);
let scanning: Promise<unknown> | null = null;
parentPort!.on('message', async ({ id, action, args }) => {
  try {
    let value: unknown;
    if (action === 'scan') {
      if (!scanning)
        scanning = db
          .scan((status) => parentPort!.postMessage({ status }))
          .finally(() => {
            scanning = null;
          });
      value = await scanning;
    } else if (action === 'update') {
      await db.update(args.path);
      value = db.counts();
      parentPort!.postMessage({ status: value });
    } else if (action === 'keyword') value = db.keyword(args.query, args.limit);
    else if (action === 'semantic') value = db.semantic(args.vector, args.limit);
    else if (action === 'pending') value = db.pending(args.limit);
    else if (action === 'vectors') value = db.vectors(args.rows);
    else if (action === 'backlinks') value = db.backlinks(args.path);
    else if (action === 'resolve') value = db.resolve(args.base, args.target, args.wiki);
    else if (action === 'issues') value = db.issues();
    else value = db.counts();
    parentPort!.postMessage({ id, value });
  } catch (e) {
    parentPort!.postMessage({ id, error: (e as Error).message });
  }
});

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const watcher = chokidar.watch(workerData.root, {
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 50 },
  followSymlinks: false,
  ignored: (target: string, stat: any) =>
    Boolean(stat?.isFile() && !/\.md$/i.test(target)) ||
    path
      .relative(workerData.root, target)
      .split(path.sep)
      .some(
        (p) =>
          ['.git', '.obsidian', '.studymate', 'node_modules'].includes(p.toLowerCase()) ||
          p.startsWith('.studymate-'),
      ),
});
watcher.on('all', (event, target) => {
  const relative = path.relative(workerData.root, target).replaceAll('\\', '/');
  clearTimeout(timers.get(relative));
  timers.set(
    relative,
    setTimeout(() => {
      timers.delete(relative);
      void (
        event === 'unlinkDir'
          ? db.scan((status) => parentPort!.postMessage({ status }))
          : db.update(relative).then(() => parentPort!.postMessage({ status: db.counts() }))
      ).catch((e) => parentPort!.postMessage({ watchError: (e as Error).message }));
    }, 250),
  );
});
watcher.on('error', (e) => parentPort!.postMessage({ watchError: (e as Error).message }));
