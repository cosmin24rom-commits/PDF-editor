'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Window controls
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close:    () => ipcRenderer.send('window:close'),

  // App info
  getRoot: () => ipcRenderer.invoke('app:root'),

  // Dialogs
  openDialog:  (filters)      => ipcRenderer.invoke('dialog:open', filters),
  saveDialog:  (defaultName)  => ipcRenderer.invoke('dialog:save', defaultName),

  // File system
  readFile:  (fp)       => ipcRenderer.invoke('file:read', fp),
  writeFile: (fp, data) => ipcRenderer.invoke('file:write', fp, data),

  // Settings
  getSettings:  ()  => ipcRenderer.invoke('settings:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),

  // Recent files
  addRecent:    (fp) => ipcRenderer.invoke('recent:add', fp),
  removeRecent: (fp) => ipcRenderer.invoke('recent:remove', fp),

  // AI
  callClaude: (key, msgs, sys) => ipcRenderer.invoke('ai:claude', key, msgs, sys),
  callGemini: (key, msgs)      => ipcRenderer.invoke('ai:gemini', key, msgs),

  // PDF operations
  extractText: (buf) => ipcRenderer.invoke('pdf:extract-text', buf),
  fromText:    (txt, opts) => ipcRenderer.invoke('pdf:from-text', txt, opts),

  // Conversions
  convertDocx: (fp)   => ipcRenderer.invoke('convert:docx', fp),
  convertTxt:  (txt)  => ipcRenderer.invoke('convert:txt', txt),
  convertMd:   (txt)  => ipcRenderer.invoke('convert:md', txt),
  convertHtml: (html) => ipcRenderer.invoke('convert:html', html),

  // Windows integration
  registerWindows: ()  => ipcRenderer.invoke('register:windows'),
  setDefaultApp:   ()  => ipcRenderer.invoke('register:set-default'),
  onOpenFile: (cb)     => ipcRenderer.on('open-file', (_, fp) => cb(fp)),
});
