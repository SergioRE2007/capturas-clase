'use strict';
// Carpeta en memoria con la forma de FileSystemDirectoryHandle (solo lo que usa core.js). Solo para tests.
function notFound() { const e = new Error('no existe'); e.name = 'NotFoundError'; return e; }

class FakeFile {
  constructor() { this.data = null; this.failWrite = false; }
}
class FakeDir {
  constructor(name = 'root') { this.name = name; this.files = new Map(); this.dirs = new Map(); this.failNextWrite = false; }
  async getDirectoryHandle(name, { create } = {}) {
    if (!this.dirs.has(name)) { if (!create) throw notFound(); this.dirs.set(name, new FakeDir(name)); }
    return this.dirs.get(name);
  }
  async getFileHandle(name, { create } = {}) {
    if (!this.files.has(name)) { if (!create) throw notFound(); this.files.set(name, new FakeFile()); }
    const f = this.files.get(name), dir = this;
    return {
      name,
      async getFile() { return { size: f.data ? f.data.length : 0, async text() { return f.data ? Buffer.from(f.data).toString('utf8') : ''; } }; },
      async createWritable() {
        const fail = dir.failNextWrite; dir.failNextWrite = false;
        let buf = [];
        return {
          async write(b) {
            if (fail) throw Object.assign(new Error('disco'), { name: 'QuotaExceededError' });
            await new Promise((r) => setTimeout(r, 1));
            buf.push(typeof b === 'string' ? Buffer.from(b) : Buffer.from(b.arrayBuffer ? new Uint8Array(await b.arrayBuffer()) : b));
          },
          async close() { f.data = Buffer.concat(buf); },
          async abort() { buf = []; }
        };
      }
    };
  }
  async removeEntry(name) { if (!this.files.delete(name) && !this.dirs.delete(name)) throw notFound(); }
  async *keys() { yield* [...this.files.keys(), ...this.dirs.keys()]; }
}
module.exports = { FakeDir };
