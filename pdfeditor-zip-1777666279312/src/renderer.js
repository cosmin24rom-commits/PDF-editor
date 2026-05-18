'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════
const state = {
  pdfDoc:            null,
  pdfBytes:          null,
  originalPdfBytes:  null,
  filePath:          null,
  fileName:          null,
  totalPages:        0,
  currentPage:       1,
  zoom:              1.2,
  documentText:      '',
  settings:          { claudeKey: '', geminiKey: '', language: 'ro', recentFiles: [] },
  aiProvider:        'claude',
  aiHistory:         { claude: [], gemini: [] },
  activeTool:        'select',
  textBoxes:         [],
  dirty:             false
};

// ═══════════════════════════════════════════════════════════════════════════
// PDF.JS INIT
// ═══════════════════════════════════════════════════════════════════════════
let pdfjsLib;

async function initPdfJs() {
  pdfjsLib = window.pdfjsLib;
  if (!pdfjsLib) { showNotif('Eroare: pdf.js nu s-a încărcat', 'error'); return; }
  // Worker via protocol app://
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'app://node_modules/pdfjs-dist/build/pdf.worker.js';
}

// ═══════════════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════════════
async function init() {
  await initPdfJs();
  state.settings = await window.api.getSettings();
  renderRecentFiles();
  bindAll();
  setStatus('Gata');

  // Deschide fișier trimis de la altă instanță sau de la dublu-click Explorer
  window.api.onOpenFile(fp => openFile(fp));
}

// ═══════════════════════════════════════════════════════════════════════════
// OPEN / LOAD PDF
// ═══════════════════════════════════════════════════════════════════════════
async function openFile(fp) {
  try {
    setStatus('Se deschide...');
    const ext = (fp || '').split('.').pop().toLowerCase();

    let pdfBufArr;

    if (ext === 'pdf') {
      pdfBufArr = await window.api.readFile(fp);
    } else if (ext === 'docx' || ext === 'doc') {
      setStatus('Se convertește Word → PDF...');
      pdfBufArr = await window.api.convertDocx(fp);
    } else if (ext === 'md') {
      const bytes = await window.api.readFile(fp);
      const txt = new TextDecoder().decode(new Uint8Array(bytes));
      pdfBufArr = await window.api.convertMd(txt);
    } else if (ext === 'html' || ext === 'htm') {
      const bytes = await window.api.readFile(fp);
      const html = new TextDecoder().decode(new Uint8Array(bytes));
      pdfBufArr = await window.api.convertHtml(html);
    } else if (ext === 'txt' || ext === 'rtf') {
      const bytes = await window.api.readFile(fp);
      const txt = new TextDecoder().decode(new Uint8Array(bytes));
      pdfBufArr = await window.api.convertTxt(txt);
    } else {
      showNotif('Format nesuportat: ' + ext, 'error'); return;
    }

    await loadPdfBuffer(pdfBufArr, fp);
    if (ext !== 'pdf') showNotif('Convertit și deschis cu succes!', 'success');
    await window.api.addRecent(fp);
    state.settings.recentFiles = await window.api.getSettings().then(s => s.recentFiles);
    renderRecentFiles();
  } catch (err) {
    console.error(err);
    showNotif('Eroare: ' + (err.message || err), 'error');
    setStatus('Eroare la deschidere', 'err');
  }
}

async function loadPdfBuffer(bufArr, fp) {
  const raw = bufArr instanceof Uint8Array ? bufArr : new Uint8Array(bufArr);
  // Stocăm o copie independentă — pdfjs transferă (detașează) buffer-ul original la worker
  state.pdfBytes = raw.slice();
  state.filePath = fp || null;
  state.fileName = fp ? fp.split(/[\\/]/).pop() : 'document.pdf';
  state.textBoxes = [];
  state.dirty = false;

  // Dăm pdfjs o altă copie ca să nu detașeze state.pdfBytes
  state.pdfDoc = await pdfjsLib.getDocument({ data: state.pdfBytes.slice() }).promise;
  state.totalPages = state.pdfDoc.numPages;
  state.currentPage = 1;

  showPdfViewer();
  await renderAllPages();
  await renderThumbnails();

  document.getElementById('current-file-name').textContent = state.fileName;
  document.getElementById('st-file').textContent = state.fileName;
  document.getElementById('st-pages').textContent = `Pagini: ${state.totalPages}`;
  setStatus('Deschis');
  enableToolbar();

  // Extrage text în fundal pentru AI
  extractDocumentText();
}

async function extractDocumentText() {
  try {
    document.getElementById('ai-doc-label').textContent = 'Se extrage textul...';
    let text = '';
    for (let i = 1; i <= state.totalPages; i++) {
      const page = await state.pdfDoc.getPage(i);
      const tc   = await page.getTextContent();
      text += `\n--- Pagina ${i} ---\n` + tc.items.map(it => it.str).join(' ');
    }
    state.documentText = text.trim();
    document.getElementById('ai-doc-label').textContent = state.fileName + ` (${state.totalPages} pag.)`;
  } catch (err) {
    console.error('Text extraction error:', err);
    document.getElementById('ai-doc-label').textContent = state.fileName || 'Document activ';
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// RENDERING
// ═══════════════════════════════════════════════════════════════════════════
async function renderAllPages() {
  const wrap = document.getElementById('pages-wrap');
  wrap.innerHTML = '';
  for (let i = 1; i <= state.totalPages; i++) {
    const container = document.createElement('div');
    container.className = 'pdf-page-container';
    container.dataset.page = i;

    const canvas = document.createElement('canvas');
    container.appendChild(canvas);

    const textLayerDiv = document.createElement('div');
    textLayerDiv.className = 'textLayer';
    container.appendChild(textLayerDiv);

    const overlay = document.createElement('div');
    overlay.className = 'page-overlay';
    overlay.dataset.page = i;
    container.appendChild(overlay);

    const num = document.createElement('span');
    num.className = 'pdf-page-num';
    num.textContent = `Pagina ${i}`;
    container.appendChild(num);

    const pageNum = i;
    container.addEventListener('contextmenu', e => {
      e.preventDefault();
      e.stopPropagation();
      const sel = window.getSelection()?.toString().trim();
      if (sel) {
        showCtxMenu(e, 'pdf-selection', { selectedText: sel, pageNum });
      } else {
        showCtxMenu(e, 'pdf-page', { pageNum, page: pageNum });
      }
    });

    wrap.appendChild(container);
    await renderPageToCanvas(i, canvas);
  }
}

async function renderPageToCanvas(pageNum, canvas) {
  const page = await state.pdfDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale: state.zoom });
  canvas.width  = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport }).promise;

  // Text layer — text transparent selectabil
  const container = canvas.parentElement;
  if (!container) return;
  const tl = container.querySelector('.textLayer');
  if (!tl) return;
  tl.innerHTML = '';
  tl.style.setProperty('--scale-factor', state.zoom);
  try {
    const textContent = await page.getTextContent();
    const task = pdfjsLib.renderTextLayer({ textContentSource: textContent, container: tl, viewport, textDivs: [] });
    if (task && task.promise) await task.promise;
  } catch (_) { /* text layer opțional */ }
}

async function renderThumbnails() {
  const list = document.getElementById('thumbs-list');
  list.innerHTML = '';
  for (let i = 1; i <= state.totalPages; i++) {
    const item = document.createElement('div');
    item.className = 'thumb-item' + (i === state.currentPage ? ' active' : '');
    item.dataset.page = i;

    const c = document.createElement('canvas');
    const page = await state.pdfDoc.getPage(i);
    const vp = page.getViewport({ scale: 0.2 });
    c.width  = vp.width;
    c.height = vp.height;
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    item.appendChild(c);

    const num = document.createElement('span');
    num.className = 'thumb-num';
    num.textContent = i;
    item.appendChild(num);

    item.addEventListener('click', () => scrollToPage(i));
    item.addEventListener('contextmenu', e => { e.preventDefault(); showCtxMenu(e, 'thumbnail', { page: i }); });
    list.appendChild(item);
  }
}

async function rezoom() {
  if (!state.pdfDoc) return;
  const canvases = document.querySelectorAll('.pdf-page-container canvas');
  for (let i = 0; i < canvases.length; i++) {
    await renderPageToCanvas(i + 1, canvases[i]);
  }
  document.getElementById('zoom-label').textContent = Math.round(state.zoom * 100) + '%';
  document.getElementById('st-zoom').textContent = Math.round(state.zoom * 100) + '%';
}

function scrollToPage(n) {
  const el = document.querySelector(`.pdf-page-container[data-page="${n}"]`);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  state.currentPage = n;
  document.querySelectorAll('.thumb-item').forEach(t => t.classList.toggle('active', +t.dataset.page === n));
}

// ═══════════════════════════════════════════════════════════════════════════
// SAVE
// ═══════════════════════════════════════════════════════════════════════════
async function savePdf() {
  const fp = state.filePath || await window.api.saveDialog(state.fileName);
  if (!fp) return;
  try {
    await window.api.writeFile(fp, Array.from(state.pdfBytes));
    state.filePath = fp;
    state.fileName = fp.split(/[\\/]/).pop();
    state.dirty = false;
    document.getElementById('current-file-name').textContent = state.fileName;
    document.getElementById('st-file').textContent = state.fileName;
    showNotif('Salvat: ' + state.fileName, 'success');
  } catch (err) {
    showNotif('Eroare la salvare: ' + err.message, 'error');
  }
}

async function savePdfAs() {
  const fp = await window.api.saveDialog(state.fileName);
  if (!fp) return;
  state.filePath = null;
  state.fileName = fp.split(/[\\/]/).pop();
  await savePdf();
}

// ═══════════════════════════════════════════════════════════════════════════
// CREATE NEW PDF
// ═══════════════════════════════════════════════════════════════════════════
async function createNewPdf(text, fontSize) {
  try {
    setStatus('Se creează PDF...');
    const bufArr = await window.api.fromText(text || ' ', { fontSize: +fontSize || 11 });
    await loadPdfBuffer(bufArr, null);
    state.dirty = true;
    showNotif('PDF nou creat!', 'success');
  } catch (err) {
    showNotif('Eroare: ' + err.message, 'error');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// AI PANEL
// ═══════════════════════════════════════════════════════════════════════════
// AI ERROR PARSING
// ═══════════════════════════════════════════════════════════════════════════
function parseApiError(err) {
  const msg = (err.message || String(err));
  if (msg.includes('429') || msg.includes('Too Many Requests') || msg.includes('RESOURCE_EXHAUSTED') || msg.toLowerCase().includes('quota')) {
    const other = state.aiProvider === 'gemini' ? 'Claude' : 'Gemini';
    return `Limita API ${state.aiProvider === 'gemini' ? 'Gemini' : 'Claude'} depășită. Încearcă din nou în câteva minute sau comută pe ${other}.`;
  }
  if (msg.includes('401') || msg.includes('403') || msg.includes('API_KEY_INVALID') || msg.toLowerCase().includes('unauthorized') || msg.toLowerCase().includes('invalid') && msg.toLowerCase().includes('key')) {
    return `API Key invalid pentru ${state.aiProvider}. Verifică cheia în Setări.`;
  }
  if (msg.includes('fetch') || msg.includes('network') || msg.includes('ENOTFOUND') || msg.includes('ECONNREFUSED')) {
    return 'Eroare de rețea. Verifică conexiunea la internet.';
  }
  return msg.length > 150 ? msg.slice(0, 150) + '…' : msg;
}

// ═══════════════════════════════════════════════════════════════════════════
function toggleAiPanel(open) {
  const panel = document.getElementById('ai-panel');
  const isOpen = !panel.classList.contains('collapsed');
  if (typeof open === 'boolean' ? open : !isOpen) {
    panel.classList.remove('collapsed');
  } else {
    panel.classList.add('collapsed');
  }
}

async function sendToAi(userMsg, system) {
  const key = state.aiProvider === 'claude' ? state.settings.claudeKey : state.settings.geminiKey;
  if (!key) {
    showNotif('Setează API Key pentru ' + state.aiProvider + ' în Setări', 'error');
    openSettings();
    return;
  }

  appendAiMsg('user', userMsg);
  const thinking = appendThinking();

  const history = state.aiHistory[state.aiProvider];
  history.push({ role: 'user', content: userMsg });

  const docCtx = state.documentText
    ? `Documentul PDF deschis conține următorul text:\n\n${state.documentText.slice(0, 32000)}`
    : null;
  const ctxSystem = system || (docCtx
    ? `Ești un expert în analiza și prelucrarea documentelor PDF. ${docCtx}\n\nRăspunde în limba în care ți se scrie.`
    : 'Ești un asistent AI expert în documente. Răspunde în limba în care ți se scrie.');

  try {
    let response;
    if (state.aiProvider === 'claude') {
      response = await window.api.callClaude(key, history, ctxSystem);
    } else {
      response = await window.api.callGemini(key, history);
    }
    history.push({ role: 'assistant', content: response });
    thinking.remove();
    appendAiMsg('assistant', response);
  } catch (err) {
    thinking.remove();
    history.pop(); // scoate mesajul user care a eșuat
    const errMsg = '❌ ' + parseApiError(err);
    appendAiMsg('assistant', errMsg);
  }

  document.getElementById('ai-input').value = '';
  document.getElementById('btn-ai-send').disabled = false;
}

function appendAiMsg(role, content) {
  const container = document.getElementById('ai-messages');
  const div = document.createElement('div');
  div.className = `ai-msg ${role}`;

  const avatar = document.createElement('div');
  avatar.className = 'ai-msg-avatar';
  avatar.textContent = role === 'user' ? 'Tu' : (state.aiProvider === 'claude' ? 'C' : 'G');

  const col = document.createElement('div');
  col.style.cssText = 'display:flex;flex-direction:column;max-width:85%';

  const bubble = document.createElement('div');
  bubble.className = 'ai-msg-bubble';
  bubble.textContent = content;

  col.appendChild(bubble);

  if (role === 'assistant') {
    const actions = document.createElement('div');
    actions.className = 'ai-msg-actions';
    actions.innerHTML = `
      <button class="ai-msg-action" data-action="copy">Copiază</button>
      <button class="ai-msg-action" data-action="apply">Aplică în doc</button>
    `;
    actions.querySelectorAll('.ai-msg-action').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.action === 'copy') {
          navigator.clipboard.writeText(content);
          showNotif('Copiat!', 'success');
        } else if (btn.dataset.action === 'apply') {
          applyTextToDocument(content);
        }
      });
    });
    col.appendChild(actions);
  }

  div.appendChild(avatar);
  div.appendChild(col);
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return div;
}

function appendThinking() {
  const container = document.getElementById('ai-messages');
  const div = document.createElement('div');
  div.className = 'ai-thinking';
  div.textContent = state.aiProvider === 'claude' ? 'Claude gândește' : 'Gemini generează';
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return div;
}

async function applyTextToDocument(text) {
  try {
    state.originalPdfBytes = state.pdfBytes;
    const originalPath = state.filePath;
    const bufArr = await window.api.fromText(text);
    await loadPdfBuffer(bufArr, null);
    state.filePath = originalPath;
    state.dirty = true;
    showDocActionBar('Document generat de AI — Salvează sau revino la original');
  } catch (err) {
    showNotif('Eroare: ' + err.message, 'error');
  }
}

function showDocActionBar(msg) {
  document.getElementById('doc-action-msg').textContent = msg;
  document.getElementById('doc-action-bar').classList.remove('hidden');
}

function hideDocActionBar() {
  document.getElementById('doc-action-bar').classList.add('hidden');
}

function closeDocument() {
  if (state.originalPdfBytes) { hideDocActionBar(); state.originalPdfBytes = null; }
  state.pdfDoc       = null;
  state.pdfBytes     = null;
  state.filePath     = null;
  state.fileName     = null;
  state.totalPages   = 0;
  state.currentPage  = 1;
  state.documentText = '';
  state.textBoxes    = [];
  state.dirty        = false;
  document.getElementById('pages-wrap').innerHTML  = '';
  document.getElementById('thumbs-list').innerHTML = '';
  document.getElementById('current-file-name').textContent = 'Niciun fișier deschis';
  document.getElementById('st-file').textContent  = 'Niciun fișier';
  document.getElementById('st-pages').textContent = '';
  document.getElementById('st-zoom').textContent  = '';
  document.getElementById('ai-doc-label').textContent = 'Niciun document activ';
  ['btn-save','btn-close-doc','btn-select','btn-add-text','btn-add-img',
   'btn-zoom-out','btn-zoom-in','btn-zoom-fit'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = true;
  });
  showHomeScreen();
  setStatus('Gata');
}

async function translateDocumentToDoc(lang) {
  if (!state.pdfDoc) { showNotif('Deschide un document mai întâi!', 'error'); return; }
  const key = state.aiProvider === 'claude' ? state.settings.claudeKey : state.settings.geminiKey;
  if (!key) { showNotif('Setează API Key pentru ' + state.aiProvider + ' în Setări', 'error'); openSettings(); return; }
  if (!state.documentText) { showNotif('Textul documentului nu a fost extras încă. Încearcă din nou.', 'error'); return; }

  showDocActionBar('Se traduce... Vă rugăm așteptați');
  document.getElementById('btn-doc-accept').disabled = true;
  document.getElementById('btn-doc-reject').disabled = true;
  setStatus('Se traduce documentul...');

  try {
    const prompt = `Traduce tot textul de mai jos în ${lang}.\n\nReguli stricte:\n- Returnează NUMAI conținutul tradus, fără introducere sau note\n- Folosește HTML pentru structură: <h1> <h2> <p> <table> <tr> <td> <th> <ul> <li> <strong> <em>\n- Dacă găsești date tabelare (coloane cu cifre, coduri, prețuri), creează un <table> HTML ordonat\n- Păstrează ordinea și structura logică a documentului original\n- Nu inventa conținut care nu există în original\n\nText de tradus:\n${state.documentText.slice(0, 28000)}`;
    const history = [{ role: 'user', content: prompt }];
    const system = 'Ești un traducător și formator de documente expert. Returnezi NUMAI HTML structurat cu conținutul tradus, fără alte comentarii sau markdown fences.';

    let response;
    if (state.aiProvider === 'claude') {
      response = await window.api.callClaude(key, history, system);
    } else {
      response = await window.api.callGemini(key, history);
    }

    state.originalPdfBytes = state.pdfBytes;
    const originalPath = state.filePath;
    // Curăță eventuale fences markdown ```html ... ```
    const html = response.replace(/^```html?\s*/i, '').replace(/\s*```$/, '').trim();
    const bufArr = await window.api.convertHtml(html);
    await loadPdfBuffer(bufArr, null);
    state.filePath = originalPath;
    state.dirty = true;

    showDocActionBar(`Document tradus în ${lang} — Salvează sau revino la original`);
    document.getElementById('btn-doc-accept').disabled = false;
    document.getElementById('btn-doc-reject').disabled = false;
    setStatus('Traducere completă');
  } catch (err) {
    hideDocActionBar();
    showNotif('Eroare traducere: ' + parseApiError(err), 'error');
    setStatus('Eroare');
  }
}

// Quick AI actions
const quickPrompts = {
  summarize:  'Fă un rezumat detaliat al acestui document.',
  translate:  () => `Traduce întreg documentul în ${document.getElementById('set-language')?.value || 'română'}.`,
  analyze:    'Analizează documentul și prezintă structura, temele principale și concluziile.',
  improve:    'Sugerează îmbunătățiri ale stilului, clarității și structurii acestui document.',
  ideas:      'Pe baza acestui document, generează 5 idei creative de continuare sau extindere.',
  'key-points': 'Extrage și listează punctele cheie ale documentului sub formă de bullet points.'
};

// ═══════════════════════════════════════════════════════════════════════════
// CONTEXT MENU
// ═══════════════════════════════════════════════════════════════════════════
let ctxData = {};

const menuConfigs = {
  'pdf-page': [
    { icon: 'T', label: 'Adaugă Text',         action: 'add-text' },
    { icon: '🖼', label: 'Adaugă Imagine',      action: 'add-image' },
    { sep: true },
    { icon: '✂', label: 'Selectare Tot',       action: 'select-all', shortcut: 'Ctrl+A' },
    { sep: true },
    { icon: '+', label: 'Inserează pagină înainte', action: 'page-insert-before' },
    { icon: '+', label: 'Inserează pagină după',    action: 'page-insert-after' },
    { icon: '🗑', label: 'Șterge pagina',       action: 'page-delete', danger: true },
    { sep: true },
    { icon: '↻', label: 'Rotire 90° CW',       action: 'page-rotate-cw' },
    { icon: '↺', label: 'Rotire 90° CCW',      action: 'page-rotate-ccw' },
  ],
  'pdf-selection': [
    { icon: '📋', label: 'Copiază',             action: 'copy', shortcut: 'Ctrl+C' },
    { sep: true },
    { icon: '🔍', label: 'Analizează cu AI',    action: 'ai-analyze' },
    { icon: '🌐', label: 'Traduce cu AI',       action: 'ai-translate' },
    { icon: '✨', label: 'Îmbunătățește cu AI', action: 'ai-improve' },
    { icon: '📋', label: 'Rezumat cu AI',       action: 'ai-summarize-sel' },
  ],
  'text-box': [
    { icon: '✏', label: 'Editează',            action: 'tb-edit' },
    { sep: true },
    { icon: '✂', label: 'Taie',                action: 'tb-cut', shortcut: 'Ctrl+X' },
    { icon: '📋', label: 'Copiază',             action: 'tb-copy', shortcut: 'Ctrl+C' },
    { sep: true },
    { icon: '↑', label: 'Aduce în față',       action: 'tb-front' },
    { icon: '↓', label: 'Trimite în spate',    action: 'tb-back' },
    { sep: true },
    { icon: '🗑', label: 'Șterge',              action: 'tb-delete', danger: true },
  ],
  'thumbnail': [
    { icon: '→', label: 'Mergi la pagina',     action: 'thumb-goto' },
    { sep: true },
    { icon: '+', label: 'Inserează înainte',   action: 'thumb-insert-before' },
    { icon: '+', label: 'Inserează după',      action: 'thumb-insert-after' },
    { sep: true },
    { icon: '↻', label: 'Rotire CW',           action: 'thumb-rotate-cw' },
    { icon: '↺', label: 'Rotire CCW',          action: 'thumb-rotate-ccw' },
    { sep: true },
    { icon: '🗑', label: 'Șterge pagina',       action: 'thumb-delete', danger: true },
  ],
  'ai-message': [
    { icon: '📋', label: 'Copiază',             action: 'ai-msg-copy' },
    { icon: '📄', label: 'Aplică în document', action: 'ai-msg-apply' },
    { sep: true },
    { icon: '🗑', label: 'Șterge mesajul',      action: 'ai-msg-delete', danger: true },
  ],
  'ai-panel': [
    { icon: '🗑', label: 'Șterge conversația', action: 'ai-clear', danger: true },
    { icon: '💾', label: 'Exportă chat',        action: 'ai-export' },
  ],
  'recent-file': [
    { icon: '📂', label: 'Deschide',            action: 'recent-open' },
    { sep: true },
    { icon: '✕',  label: 'Elimină din recente', action: 'recent-remove', danger: true },
  ],
};

function showCtxMenu(e, type, data = {}) {
  e.preventDefault();
  ctxData = { type, ...data };

  const menu   = document.getElementById('ctx-menu');
  const list   = document.getElementById('ctx-list');
  const config = menuConfigs[type] || [];

  list.innerHTML = '';
  config.forEach(item => {
    const li = document.createElement('li');
    if (item.sep) { li.className = 'ctx-sep'; }
    else {
      if (item.danger) li.classList.add('ctx-danger');
      li.innerHTML = `<span class="ctx-icon">${item.icon || ''}</span><span>${item.label}</span>${item.shortcut ? `<span class="ctx-shortcut">${item.shortcut}</span>` : ''}`;
      li.addEventListener('click', () => { hideCtxMenu(); handleCtxAction(item.action, ctxData); });
    }
    list.appendChild(li);
  });

  menu.classList.remove('hidden');
  const vw = window.innerWidth, vh = window.innerHeight;
  let x = e.clientX, y = e.clientY;
  menu.style.left = '-9999px'; menu.style.top = '-9999px';
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  if (x + mw > vw) x = vw - mw - 8;
  if (y + mh > vh) y = vh - mh - 8;
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';
}

function hideCtxMenu() {
  document.getElementById('ctx-menu').classList.add('hidden');
}

async function handleCtxAction(action, data) {
  switch (action) {
    case 'add-text':    addTextBox(data.pageNum, 50, 50); break;
    case 'add-image':   addImageToPage(data.pageNum); break;
    case 'select-all':  window.getSelection()?.selectAllChildren(document.getElementById('pages-wrap')); break;
    case 'copy':        navigator.clipboard.writeText(data.selectedText || ''); showNotif('Copiat!', 'success'); break;

    case 'page-delete':
    case 'thumb-delete':
      if (state.totalPages <= 1) { showNotif('Nu poți șterge singura pagină!', 'error'); break; }
      await deletePage(data.page); break;

    case 'page-rotate-cw':
    case 'thumb-rotate-cw':   await rotatePage(data.page,  90); break;
    case 'page-rotate-ccw':
    case 'thumb-rotate-ccw':  await rotatePage(data.page, -90); break;
    case 'thumb-goto':  scrollToPage(data.page); break;

    case 'page-insert-before':
    case 'thumb-insert-before': await insertBlankPage(data.page - 1); break;
    case 'page-insert-after':
    case 'thumb-insert-after':  await insertBlankPage(data.page); break;

    case 'ai-analyze':      sendToAiWithSelection(data.selectedText, 'Analizează acest fragment:'); break;
    case 'ai-translate':    sendToAiWithSelection(data.selectedText, 'Traduce acest text:'); break;
    case 'ai-improve':      sendToAiWithSelection(data.selectedText, 'Îmbunătățește stilul acestui text:'); break;
    case 'ai-summarize-sel':sendToAiWithSelection(data.selectedText, 'Fă un rezumat al acestui text:'); break;

    case 'tb-edit':   editTextBox(data.id); break;
    case 'tb-cut':    cutTextBox(data.id); break;
    case 'tb-copy':   copyTextBox(data.id); break;
    case 'tb-delete': deleteTextBox(data.id); break;
    case 'tb-front':  bringToFront(data.id); break;
    case 'tb-back':   sendToBack(data.id); break;

    case 'ai-msg-copy':   navigator.clipboard.writeText(data.text || ''); showNotif('Copiat!', 'success'); break;
    case 'ai-msg-apply':  applyTextToDocument(data.text || ''); break;
    case 'ai-msg-delete': data.el?.remove(); break;

    case 'ai-clear':
      state.aiHistory[state.aiProvider] = [];
      document.getElementById('ai-messages').innerHTML = '';
      break;
    case 'ai-export':
      exportAiChat(); break;

    case 'recent-open':   openFile(data.path); break;
    case 'recent-remove':
      state.settings.recentFiles = await window.api.removeRecent(data.path);
      renderRecentFiles(); break;
  }
}

function sendToAiWithSelection(text, prefix) {
  toggleAiPanel(true);
  const msg = `${prefix}\n\n"${text}"`;
  document.getElementById('ai-input').value = msg;
  document.getElementById('ai-input').focus();
}

// ═══════════════════════════════════════════════════════════════════════════
// PDF OPERATIONS (pdf-lib)
// ═══════════════════════════════════════════════════════════════════════════
async function deletePage(pageNum) {
  // Rebuild PDF without that page via canvas → pdf-lib
  showNotif('Ștergere pagină ' + pageNum + '...', 'success');
  // For now, reload with page removed via extracting other pages
  // TODO: implement with pdf-lib in main process
  showNotif('Funcție în dezvoltare', 'error');
}

async function rotatePage(pageNum, degrees) {
  showNotif(`Rotire pagina ${pageNum} cu ${degrees}°... (funcție în dezvoltare)`, 'error');
}

async function insertBlankPage(afterPage) {
  showNotif('Inserare pagină... (funcție în dezvoltare)', 'error');
}

// ═══════════════════════════════════════════════════════════════════════════
// TEXT BOX (overlay editing)
// ═══════════════════════════════════════════════════════════════════════════
let tbCounter = 0;
const clipboard = { text: '' };

function addTextBox(pageNum, x, y) {
  const overlay = document.querySelector(`.page-overlay[data-page="${pageNum}"]`);
  if (!overlay) return;
  overlay.classList.add('editing');

  const id = ++tbCounter;
  const box = document.createElement('div');
  box.className = 'text-box selected';
  box.dataset.id = id;
  box.style.cssText = `left:${x}px;top:${y}px;width:200px;min-height:32px`;

  const ta = document.createElement('textarea');
  ta.className = 'text-box-inner';
  ta.placeholder = 'Scrie text...';
  ta.rows = 2;

  const handle = document.createElement('div');
  handle.className = 'resize-handle';

  box.appendChild(ta);
  box.appendChild(handle);
  overlay.appendChild(box);

  makeDraggable(box, overlay);
  makeResizable(box, handle);

  box.addEventListener('contextmenu', e => {
    e.preventDefault(); e.stopPropagation();
    showCtxMenu(e, 'text-box', { id });
  });

  ta.focus();
  state.textBoxes.push({ id, pageNum, el: box });
  state.dirty = true;
}

async function addImageToPage(pageNum) {
  const fp = await window.api.openDialog([{ name: 'Imagini', extensions: ['png','jpg','jpeg','gif','bmp','webp'] }]);
  if (!fp) return;
  const overlay = document.querySelector(`.page-overlay[data-page="${pageNum}"]`);
  if (!overlay) return;
  overlay.classList.add('editing');

  const bufArr = await window.api.readFile(fp);
  const blob   = new Blob([new Uint8Array(bufArr)]);
  const url    = URL.createObjectURL(blob);

  const box = document.createElement('div');
  box.style.cssText = 'position:absolute;left:50px;top:50px;width:200px;cursor:move;border:2px dashed var(--accent)';

  const img = document.createElement('img');
  img.src = url;
  img.style.cssText = 'width:100%;height:auto;display:block;pointer-events:none';
  box.appendChild(img);

  const id = ++tbCounter;
  box.dataset.id = id;

  const handle = document.createElement('div');
  handle.className = 'resize-handle';
  box.appendChild(handle);

  overlay.appendChild(box);
  makeDraggable(box, overlay);
  makeResizable(box, handle);

  box.addEventListener('contextmenu', e => {
    e.preventDefault(); e.stopPropagation();
    showCtxMenu(e, 'text-box', { id });
  });

  state.textBoxes.push({ id, pageNum, el: box });
  state.dirty = true;
  showNotif('Imagine adăugată!', 'success');
}

function editTextBox(id) {
  const tb = state.textBoxes.find(t => t.id === id);
  if (!tb) return;
  const ta = tb.el.querySelector('textarea');
  if (ta) ta.focus();
}

function cutTextBox(id) {
  const idx = state.textBoxes.findIndex(t => t.id === id);
  if (idx < 0) return;
  const ta = state.textBoxes[idx].el.querySelector('textarea');
  clipboard.text = ta ? ta.value : '';
  state.textBoxes[idx].el.remove();
  state.textBoxes.splice(idx, 1);
}

function copyTextBox(id) {
  const tb = state.textBoxes.find(t => t.id === id);
  if (!tb) return;
  const ta = tb.el.querySelector('textarea');
  clipboard.text = ta ? ta.value : '';
  navigator.clipboard.writeText(clipboard.text);
  showNotif('Copiat!', 'success');
}

function deleteTextBox(id) {
  const idx = state.textBoxes.findIndex(t => t.id === id);
  if (idx < 0) return;
  state.textBoxes[idx].el.remove();
  state.textBoxes.splice(idx, 1);
}

function bringToFront(id) {
  const tb = state.textBoxes.find(t => t.id === id);
  if (tb) tb.el.style.zIndex = '999';
}

function sendToBack(id) {
  const tb = state.textBoxes.find(t => t.id === id);
  if (tb) tb.el.style.zIndex = '0';
}

// ─── Drag ───────────────────────────────────────────────────────────────────
function makeDraggable(el, parent) {
  let ox, oy, sx, sy;
  el.addEventListener('mousedown', e => {
    if (e.target.classList.contains('resize-handle')) return;
    if (e.target.tagName === 'TEXTAREA') return;
    if (e.button !== 0) return;
    ox = el.offsetLeft; oy = el.offsetTop;
    sx = e.clientX;    sy = e.clientY;
    const onMove = mv => {
      el.style.left = (ox + mv.clientX - sx) + 'px';
      el.style.top  = (oy + mv.clientY - sy) + 'px';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    e.preventDefault();
  });
}

function makeResizable(el, handle) {
  handle.addEventListener('mousedown', e => {
    e.stopPropagation(); e.preventDefault();
    const sw = el.offsetWidth, sh = el.offsetHeight;
    const sx = e.clientX, sy = e.clientY;
    const onMove = mv => {
      el.style.width  = Math.max(60, sw + mv.clientX - sx) + 'px';
      el.style.height = Math.max(24, sh + mv.clientY - sy) + 'px';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════════════════════════════════════
function openSettings() {
  document.getElementById('set-claude-key').value = state.settings.claudeKey || '';
  document.getElementById('set-gemini-key').value = state.settings.geminiKey || '';
  document.getElementById('set-language').value   = state.settings.language  || 'ro';
  showModal('modal-settings');
}

async function saveSettings() {
  state.settings.claudeKey = document.getElementById('set-claude-key').value.trim();
  state.settings.geminiKey = document.getElementById('set-gemini-key').value.trim();
  state.settings.language  = document.getElementById('set-language').value;
  await window.api.saveSettings(state.settings);
  closeAllModals();
  showNotif('Setări salvate!', 'success');
}

// ═══════════════════════════════════════════════════════════════════════════
// CONVERSION MODAL
// ═══════════════════════════════════════════════════════════════════════════
async function handleConvert(fp) {
  const prog = document.getElementById('convert-progress');
  const dz   = document.getElementById('drop-zone');
  dz.classList.add('hidden');
  prog.classList.remove('hidden');
  document.getElementById('convert-status').textContent = 'Se convertește...';

  try {
    await openFile(fp);
    closeAllModals();
    showNotif('Convertit cu succes!', 'success');
  } catch (err) {
    showNotif('Eroare conversie: ' + err.message, 'error');
  } finally {
    dz.classList.remove('hidden');
    prog.classList.add('hidden');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// AI EXPORT
// ═══════════════════════════════════════════════════════════════════════════
async function exportAiChat() {
  const msgs = state.aiHistory[state.aiProvider];
  if (!msgs.length) { showNotif('Conversația este goală', 'error'); return; }
  const text = msgs.map(m => `[${m.role.toUpperCase()}]\n${m.content}`).join('\n\n---\n\n');
  const bufArr = await window.api.convertTxt(text);
  const fp = await window.api.saveDialog(`chat-${state.aiProvider}.pdf`);
  if (!fp) return;
  await window.api.writeFile(fp, bufArr);
  showNotif('Chat exportat!', 'success');
}

// ═══════════════════════════════════════════════════════════════════════════
// RECENT FILES
// ═══════════════════════════════════════════════════════════════════════════
function renderRecentFiles() {
  const list = document.getElementById('recent-list');
  if (!list) return;
  const files = state.settings.recentFiles || [];
  if (!files.length) {
    list.innerHTML = '<div style="color:var(--text3);font-size:12px">Niciun fișier recent</div>';
    return;
  }
  list.innerHTML = '';
  files.forEach(fp => {
    const name = fp.split(/[\\/]/).pop();
    const item = document.createElement('div');
    item.className = 'recent-item';
    item.innerHTML = `
      <span class="recent-icon">📄</span>
      <span class="recent-path" title="${fp}">${name}</span>
      <button class="recent-remove" title="Elimină">✕</button>`;
    item.querySelector('.recent-path').addEventListener('click', () => openFile(fp));
    item.querySelector('.recent-remove').addEventListener('click', async e => {
      e.stopPropagation();
      state.settings.recentFiles = await window.api.removeRecent(fp);
      renderRecentFiles();
    });
    item.addEventListener('contextmenu', e => { e.preventDefault(); showCtxMenu(e, 'recent-file', { path: fp }); });
    list.appendChild(item);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// UI HELPERS
// ═══════════════════════════════════════════════════════════════════════════
function showPdfViewer() {
  document.getElementById('home-screen').classList.add('hidden');
  document.getElementById('pdf-viewer').classList.remove('hidden');
}

function showHomeScreen() {
  document.getElementById('home-screen').classList.remove('hidden');
  document.getElementById('pdf-viewer').classList.add('hidden');
}

function enableToolbar() {
  ['btn-save','btn-close-doc','btn-select','btn-add-text','btn-add-img','btn-zoom-out','btn-zoom-in','btn-zoom-fit'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = false;
  });
  document.getElementById('zoom-label').textContent = Math.round(state.zoom * 100) + '%';
  document.getElementById('st-zoom').textContent    = Math.round(state.zoom * 100) + '%';
}

function showModal(id) {
  document.getElementById('modal-overlay').classList.remove('hidden');
  document.getElementById(id).classList.remove('hidden');
}

function closeAllModals() {
  document.getElementById('modal-overlay').classList.add('hidden');
  document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
  // Reset convert modal
  const dz = document.getElementById('drop-zone');
  const prog = document.getElementById('convert-progress');
  if (dz) dz.classList.remove('hidden');
  if (prog) prog.classList.add('hidden');
}

function showNotif(msg, type = 'info') {
  let n = document.getElementById('notification');
  if (!n) { n = document.createElement('div'); n.id = 'notification'; document.body.appendChild(n); }
  n.textContent = msg;
  n.className = type;
  clearTimeout(n._t);
  n._t = setTimeout(() => n.remove(), type === 'error' ? 7000 : 3000);
}

function setStatus(msg, cls = '') {
  const el = document.getElementById('st-msg');
  el.textContent = msg;
  el.className = cls;
}

// ═══════════════════════════════════════════════════════════════════════════
// BIND ALL EVENTS
// ═══════════════════════════════════════════════════════════════════════════
function bindAll() {
  // Window controls
  document.getElementById('btn-minimize').addEventListener('click', () => window.api.minimize());
  document.getElementById('btn-maximize').addEventListener('click', () => window.api.maximize());
  document.getElementById('btn-close').addEventListener('click',    () => window.api.close());

  // Toolbar
  document.getElementById('btn-new').addEventListener('click',     () => showModal('modal-new'));
  document.getElementById('btn-open').addEventListener('click',    handleOpenBtn);
  document.getElementById('btn-save').addEventListener('click',    () => savePdf());
  document.getElementById('btn-convert').addEventListener('click', () => showModal('modal-convert'));
  document.getElementById('btn-settings').addEventListener('click',() => openSettings());
  document.getElementById('btn-ai-toggle').addEventListener('click', () => toggleAiPanel());

  // Tool buttons
  document.getElementById('btn-select').addEventListener('click',   () => setTool('select'));
  document.getElementById('btn-add-text').addEventListener('click', () => setTool('add-text'));
  document.getElementById('btn-add-img').addEventListener('click',  () => setTool('add-image'));

  // Zoom
  document.getElementById('btn-zoom-in').addEventListener('click',  () => changeZoom(0.15));
  document.getElementById('btn-zoom-out').addEventListener('click', () => changeZoom(-0.15));
  document.getElementById('btn-zoom-fit').addEventListener('click', fitZoom);

  // Home screen
  document.getElementById('home-new').addEventListener('click',     () => showModal('modal-new'));
  document.getElementById('home-open').addEventListener('click',    handleOpenBtn);
  document.getElementById('home-convert').addEventListener('click', () => showModal('modal-convert'));

  // PDF area right-click
  document.getElementById('pdf-area').addEventListener('contextmenu', e => {
    e.preventDefault();
    const pageEl = e.target.closest('.pdf-page-container');
    if (!pageEl) return;
    const sel = window.getSelection()?.toString().trim();
    if (sel) {
      showCtxMenu(e, 'pdf-selection', { selectedText: sel, pageNum: +pageEl.dataset.page });
    } else {
      showCtxMenu(e, 'pdf-page', { pageNum: +pageEl.dataset.page, page: +pageEl.dataset.page });
    }
  });

  // PDF area click (tool actions)
  document.getElementById('pdf-area').addEventListener('click', e => {
    if (state.activeTool === 'add-text') {
      const overlay = e.target.closest('.page-overlay');
      if (!overlay) return;
      const rect = overlay.getBoundingClientRect();
      addTextBox(+overlay.dataset.page, e.clientX - rect.left, e.clientY - rect.top);
      setTool('select');
    }
  });

  // AI panel
  document.getElementById('btn-ai-close').addEventListener('click', () => toggleAiPanel(false));
  document.getElementById('btn-ai-clear').addEventListener('click', () => {
    state.aiHistory[state.aiProvider] = [];
    document.getElementById('ai-messages').innerHTML = '';
  });

  document.querySelectorAll('.ai-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.ai-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      state.aiProvider = tab.dataset.provider;
    });
  });

  document.querySelectorAll('.ai-quick').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!state.pdfDoc) {
        showNotif('Deschide un document mai întâi!', 'error'); return;
      }
      const action = btn.dataset.action;
      if (action === 'translate') { showModal('modal-translate'); return; }
      const prompt = typeof quickPrompts[action] === 'function' ? quickPrompts[action]() : quickPrompts[action];
      toggleAiPanel(true);
      sendToAi(prompt);
    });
  });

  document.getElementById('btn-ai-send').addEventListener('click', sendAiFromInput);
  document.getElementById('ai-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAiFromInput(); }
  });

  // AI panel context menu
  document.getElementById('ai-messages').addEventListener('contextmenu', e => {
    e.preventDefault();
    const bubble = e.target.closest('.ai-msg-bubble');
    const msg    = e.target.closest('.ai-msg');
    if (bubble && msg) {
      showCtxMenu(e, 'ai-message', { text: bubble.textContent, el: msg });
    } else {
      showCtxMenu(e, 'ai-panel', {});
    }
  });

  // Modal buttons
  document.querySelectorAll('.modal-close, .modal-close-btn').forEach(btn => {
    btn.addEventListener('click', closeAllModals);
  });
  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('modal-overlay')) closeAllModals();
  });

  document.getElementById('btn-settings-save').addEventListener('click', saveSettings);

  document.getElementById('btn-register-windows').addEventListener('click', async () => {
    showNotif('Se înregistrează...', 'info');
    const result = await window.api.registerWindows();
    if (result.ok) {
      showNotif('Înregistrat! Click dreapta pe orice PDF → "Deschide cu" → PDF Editor', 'success');
    } else {
      showNotif('Eroare la înregistrare: ' + result.msg, 'error');
    }
  });
  document.getElementById('btn-set-default').addEventListener('click', async () => {
    await window.api.setDefaultApp();
    showNotif('Setările Windows s-au deschis — caută ".pdf" și alege PDF Editor', 'success');
  });
  document.getElementById('btn-new-create').addEventListener('click', () => {
    const txt  = document.getElementById('new-pdf-text').value;
    const size = document.getElementById('new-pdf-size').value;
    closeAllModals();
    createNewPdf(txt, size);
  });

  document.getElementById('btn-translate-go').addEventListener('click', () => {
    const lang = document.getElementById('trans-lang').value;
    const prov = document.getElementById('trans-provider').value;
    state.aiProvider = prov;
    document.querySelectorAll('.ai-tab').forEach(t => t.classList.toggle('active', t.dataset.provider === prov));
    closeAllModals();
    translateDocumentToDoc(lang);
  });

  // Convert modal
  document.getElementById('btn-browse-convert').addEventListener('click', async () => {
    const fp = await window.api.openDialog();
    if (fp) handleConvert(fp);
  });

  const dz = document.getElementById('drop-zone');
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('dragover'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
  dz.addEventListener('drop', e => {
    e.preventDefault(); dz.classList.remove('dragover');
    const fp = e.dataTransfer.files[0]?.path;
    if (fp) handleConvert(fp);
  });

  // Global drag & drop on PDF area
  document.getElementById('pdf-area').addEventListener('dragover', e => e.preventDefault());
  document.getElementById('pdf-area').addEventListener('drop', e => {
    e.preventDefault();
    const fp = e.dataTransfer.files[0]?.path;
    if (fp) openFile(fp);
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', async e => {
    if (e.ctrlKey) {
      if (e.key === 'o') { e.preventDefault(); handleOpenBtn(); }
      if (e.key === 's') { e.preventDefault(); if (state.pdfDoc) savePdf(); }
      if (e.key === 'n') { e.preventDefault(); showModal('modal-new'); }
      if (e.key === '+' || e.key === '=') { e.preventDefault(); if (state.pdfDoc) changeZoom(0.15); }
      if (e.key === '-') { e.preventDefault(); if (state.pdfDoc) changeZoom(-0.15); }
      if (e.key === '0') { e.preventDefault(); if (state.pdfDoc) fitZoom(); }
      if (e.key === 'w' || e.key === 'W') { e.preventDefault(); if (state.pdfDoc) document.getElementById('btn-close-doc').click(); }
    }
    if (e.key === 'Escape') { hideCtxMenu(); closeAllModals(); }
  });

  // Hide context menu on click outside
  document.addEventListener('click', e => {
    if (!document.getElementById('ctx-menu').contains(e.target)) hideCtxMenu();
  });

  // Zoom cu scroll (Ctrl + scroll)
  document.getElementById('pdf-area').addEventListener('wheel', e => {
    if (!state.pdfDoc || !e.ctrlKey) return;
    e.preventDefault();
    changeZoom(e.deltaY < 0 ? 0.1 : -0.1);
  }, { passive: false });

  // Track scroll position for current page indicator
  document.getElementById('pdf-area').addEventListener('scroll', updateCurrentPageFromScroll);

  // Buton Închide document
  document.getElementById('btn-close-doc').addEventListener('click', () => {
    if (state.dirty && !state.originalPdfBytes) {
      if (!confirm('Documentul are modificări nesalvate. Închizi fără a salva?')) return;
    }
    closeDocument();
  });

  // Doc action bar — Accept / Reject
  document.getElementById('btn-doc-accept').addEventListener('click', async () => {
    const orig = state.originalPdfBytes;
    const origPath = state.filePath;
    hideDocActionBar();
    state.originalPdfBytes = null;
    await savePdfAs();
    // Dacă userul a anulat save-as dialog, restaurăm starea
    if (!state.filePath && orig) {
      state.originalPdfBytes = orig;
      state.filePath = origPath;
      showDocActionBar('Salvare anulată — Salvează sau revino la original');
    }
  });
  document.getElementById('btn-doc-reject').addEventListener('click', async () => {
    if (!state.originalPdfBytes) { hideDocActionBar(); return; }
    const savedOrig  = state.originalPdfBytes;
    const savedPath  = state.filePath;
    hideDocActionBar();
    try {
      await loadPdfBuffer(savedOrig, savedPath);
      state.originalPdfBytes = null;
      showNotif('Revenit la documentul original', 'success');
    } catch (err) {
      showNotif('Eroare la revenire: ' + (err.message || err), 'error');
      state.originalPdfBytes = savedOrig;
      state.filePath = savedPath;
    }
  });
}

function sendAiFromInput() {
  const input = document.getElementById('ai-input');
  const msg = input.value.trim();
  if (!msg) return;
  document.getElementById('btn-ai-send').disabled = true;
  sendToAi(msg).finally(() => {
    document.getElementById('btn-ai-send').disabled = false;
  });
}

async function handleOpenBtn() {
  const fp = await window.api.openDialog();
  if (fp) openFile(fp);
}

function setTool(tool) {
  state.activeTool = tool;
  document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
  const map = { 'select': 'btn-select', 'add-text': 'btn-add-text', 'add-image': 'btn-add-img' };
  if (map[tool]) document.getElementById(map[tool])?.classList.add('active');
  document.getElementById('pdf-area').style.cursor = tool === 'add-text' ? 'text' : (tool === 'add-image' ? 'crosshair' : 'default');
}

async function changeZoom(delta) {
  state.zoom = Math.min(4, Math.max(0.3, state.zoom + delta));
  document.getElementById('zoom-label').textContent = Math.round(state.zoom * 100) + '%';
  document.getElementById('st-zoom').textContent    = Math.round(state.zoom * 100) + '%';
  await rezoom();
}

async function fitZoom() {
  const area = document.getElementById('pdf-area');
  const areaW = area.clientWidth - 48;
  if (!state.pdfDoc) return;
  const page = await state.pdfDoc.getPage(1);
  const vp = page.getViewport({ scale: 1 });
  state.zoom = Math.max(0.3, areaW / vp.width);
  document.getElementById('zoom-label').textContent = Math.round(state.zoom * 100) + '%';
  await rezoom();
}

function updateCurrentPageFromScroll() {
  const containers = document.querySelectorAll('.pdf-page-container');
  const area = document.getElementById('pdf-area');
  const scrollTop = area.scrollTop + area.clientHeight / 2;
  let current = 1;
  containers.forEach(c => {
    if (c.offsetTop <= scrollTop) current = +c.dataset.page;
  });
  if (current !== state.currentPage) {
    state.currentPage = current;
    document.querySelectorAll('.thumb-item').forEach(t =>
      t.classList.toggle('active', +t.dataset.page === current));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', init);
