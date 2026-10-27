import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export class SessionStore {
  constructor(dataDir = process.env.BILIBILI_OBSERVER_DATA_DIR || path.join(os.tmpdir(), "codex-bilibili-video-observer")) {
    this.dataDir = dataDir;
  }

  fileFor(id) {
    const safe = String(id || "session").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
    return path.join(this.dataDir, `${safe}.json`);
  }

  async load(id) {
    try {
      const value = JSON.parse(await fs.readFile(this.fileFor(id), "utf8"));
      return value && typeof value === "object" ? value : null;
    } catch {
      return null;
    }
  }

  async save(session) {
    await fs.mkdir(this.dataDir, { recursive: true });
    const target = this.fileFor(session.id);
    const temp = `${target}.tmp`;
    await fs.writeFile(temp, JSON.stringify(session, null, 2), "utf8");
    await fs.rename(temp, target);
    return target;
  }

  async remove(id) {
    await fs.rm(this.fileFor(id), { force: true });
  }

  async list() {
    try {
      const names = await fs.readdir(this.dataDir);
      const sessions = [];
      for (const name of names.filter(name => name.endsWith(".json"))) {
        try {
          sessions.push(JSON.parse(await fs.readFile(path.join(this.dataDir, name), "utf8")));
        } catch {
          // Ignore a concurrently replaced or corrupt stale file.
        }
      }
      return sessions;
    } catch {
      return [];
    }
  }
}
