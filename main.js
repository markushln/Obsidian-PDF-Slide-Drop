'use strict';

const { Plugin, TFile, Notice } = require('obsidian');

// Vorlage für den eingefügten Text. {{file}} wird durch den Link-Namen ersetzt.
const TEMPLATE = '```slide-note\nfile: {{file}}\n```\n';

// Debug-Ausgaben in der Entwicklerkonsole (Strg/Cmd+Shift+I)
const DEBUG = true;
const log = (...a) => { if (DEBUG) console.log('[PDF Slide Drop]', ...a); };

module.exports = class PdfSlideDropPlugin extends Plugin {
  async onload() {
    log('geladen (v4)');

    // Auf dem Hauptfenster und auf allen Popout-Fenstern lauschen
    this.attachToWindow(window);
    this.registerEvent(
      this.app.workspace.on('window-open', (_win, w) => this.attachToWindow(w))
    );

    // Zusätzlich Obsidians eigenes Editor-Event (nur zur Diagnose + als zweiter Weg)
    this.registerEvent(
      this.app.workspace.on('editor-drop', (evt, editor, info) => {
        log('editor-drop Event', { defaultPrevented: evt.defaultPrevented });
        if (evt.defaultPrevented) return;
        this.handle(evt, editor, info && info.file ? info.file.path : '');
      })
    );
  }

  attachToWindow(w) {
    log('lausche auf Fenster');
    this.registerDomEvent(w, 'dragstart', (e) => {
      const dt = e.dataTransfer;
      log('dragstart', {
        target: e.target && e.target.className,
        types: dt ? Array.from(dt.types) : null,
        text: dt ? dt.getData('text/plain') : null
      });
    }, true);

    this.registerDomEvent(w, 'drop', (evt) => {
      const dt = evt.dataTransfer;
      log('drop (window, capture)', {
        target: evt.target && (evt.target.className || evt.target.tagName),
        inEditor: !!(evt.target instanceof Element && evt.target.closest('.cm-editor')),
        types: dt ? Array.from(dt.types) : null,
        files: dt ? dt.files.length : null,
        text: dt ? dt.getData('text/plain') : null
      });

      if (!(evt.target instanceof Element) || !evt.target.closest('.cm-editor')) return;
      const found = this.findEditorFor(evt.target);
      if (!found) { log('kein Editor für das Drop-Ziel gefunden'); return; }
      log('Editor gefunden für', found.sourcePath);
      this.handle(evt, found.editor, found.sourcePath);
    }, true);
  }

  // Sucht die Notiz (Markdown-View), in der das Drop-Ziel liegt
  findEditorFor(target) {
    let found = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (found) return;
      const view = leaf.view;
      if (!view || view.getViewType() !== 'markdown' || !view.editor) return;
      if (view.containerEl && view.containerEl.contains(target)) {
        found = { editor: view.editor, sourcePath: (view.file && view.file.path) || '' };
      }
    });
    if (found) return found;

    // Fallbacks
    const ae = this.app.workspace.activeEditor;
    if (ae && ae.editor) return { editor: ae.editor, sourcePath: (ae.file && ae.file.path) || '' };
    const view = this.app.workspace.getActiveViewOfType(require('obsidian').MarkdownView);
    if (view && view.editor) return { editor: view.editor, sourcePath: (view.file && view.file.path) || '' };
    return null;
  }

  handle(evt, editor, sourcePath) {
    if (evt.__pdfSlideHandled) return;
    const dt = evt.dataTransfer;
    if (!dt) return;

    // 1) Interner Drag aus dem Datei-Explorer
    const internal = this.resolveInternalFiles(dt, sourcePath);
    log('interne Dateien erkannt:', internal.map(f => f.path));
    if (internal.length > 0) {
      if (!internal.every(f => f.extension.toLowerCase() === 'pdf')) return;
      this.takeOver(evt);
      const text = internal.map(f => this.buildBlock(f, sourcePath)).join('\n');
      this.insertAtCoords(evt.clientX, evt.clientY, editor, text);
      return;
    }

    // 2) Externer Drag (Finder/Explorer)
    if (dt.files && dt.files.length > 0) {
      const files = Array.from(dt.files);
      if (!files.every(f => f.name.toLowerCase().endsWith('.pdf'))) return;
      this.takeOver(evt);
      const x = evt.clientX, y = evt.clientY;
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
    evt.__pdfSlideHandled = true;
    evt.preventDefault();
    evt.stopPropagation();
    evt.stopImmediatePropagation();
    log('Drop übernommen');
  }

  resolveInternalFiles(dt, sourcePath) {
    const raw = dt.getData('text/plain');
    if (!raw) return [];
    const result = [];

    for (const line of raw.split(/\r?\n/)) {
      const entry = line.trim();
      if (!entry) continue;

      let path = null;
      if (entry.startsWith('obsidian://')) {
        try { path = new URL(entry).searchParams.get('file'); } catch (e) { /* ignorieren */ }
      } else if (entry.startsWith('![[') && entry.endsWith(']]')) {
        path = entry.slice(3, -2).split('|')[0];
      } else if (entry.startsWith('[[') && entry.endsWith(']]')) {
        path = entry.slice(2, -2).split('|')[0];
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
