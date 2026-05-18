'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// PORTABILITATE — app.setPath TREBUIE să fie prima acțiune, înainte de orice
// ═══════════════════════════════════════════════════════════════════════════
const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, protocol, net } = require('electron');
const fs = require('fs');

const isDev   = !app.isPackaged;
const appRoot = isDev ? __dirname : (process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath('exe')));
app.setPath('userData', path.join(appRoot, 'data'));

// ─── Single Instance — dacă app e deja deschis, trimitem fișierul acolo ────
function findFileArg(argv) {
  return argv.slice(1).find(a => {
    if (!a || a === '.' || a.startsWith('-')) return false;
    try { return fs.existsSync(a) && fs.statSync(a).isFile(); } catch { return false; }
  }) || null;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }
else {
  app.on('second-instance', (_, argv) => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
      const fp = findFileArg(argv);
      if (fp) win.webContents.send('open-file', path.normalize(fp));
    }
  });
}

// ─── Directoare necesare ────────────────────────────────────────────────────
const dataDir = path.join(appRoot, 'data');
const docsDir = path.join(appRoot, 'documents');
const tempDir = path.join(appRoot, 'temp');
[dataDir, docsDir, tempDir].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

const settingsFile = path.join(dataDir, 'settings.json');
const defaultSettings = { claudeKey: '', geminiKey: '', theme: 'dark', language: 'ro', recentFiles: [] };

function readSettings() {
  try { return Object.assign({}, defaultSettings, JSON.parse(fs.readFileSync(settingsFile, 'utf8'))); }
  catch { return Object.assign({}, defaultSettings); }
}
function writeSettings(s) { fs.writeFileSync(settingsFile, JSON.stringify(s, null, 2), 'utf8'); }

// ─── Fereastră principală ───────────────────────────────────────────────────
let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 960, minHeight: 640,
    frame: false, backgroundColor: '#0d0d1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false
    }
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });
  win.webContents.on('context-menu', e => e.preventDefault());
}

app.whenReady().then(() => {
  // Protocol app:// → servește fișiere locale (pentru pdf.js worker)
  protocol.handle('app', (req) => {
    const rel = decodeURIComponent(req.url.replace('app://', '').split('?')[0]);
    const fp  = path.normalize(path.join(__dirname, rel)).replace(/\\/g, '/');
    return net.fetch('file:///' + fp);
  });
  createWindow();

  // Deschide fișier dacă a fost dat ca argument la pornire (dublu-click din Explorer)
  const fileArg = findFileArg(process.argv);
  if (fileArg) {
    win.webContents.once('did-finish-load', () => {
      win.webContents.send('open-file', path.normalize(fileArg));
    });
  }
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => {
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

// ─── Controale fereastră ────────────────────────────────────────────────────
ipcMain.on('window:minimize', () => win.minimize());
ipcMain.on('window:maximize', () => win.isMaximized() ? win.unmaximize() : win.maximize());
ipcMain.on('window:close',    () => win.close());

// ─── App info ───────────────────────────────────────────────────────────────
ipcMain.handle('app:root', () => __dirname);

// ─── Dialoguri fișiere ──────────────────────────────────────────────────────
ipcMain.handle('dialog:open', async (_, filters) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    filters: filters || [
      { name: 'Documente', extensions: ['pdf', 'docx', 'doc', 'txt', 'md', 'html', 'htm', 'rtf'] },
      { name: 'PDF',  extensions: ['pdf'] },
      { name: 'Word', extensions: ['docx', 'doc'] },
      { name: 'Text', extensions: ['txt', 'md'] },
      { name: 'HTML', extensions: ['html', 'htm'] }
    ],
    properties: ['openFile']
  });
  return canceled ? null : filePaths[0];
});

ipcMain.handle('dialog:save', async (_, defaultName) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: defaultName || 'document.pdf',
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  });
  return canceled ? null : filePath;
});

// ─── Sistem de fișiere ──────────────────────────────────────────────────────
ipcMain.handle('file:read', async (_, fp) => Array.from(fs.readFileSync(fp)));
ipcMain.handle('file:write', (_, fp, data) => { fs.writeFileSync(fp, Buffer.from(data)); return true; });

// ─── Setări ─────────────────────────────────────────────────────────────────
ipcMain.handle('settings:get',  ()     => readSettings());
ipcMain.handle('settings:save', (_, s) => { writeSettings(s); return true; });

// ─── Fișiere recente ─────────────────────────────────────────────────────────
ipcMain.handle('recent:add', (_, fp) => {
  const s = readSettings();
  s.recentFiles = [fp, ...(s.recentFiles || []).filter(f => f !== fp)].slice(0, 10);
  writeSettings(s); return s.recentFiles;
});
ipcMain.handle('recent:remove', (_, fp) => {
  const s = readSettings();
  s.recentFiles = (s.recentFiles || []).filter(f => f !== fp);
  writeSettings(s); return s.recentFiles;
});

// ─── AI — Claude ────────────────────────────────────────────────────────────
ipcMain.handle('ai:claude', async (_, apiKey, messages, system) => {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  const res = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    system: system || 'Ești un asistent AI expert în analiza și editarea documentelor. Răspunde întotdeauna în limba în care ți se scrie.',
    messages
  });
  return res.content[0].text;
});

// ─── AI — Gemini ────────────────────────────────────────────────────────────
ipcMain.handle('ai:gemini', async (_, apiKey, messages) => {
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction: 'Ești un asistent AI expert în analiza și editarea documentelor. Răspunde întotdeauna în limba în care ți se scrie.'
  });
  const history = messages.slice(0, -1).map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));
  const chat = model.startChat({ history });
  const result = await chat.sendMessage(messages[messages.length - 1].content);
  return result.response.text();
});

// ─── PDF: Extrage text ───────────────────────────────────────────────────────
ipcMain.handle('pdf:extract-text', async (_, bufArr) => {
  // Rulăm pdf.js în modul Node.js (fără worker)
  const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
  pdfjsLib.GlobalWorkerOptions.workerSrc = false;
  const data = new Uint8Array(Buffer.from(bufArr));
  const doc = await pdfjsLib.getDocument({ data, useWorkerFetch: false, isEvalSupported: false, disableFontFace: true }).promise;
  let text = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    text += `\n--- Pagina ${i} ---\n` + tc.items.map(it => it.str).join(' ');
  }
  return text.trim();
});

// ─── PDF: Crează din text ────────────────────────────────────────────────────
ipcMain.handle('pdf:from-text', async (_, text, opts = {}) => {
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  const doc  = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const size = opts.fontSize || 11;
  const margin = 60;
  const W = 595.28, H = 841.89;
  const lineH = size * 1.55;
  const maxW = W - margin * 2;
  const maxL = Math.floor((H - margin * 2) / lineH);

  const allLines = [];
  for (const para of text.split('\n')) {
    if (!para.trim()) { allLines.push(''); continue; }
    let line = '';
    for (const w of para.split(/\s+/)) {
      const test = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(test, size) > maxW && line) { allLines.push(line); line = w; }
      else line = test;
    }
    if (line) allLines.push(line);
  }

  for (let i = 0; i < Math.max(allLines.length, 1); i += maxL) {
    const page = doc.addPage([W, H]);
    allLines.slice(i, i + maxL).forEach((ln, j) => {
      if (!ln) return;
      page.drawText(ln, { x: margin, y: H - margin - j * lineH, size, font, color: rgb(0, 0, 0) });
    });
  }
  return Array.from(await doc.save());
});

// ─── Conversie HTML → PDF (via BrowserWindow ascuns) ────────────────────────
async function htmlToPdf(html) {
  const hw = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true } });
  const page = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body{font-family:Arial,sans-serif;margin:40px;line-height:1.6;font-size:11pt;color:#000}
    h1,h2,h3,h4{color:#111;margin-top:1em}pre,code{font-family:monospace;font-size:9.5pt;background:#f5f5f5;padding:2px 4px}
    table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:6px 8px}
    img{max-width:100%;height:auto}blockquote{border-left:3px solid #ccc;margin:0;padding-left:16px;color:#444}
  </style></head><body>${html}</body></html>`;
  await hw.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page));
  const pdf = await hw.webContents.printToPDF({
    pageSize: 'A4', printBackground: true,
    margins: { marginType: 'custom', top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 }
  });
  hw.close();
  return Array.from(pdf);
}

ipcMain.handle('convert:html', (_, html)  => htmlToPdf(html));
ipcMain.handle('convert:md',   async (_, txt) => {
  const { marked } = require('marked');
  return htmlToPdf(marked(txt));
});
ipcMain.handle('convert:txt', (_, txt) => {
  const esc = txt.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return htmlToPdf(`<pre style="white-space:pre-wrap">${esc}</pre>`);
});
ipcMain.handle('convert:docx', async (_, fp) => {
  const mammoth = require('mammoth');
  const { value } = await mammoth.convertToHtml({ path: fp });
  return htmlToPdf(value);
});

// ─── Înregistrare Windows (asociere fișiere / "Deschide cu") ────────────────
ipcMain.handle('register:windows', async () => {
  if (process.platform !== 'win32') return { ok: false, msg: 'Disponibil doar pe Windows' };
  const { spawnSync } = require('child_process');
  const progId  = 'PDFEditor';
  const exts    = ['.pdf', '.docx', '.doc', '.txt', '.md', '.html', '.htm', '.rtf'];
  // exeName trebuie sa fie EXACT numele fisierului exe - Windows cauta dupa el in "Deschide cu"
  const exeName = app.isPackaged ? path.basename(process.execPath) : 'electron.exe';

  // PS single-quoted strings: \ nu are nevoie de escape, doar ' se dubleaza cu ''
  let cmdValue, icoValue;
  if (app.isPackaged) {
    const exe = process.execPath.replace(/'/g, "''");
    cmdValue = `'"${exe}" "%1"'`;
    icoValue = `'${exe},0'`;
  } else {
    const electronExe = path.join(__dirname, 'node_modules', 'electron', 'dist', 'electron.exe');
    const appDir = __dirname;
    const e = electronExe.replace(/'/g, "''");
    const d = appDir.replace(/'/g, "''");
    cmdValue = `'"${e}" "${d}" "%1"'`;
    icoValue = `'${e},0'`;
  }

  const extBlock = exts.map(ext => `
    New-Item -Path 'HKCU:\\Software\\Classes\\${ext}\\OpenWithList\\${exeName}' -Force | Out-Null
    New-ItemProperty -Path 'HKCU:\\Software\\Classes\\${ext}\\OpenWithProgids' -Name '${progId}' -PropertyType Binary -Value ([byte[]]@()) -Force | Out-Null
    New-ItemProperty -Path 'HKCU:\\Software\\PDF Editor\\Capabilities\\FileAssociations' -Name '${ext}' -Value '${progId}' -Force | Out-Null
    New-ItemProperty -Path 'HKCU:\\Software\\Classes\\Applications\\${exeName}\\SupportedTypes' -Name '${ext}' -Value '' -Force | Out-Null`
  ).join('');

  const ps = `
$ErrorActionPreference = 'Stop'
$cmd = ${cmdValue}
$ico = ${icoValue}

# ProgID
New-Item -Path 'HKCU:\\Software\\Classes\\${progId}' -Force | Out-Null
Set-ItemProperty -Path 'HKCU:\\Software\\Classes\\${progId}' -Name '(Default)' -Value 'PDF Editor Document'
New-Item -Path 'HKCU:\\Software\\Classes\\${progId}\\DefaultIcon' -Force | Out-Null
Set-ItemProperty -Path 'HKCU:\\Software\\Classes\\${progId}\\DefaultIcon' -Name '(Default)' -Value $ico
New-Item -Path 'HKCU:\\Software\\Classes\\${progId}\\shell\\open\\command' -Force | Out-Null
Set-ItemProperty -Path 'HKCU:\\Software\\Classes\\${progId}\\shell\\open\\command' -Name '(Default)' -Value $cmd

# Application entry - cheia TREBUIE sa fie exact numele exe-ului (PDF-Editor.exe)
New-Item -Path 'HKCU:\\Software\\Classes\\Applications\\${exeName}' -Force | Out-Null
New-ItemProperty -Path 'HKCU:\\Software\\Classes\\Applications\\${exeName}' -Name 'FriendlyAppName' -Value 'PDF Editor' -Force | Out-Null
New-ItemProperty -Path 'HKCU:\\Software\\Classes\\Applications\\${exeName}' -Name 'ApplicationDescription' -Value 'Editor PDF portabil cu AI' -Force | Out-Null
Set-ItemProperty -Path 'HKCU:\\Software\\Classes\\Applications\\${exeName}' -Name '(Default)' -Value 'PDF Editor'
New-Item -Path 'HKCU:\\Software\\Classes\\Applications\\${exeName}\\DefaultIcon' -Force | Out-Null
Set-ItemProperty -Path 'HKCU:\\Software\\Classes\\Applications\\${exeName}\\DefaultIcon' -Name '(Default)' -Value $ico
New-Item -Path 'HKCU:\\Software\\Classes\\Applications\\${exeName}\\shell\\open\\command' -Force | Out-Null
Set-ItemProperty -Path 'HKCU:\\Software\\Classes\\Applications\\${exeName}\\shell\\open\\command' -Name '(Default)' -Value $cmd
New-Item -Path 'HKCU:\\Software\\Classes\\Applications\\${exeName}\\SupportedTypes' -Force | Out-Null

# Capabilities (necesar pt Default Programs)
New-Item -Path 'HKCU:\\Software\\PDF Editor\\Capabilities' -Force | Out-Null
New-ItemProperty -Path 'HKCU:\\Software\\PDF Editor\\Capabilities' -Name 'ApplicationName' -Value 'PDF Editor' -Force | Out-Null
New-ItemProperty -Path 'HKCU:\\Software\\PDF Editor\\Capabilities' -Name 'ApplicationDescription' -Value 'PDF Editor portabil cu AI' -Force | Out-Null
New-Item -Path 'HKCU:\\Software\\RegisteredApplications' -Force | Out-Null
New-ItemProperty -Path 'HKCU:\\Software\\RegisteredApplications' -Name 'PDF Editor' -Value 'Software\\PDF Editor\\Capabilities' -Force | Out-Null
New-Item -Path 'HKCU:\\Software\\PDF Editor\\Capabilities\\FileAssociations' -Force | Out-Null
${extBlock}

# Notifică Explorer imediat (fără restart)
$sig = '[DllImport("shell32.dll")] public static extern void SHChangeNotify(int e, uint f, IntPtr a, IntPtr b);'
$t = Add-Type -MemberDefinition $sig -Name Shell32 -Namespace Win32Notify -PassThru -ErrorAction SilentlyContinue
if ($t) { $t::SHChangeNotify(0x08000000, 0x0000, [IntPtr]::Zero, [IntPtr]::Zero) }
Write-Output 'OK'
`;

  const result = spawnSync('powershell',
    ['-NonInteractive', '-NoProfile', '-Command', ps],
    { encoding: 'utf8', windowsHide: true, timeout: 20000 });

  if (result.stdout && result.stdout.includes('OK')) return { ok: true };
  const err = (result.stderr || result.stdout || 'Eroare necunoscută').trim();
  return { ok: false, msg: err.slice(0, 300) };
});

ipcMain.handle('register:set-default', async () => {
  if (process.platform !== 'win32') return;
  const { spawnSync } = require('child_process');

  // Cream un PDF temporar minim și deschidem dialogul nativ Windows
  // "Cum vrei să deschizi fișierul?" — are checkbox "Folosește întotdeauna"
  const tmpPdf = path.join(tempDir, '_setdefault.pdf');
  const minPdf = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/MediaBox[0 0 1 1]/Parent 2 0 R>>endobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n165\n%%EOF';
  try { fs.writeFileSync(tmpPdf, minPdf, 'ascii'); } catch (_) {}

  // rundll32 deschide dialogul "Open With" nativ cu checkbox "Always use"
  spawnSync('rundll32.exe', ['shell32.dll,OpenAs_RunDLL', tmpPdf],
    { detached: true, stdio: 'ignore', windowsHide: false });
  return true;
});
