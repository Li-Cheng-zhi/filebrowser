// One serial save queue per file page. A reply can only acknowledge the bytes
// captured for that request; typing while a save is in flight remains dirty.
export class TextSave {
  constructor(read, write, changed = () => {}) {
    this.read = read; this.write = write; this.changed = changed;
    this.text = ''; this.baseText = ''; this.version = ''; this.state = 'loading';
    this.revision = 0; this.pending = null; this.conflict = null;
  }
  load(file) { this.text = file.text; this.baseText = file.text; this.version = file.version; this.state = 'saved'; this.conflict = null; this.revision++; this.changed(); }
  edit(text) { this.text = text; this.revision++; if (!this.conflict) this.state = this.text === this.baseText ? 'saved' : 'dirty'; this.changed(); }
  get dirty() { return this.text !== this.baseText; }
  async save(expected = this.version) {
    if (this.pending) { await this.pending; if (this.dirty && !this.conflict) return this.save(); return; }
    if (!this.dirty && expected === this.version) return;
    const content = this.text; this.state = 'saving'; this.changed();
    this.pending = (async () => {
      try { const result = await this.write(content, expected); this.version = result.version; this.baseText = content; this.conflict = null; this.state = this.dirty ? 'dirty' : 'saved'; }
      catch (error) { this.conflict = error.status === 409 ? error.data : null; this.state = this.conflict ? 'conflict' : 'failed'; throw error; }
      finally { this.pending = null; this.changed(); }
    })();
    return this.pending;
  }
  async reload() { if (this.pending) await this.pending; this.load(await this.read()); }
}

export function restoreText(value, original) {
  // Monaco strips a UTF-8 BOM from a model. Preserve the original byte contract.
  return original.startsWith('\ufeff') && !value.startsWith('\ufeff') ? '\ufeff' + value : value;
}
