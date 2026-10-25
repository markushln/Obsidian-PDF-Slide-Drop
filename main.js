'use strict';

const { Plugin, TFile, Notice, MarkdownView } = require('obsidian');

// Vorlage für den eingefügten Text. {{file}} wird durch den Link-Namen ersetzt.
const TEMPLATE = '```slide-note\nfile: {{file}}\n```\n';

// Debug-Ausgaben in der Entwicklerkonsole (Strg/Cmd+Shift+I). Bei Bedarf auf false setzen.
const DEBUG = true;
const log = (...a) => { if (DEBUG) console.log('[PDF Slide Drop]', ...a); };

module.exports = class PdfSlideDropPlugin extends Plugin {
  async onload() {
    log('geladen');
    // Capture-Phase auf document: läuft vor Obsidians/CodeMirrors eigenem Drop-Handler
    this.registerDomEvent(document, 'drop', (evt) => this.onDrop(evt), true);
  }

  onDrop(evt) {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || !view.editor) return;

    // Nur Drops in den Editor-Bereich der aktiven Notiz
    const target = evt.target;
    if (!(target instanceof Element) || !target.closest('.cm-editor')) return;
    if (!view.containerEl.contains(target)) return;

    const dt = evt.dataTransfer;
    if (!dt) return;

    const sourcePath = (view.file && view.file.path) || '';
    log('drop', { types: Array.from(dt.types), files: dt.files.length, text: dt.getData('text/plain') });

    // 1) Interner Drag aus dem Datei-Explorer
    const internal = this.resolveInternalFiles(dt, sourcePath);
    if (internal.length > 0) {
      const allPdf = internal.every(f => f.extension.toLowerCase() === 'pdf');
      if (!allPdf) return; // Standardverhalten für alles andere
      this.takeOver(evt);
      const text = internal.map(f => this.buildBlock(f, sourcePath)).join('\n');
      this.insertAtCoords(evt.clientX, evt.clientY, view.editor, text);
      return;
    }

    // 2) Externer Drag (Finder/Explorer)
    if (dt.files && dt.files.length > 0) {
      const files = Array.from(dt.files);
      if (!files.every(f => f.name.toLowerCase().endsWith('.pdf'))) return;
      this.takeOver(evt);
      const x = evt.clientX, y = evt.clientY, editor = view.editor;
      this.saveExternalPdfs(files, sourcePath)
        .then(saved => {
          const text = saved.map(f => this.buildBlock(f, sourcePath)).join('\n');
          this.insertAtCoords(x, y, editor, text);
        })
        .catch(err => {
          console.error('[PDF Slide Drop]', err);
          new Notice('PDF Slide Drop: Datei konnte nicht gespeichert werden.');
        });
    }
  }

  takeOver(evt) {
    evt.preventDefault();
    evt.stopPropagation();
    evt.stopImmediatePropagation();
  }

  // Liest die gezogenen Vault-Dateien aus dataTransfer (text/plain enthält obsidian://-Links)
  resolveInternalFiles(dt, sourcePath) {
    const raw = dt.getData('text/plain');
    if (!raw) return [];
    const result = [];

    for (const line of raw.split(/\r?\n/)) {
      const entry = line.trim();
      if (!entry) continue;

      let path = null;
      if (entry.startsWith('obsidian://')) {
        try {
          path = new URL(entry).searchParams.get('file');
        } catch (e) { /* ignorieren */ }
      } else if (entry.startsWith('[[') && entry.endsWith(']]')) {
        path = entry.slice(2, -2).split('|')[0];
      } else if (entry.startsWith('![[') && entry.endsWith(']]')) {
        path = entry.slice(3, -2).split('|')[0];
      } else {
        path = entry;
      }
      if (!path) continue;

      let file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) {
        file = this.app.metadataCache.getFirstLinkpathDest(path, sourcePath);
      }
      if (file instanceof TFile) result.push(file);
    }
    return result;
  }

  buildBlock(file, sourcePath) {
    const link = this.app.metadataCache.fileToLinktext(file, sourcePath);
    return TEMPLATE.replace('{{file}}', link);
  }

  async saveExternalPdfs(files, sourcePath) {
    const result = [];
    for (const f of files) {
      const buf = await f.arrayBuffer();
      const path = await this.app.fileManager.getAvailablePathForAttachment(f.name, sourcePath);
      result.push(await this.app.vault.createBinary(path, buf));
    }
    return result;
  }

  insertAtCoords(x, y, editor, text) {
    const cm = editor.cm;
    let offset = null;
    if (cm && typeof cm.posAtCoords === 'function') {
      offset = cm.posAtCoords({ x, y });
    }
    if (offset != null) {
      editor.replaceRange(text, editor.offsetToPos(offset));
    } else {
      editor.replaceSelection(text);
    }
  }
};
