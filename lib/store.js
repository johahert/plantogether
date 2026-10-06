// Tiny persistence layer: one JSON file per plan, cached in memory,
// written atomically (tmp file + rename) shortly after each change.
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export const newId = (bytes = 9) => randomBytes(bytes).toString('base64url');

export class Store {
  constructor(dir, migrate = (list) => list) {
    this.dir = dir;
    this.migrate = migrate;
    this.cache = new Map(); // id -> Promise<list | null>
    this.timers = new Map();
    this.ready = mkdir(dir, { recursive: true });
  }

  file(id) {
    return path.join(this.dir, `${id}.json`);
  }

  get(id) {
    if (!ID_RE.test(id)) return Promise.resolve(null);
    if (!this.cache.has(id)) {
      const loading = this.ready
        .then(() => readFile(this.file(id), 'utf8'))
        .then(JSON.parse)
        .then((list) => this.migrate(list))
        .catch((err) => {
          this.cache.delete(id);
          if (err.code === 'ENOENT') return null;
          throw err;
        });
      this.cache.set(id, loading);
    }
    return this.cache.get(id);
  }

  async create({ title, currency, tags = [] }) {
    const now = new Date().toISOString();
    const list = {
      id: newId(),
      editKey: newId(18),
      title,
      currency,
      createdAt: now,
      updatedAt: now,
      version: 1,
      tags,
      items: [],
    };
    this.cache.set(list.id, Promise.resolve(list));
    await this.write(list);
    return list;
  }

  // Call after mutating a list in place.
  touch(list) {
    list.version += 1;
    list.updatedAt = new Date().toISOString();
    clearTimeout(this.timers.get(list.id));
    this.timers.set(
      list.id,
      setTimeout(() => {
        this.timers.delete(list.id);
        this.write(list).catch((err) => console.error('Failed to save', list.id, err));
      }, 150),
    );
  }

  async write(list) {
    await this.ready;
    const tmp = `${this.file(list.id)}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(list, null, 1));
    await rename(tmp, this.file(list.id));
  }

  // Binary attachments (like a floor plan image) live next to the plan's JSON.
  blobFile(id, name) {
    if (!ID_RE.test(id) || !/^[a-z0-9-]+$/.test(name)) throw new Error('Bad blob name');
    return path.join(this.dir, `${id}.${name}`);
  }

  async writeBlob(id, name, data) {
    await this.ready;
    const file = this.blobFile(id, name);
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, file);
  }

  async readBlob(id, name) {
    try {
      return await readFile(this.blobFile(id, name));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  deleteBlob(id, name) {
    return rm(this.blobFile(id, name), { force: true });
  }

  async flush() {
    const pending = [...this.timers.keys()];
    for (const id of pending) {
      clearTimeout(this.timers.get(id));
      this.timers.delete(id);
      const list = await this.get(id);
      if (list) await this.write(list);
    }
  }
}
