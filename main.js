'use strict';

const { Plugin, TFile, Notice } = require('obsidian');

// Vorlage für den eingefügten Text. {{file}} wird durch den Dateinamen/Pfad ersetzt.
const TEMPLATE = '```slide-note\nfile: {{file}}\n```\n';

module.exports = class PdfSlideDropPlugin extends Plugin {
  async onload() {
    this.registerEvent(
      this.app.workspace.on('editor-drop', (evt, editor, info) => {
        this.handleDrop(evt, editor, info);
      })
    );
  }

  handleDrop(evt, editor, info) {
    const sourcePath = (info && info.file && info.file.path) || '';

    // 1) Dateien aus dem Obsidian-Datei-Explorer (bereits im Vault)
    const draggable = this.app.dragManager && this.app.dragManager.draggable;
    if (draggable) {
      let files = [];
      if (draggable.type === 'file' && draggable.file) files = [draggable.file];
      else if (draggable.type === 'files' && Array.isArray(draggable.files)) files = draggable.files;

      const pdfs = files.filter(f => f instanceof TFile && f.extension.toLowerCase() === 'pdf');
      // Nur eingreifen, wenn ausschließlich PDFs gezogen werden
      if (pdfs.length > 0 && pdfs.length === files.length) {
        evt.preventDefault();
        const text = pdfs.map(f => this.buildBlock(f, sourcePath)).join('\n');
        this.insertAtDrop(evt, editor, text);
        return;
      }
    }

    // 2) Dateien von außerhalb (Finder/Explorer) -> erst im Vault speichern
    const dropped = evt.dataTransfer && evt.dataTransfer.files;
    if (dropped && dropped.length > 0) {
      const all = Array.from(dropped);
      const allPdf = all.every(f => f.name.toLowerCase().endsWith('.pdf'));
      if (!allPdf) return; // gemischte Drops: Obsidian macht das Standardverhalten

      evt.preventDefault();
      const x = evt.clientX, y = evt.clientY;
      this.saveExternalPdfs(all, sourcePath)
        .then(savedFiles => {
          const text = savedFiles.map(f => this.buildBlock(f, sourcePath)).join('\n');
          this.insertAtCoords(x, y, editor, text);
        })
        .catch(err => {
          console.error('PDF Slide Drop:', err);
          new Notice('PDF Slide Drop: Datei konnte nicht gespeichert werden.');
        });
    }
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
      const created = await this.app.vault.createBinary(path, buf);
      result.push(created);
    }
    return result;
  }

  insertAtDrop(evt, editor, text) {
    this.insertAtCoords(evt.clientX, evt.clientY, editor, text);
  }

  insertAtCoords(x, y, editor, text) {
    const cm = editor.cm; // CodeMirror-6-EditorView (nicht offiziell dokumentiert)
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
