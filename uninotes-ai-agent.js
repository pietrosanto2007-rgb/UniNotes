/* ============================================================
   UNI NOTES — AGENTE AI LOCALE (Ollama)
   ------------------------------------------------------------
   Questo file si aggancia all'app Uni Notes esistente SENZA
   duplicarne la logica: chiama sempre gli stessi oggetti globali
   già definiti nello script principale (FileSystemManager,
   LibraryScanner, AppState, Router, ContentIndex, PDFViewerModal,
   FileViewer, ModalManager, Toast, icon/ICONS, ecc.).
   Va incluso con un tag <script> DOPO lo script principale, es.:

     <script src="uninotes-ai-agent.js"></script>

   subito prima di </body>. Non richiede build, bundler o backend:
   parla solo con Ollama in locale (http://localhost:11434).
   ============================================================ */
(function(){
'use strict';

/* ---------- Icone aggiuntive (estendono ICONS già esistente) ---------- */
if(typeof ICONS !== 'undefined'){
  ICONS.ai = ICONS.ai || '<path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z"/><path d="M19 14l.6 1.8L21.5 16.5l-1.9.7L19 19l-.6-1.8-1.9-.7 1.9-.7L19 14z"/>';
  ICONS.send = ICONS.send || '<path d="M22 2L11 13"/><path d="M22 2L15 22l-4-9-9-4 20-7z"/>';
  ICONS.stopcircle = ICONS.stopcircle || '<circle cx="12" cy="12" r="10"/><rect x="9" y="9" width="6" height="6" rx="1"/>';
}

/* ============================================================
   OLLAMA MANAGER
   ============================================================ */
const OllamaManager = {
  baseUrl: 'http://localhost:11434',
  getModel(){ return localStorage.getItem('uninotes.ollamaModel') || ''; },
  setModel(m){ localStorage.setItem('uninotes.ollamaModel', m || ''); },

  async testConnection(){
    try{
      const ctrl = new AbortController();
      const t = setTimeout(()=>ctrl.abort(), 4000);
      const res = await fetch(this.baseUrl + '/api/tags', { signal: ctrl.signal });
      clearTimeout(t);
      if(!res.ok) return { ok:false, error:'HTTP ' + res.status };
      const data = await res.json();
      return { ok:true, models: (data.models||[]).map(m=>m.name) };
    }catch(err){
      const corsLike = (typeof err.message === 'string' && /fetch|network|cors/i.test(err.message));
      return { ok:false, error: err.name==='AbortError' ? 'timeout' : (err.message || 'errore di rete'), cors: corsLike };
    }
  },
  async listModels(){ const r = await this.testConnection(); return r.ok ? r.models : []; },

  /**
   * Invia una chat a Ollama. Se onToken è passato, usa lo streaming NDJSON
   * e richiama onToken per ogni frammento di testo ricevuto.
   * Ritorna sempre il messaggio finale { role, content, tool_calls }.
   */
  async chat({ messages, tools, signal, onToken }){
    const model = this.getModel();
    if(!model) throw new Error('Nessun modello Ollama selezionato.');
    const stream = !!onToken;
    const body = { model, messages, stream };
    if(tools && tools.length) body.tools = tools;
    let res;
    try{
      res = await fetch(this.baseUrl + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal
      });
    }catch(err){
      if(err.name === 'AbortError') throw err;
      throw new Error('Impossibile contattare Ollama su ' + this.baseUrl + ' (' + (err.message||'errore di rete') + '). Se questa pagina è servita da GitHub Pages, potrebbe essere necessario configurare OLLAMA_ORIGINS.');
    }
    if(!res.ok){
      const t = await res.text().catch(()=> '');
      throw new Error('Ollama ha risposto con errore HTTP ' + res.status + (t ? ': ' + t.slice(0,200) : ''));
    }
    if(!stream){
      const data = await res.json();
      return data.message || { role:'assistant', content:'' };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const finalMsg = { role:'assistant', content:'', tool_calls: undefined };
    while(true){
      const { done, value } = await reader.read();
      if(done) break;
      buf += decoder.decode(value, { stream:true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for(const line of lines){
        if(!line.trim()) continue;
        let obj;
        try{ obj = JSON.parse(line); }catch(e){ continue; }
        if(obj.message){
          if(obj.message.content){ finalMsg.content += obj.message.content; onToken(obj.message.content); }
          if(obj.message.tool_calls) finalMsg.tool_calls = obj.message.tool_calls;
        }
      }
    }
    return finalMsg;
  }
};

window.OllamaManager = OllamaManager; // esposta a window per debug/console

/* ============================================================
   PERMESSI AI
   ============================================================ */
const AIPermissions = {
  mode(){ return localStorage.getItem('uninotes.aiMode') || 'balanced'; },
  setMode(m){ localStorage.setItem('uninotes.aiMode', m); }
};

/* ============================================================
   INDICE PDF — riusa pdf.js già caricato dall'app (ensurePdfJs)
   e caching in IndexedDB per non ri-estrarre PDF invariati.
   ============================================================ */
const PdfIndex = {
  entries: [],
  ready: false,
  building: false,
  dbPromise: null,

  db(){
    if(this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject)=>{
      const req = indexedDB.open('uninotes-pdfindex', 1);
      req.onupgradeneeded = () => { req.result.createObjectStore('pages', { keyPath:'fileKey' }); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.dbPromise;
  },
  async getCached(fileKey){
    try{
      const db = await this.db();
      return await new Promise((res)=>{
        const tx = db.transaction('pages','readonly');
        const req = tx.objectStore('pages').get(fileKey);
        req.onsuccess = () => res(req.result || null);
        req.onerror = () => res(null);
      });
    }catch(e){ return null; }
  },
  async putCached(entry){
    try{
      const db = await this.db();
      const tx = db.transaction('pages','readwrite');
      tx.objectStore('pages').put(entry);
    }catch(e){ /* non bloccante */ }
  },

  allPdfTargets(){
    const targets = [];
    allLessonsFlat().forEach(l=>{
      const seen = new Set();
      const pdfs = [];
      if(l.mainFile && l.mainFile.kind === 'pdf'){ pdfs.push(l.mainFile); seen.add(l.mainFile.name); }
      (l.files.pdf||[]).forEach(f=>{ if(!seen.has(f.name)){ pdfs.push(f); seen.add(f.name); } });
      pdfs.forEach(f=>targets.push({ l, f }));
    });
    return targets;
  },

  async build(){
    if(this.building) return;
    this.building = true;
    const targets = this.allPdfTargets();
    const newEntries = [];
    for(const { l, f } of targets){
      const fileKey = `${l.subjectName}::${l.id}::${f.name}`;
      try{
        const fileObj = await f.handle.getFile();
        const cached = await this.getCached(fileKey);
        if(cached && cached.mtime === fileObj.lastModified){
          newEntries.push(cached);
          continue;
        }
        await ensurePdfJs();
        const buf = await fileObj.arrayBuffer();
        const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
        const pages = [];
        for(let p=1; p<=pdf.numPages; p++){
          const page = await pdf.getPage(p);
          const tc = await page.getTextContent();
          pages.push({ page: p, text: tc.items.map(it=>it.str).join(' ') });
        }
        const entry = { fileKey, subjectName:l.subjectName, lessonId:l.id, lessonNumber:l.number, fileName:f.name, pages, mtime: fileObj.lastModified };
        await this.putCached(entry);
        newEntries.push(entry);
      }catch(err){
        console.warn('[PdfIndex] impossibile indicizzare', f.name, err);
      }
    }
    this.entries = newEntries;
    this.ready = true;
    this.building = false;
  },
  invalidate(){ this.ready = false; this.build(); },
  async ensureFresh(){ if(!this.ready && !this.building) await this.build(); },

  search(query){
    const q = (query||'').trim().toLowerCase();
    if(!q) return [];
    const out = [];
    this.entries.forEach(entry=>{
      entry.pages.forEach(pg=>{
        const lower = pg.text.toLowerCase();
        const idx = lower.indexOf(q);
        if(idx === -1) return;
        const start = Math.max(0, idx-60), end = Math.min(lower.length, idx+q.length+60);
        const snippet = (start>0?'…':'') + pg.text.slice(start,end).replace(/\s+/g,' ') + (end<lower.length?'…':'');
        out.push({ subjectName: entry.subjectName, lessonId: entry.lessonId, lessonNumber: entry.lessonNumber, fileName: entry.fileName, page: pg.page, snippet });
      });
    });
    return out;
  },
  getContext(subjectName, lessonId, fileName, page){
    const entry = this.entries.find(e=>e.subjectName===subjectName && e.lessonId===lessonId && e.fileName===fileName);
    if(!entry) return null;
    const pg = entry.pages.find(p=>p.page===page);
    return pg ? pg.text : null;
  }
};

/* ============================================================
   CRONOLOGIA CHAT (IndexedDB, solo locale)
   ============================================================ */
const ChatHistoryStore = {
  dbPromise: null,
  db(){
    if(this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject)=>{
      const req = indexedDB.open('uninotes-chats', 1);
      req.onupgradeneeded = () => { req.result.createObjectStore('conversations', { keyPath:'id' }); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.dbPromise;
  },
  async list(){
    const db = await this.db();
    return new Promise((res,rej)=>{
      const tx = db.transaction('conversations','readonly');
      const req = tx.objectStore('conversations').getAll();
      req.onsuccess = () => res((req.result||[]).sort((a,b)=>b.updatedAt-a.updatedAt));
      req.onerror = () => rej(req.error);
    });
  },
  async save(convo){
    const db = await this.db();
    return new Promise((res,rej)=>{
      const tx = db.transaction('conversations','readwrite');
      tx.objectStore('conversations').put(convo);
      tx.oncomplete = () => res(convo);
      tx.onerror = () => rej(tx.error);
    });
  },
  async delete(id){
    const db = await this.db();
    const tx = db.transaction('conversations','readwrite');
    tx.objectStore('conversations').delete(id);
  }
};

/* ============================================================
   HELPER FILESYSTEM CONDIVISI (riusano FileSystemManager/LibraryScanner)
   ============================================================ */
function resolveFileInLesson(lesson, fileName){
  if(lesson.mainFile && lesson.mainFile.name === fileName) return { file: lesson.mainFile, source: 'mainFile' };
  const other = (lesson.otherRootFiles||[]).find(f=>f.name===fileName);
  if(other) return { file: other, source: 'root' };
  for(const role in lesson.files){
    const f = (lesson.files[role]||[]).find(x=>x.name===fileName);
    if(f) return { file: f, source: role };
  }
  return null;
}

async function getParentDirHandle(lesson, file, source){
  if(source === 'mainFile' || source === 'root' || !file.folder) return lesson.handle;
  const match = (lesson.subfolders||[]).find(sf => sf.folderPath===file.folder || sf.name===file.folder || (RAW_FOLDER_NAME+'/'+sf.name)===file.folder);
  if(match) return match.handle;
  const roleKey = Object.keys(CATEGORY_FOLDERS).find(k => CATEGORY_FOLDERS[k] === file.folder);
  if(roleKey) return await LibraryScanner.getOrCreateCategoryFolder(lesson, roleKey);
  return await LibraryScanner.getRawFolder(lesson);
}

/* ============================================================
   UNI NOTES API — livello di servizio condiviso tra UI e AI.
   Chiama SEMPRE FileSystemManager/LibraryScanner esistenti: qui
   non viene reimplementata alcuna logica di basso livello.
   ============================================================ */
const UniNotesAPI = {
  subjects: {
    list(){
      return AppState.library.subjects.map(s=>({
        name: s.name, docente: s.docente, codice: s.codice, aula: s.aula,
        lessonCount: s.lessons.length, stats: subjectStats(s)
      }));
    },
    async create({ name, docente='', codice='', aula='' }){
      if(!name || !name.trim()) throw new Error('Nome materia mancante.');
      name = name.trim();
      if(findSubject(name)) throw new Error('Esiste già una materia chiamata "'+name+'".');
      if(!AppState.dirHandle) throw new Error('Nessuna cartella collegata a Uni Notes.');
      const handle = await FileSystemManager.createSubDir(AppState.dirHandle, name);
      const meta = { docente, codice, aula };
      const metaHandle = await FileSystemManager.getOrCreateFile(handle, '.subject.json');
      await FileSystemManager.writeTextFile(metaHandle, JSON.stringify(meta, null, 2));
      const subject = { id:'subj_'+name, name, handle, docente, codice, aula, color: pickColor(name), lessons: [] };
      AppState.library.subjects.push(subject);
      AppState.library.subjects.sort((a,b)=>a.name.localeCompare(b.name,'it'));
      AppState.logActivity(name, 'Materia creata (AI)');
      return subject;
    },
    async update({ subjectName, changes={} }){
      const s = findSubject(subjectName);
      if(!s) throw new Error('Materia non trovata: '+subjectName);
      Object.assign(s, changes);
      const metaHandle = await FileSystemManager.getOrCreateFile(s.handle, '.subject.json');
      let existing = {}; try{ existing = JSON.parse(await FileSystemManager.readTextFile(metaHandle)); }catch(e){}
      Object.assign(existing, { docente: s.docente, codice: s.codice, aula: s.aula, color: s.color });
      await FileSystemManager.writeTextFile(metaHandle, JSON.stringify(existing, null, 2));
      AppState.logActivity(subjectName, 'Materia modificata (AI)');
      return s;
    },
    async delete({ subjectName }){
      const s = findSubject(subjectName);
      if(!s) throw new Error('Materia non trovata: '+subjectName);
      await FileSystemManager.deleteEntry(AppState.dirHandle, s.name);
      AppState.library.subjects = AppState.library.subjects.filter(x=>x.name!==subjectName);
      AppState.logActivity(subjectName, 'Materia eliminata (AI)');
      return true;
    }
  },

  lessons: {
    async create({ subjectName, number=null, date=null, title='', docente='', tags=[], notes='' }){
      const s = findSubject(subjectName);
      if(!s) throw new Error('Materia non trovata: '+subjectName);
      const d = date ? new Date(date) : new Date();
      const n = number != null ? number : (s.lessons.reduce((mx,l)=>Math.max(mx,l.number||0),0) + 1);
      const folderName = `Lezione ${String(n).padStart(2,'0')} - ${fmtDateShort(d)}${title ? ' - '+title : ''}`;
      const handle = await FileSystemManager.createSubDir(s.handle, folderName);
      const metaHandle = await FileSystemManager.getOrCreateFile(handle, '.lesson.json');
      const meta = { number:n, date: d.toISOString(), title, docente, tags, notes };
      await FileSystemManager.writeTextFile(metaHandle, JSON.stringify(meta, null, 2));
      const lesson = {
        id: 'lesson_'+subjectName+'_'+folderName, folderName, handle, subjectName,
        number:n, date:d, title, docente, tags, notes, pinned:false, order:null,
        files:{}, subfolders:[], mainFile:null, otherRootFiles:[], rawFolderHandle:null
      };
      s.lessons.push(lesson);
      s.lessons.sort((a,b)=>(a.number||0)-(b.number||0));
      AppState.logActivity(subjectName, `Lezione "${title||folderName}" creata (AI)`);
      return lesson;
    },
    async update({ subjectName, lessonId, changes={} }){
      const lesson = findLesson(subjectName, lessonId);
      if(!lesson) throw new Error('Lezione non trovata.');
      const c = Object.assign({}, changes);
      if(c.date) c.date = new Date(c.date);
      Object.assign(lesson, c);
      const metaHandle = await FileSystemManager.getOrCreateFile(lesson.handle, '.lesson.json');
      let existing = {}; try{ existing = JSON.parse(await FileSystemManager.readTextFile(metaHandle)); }catch(e){}
      Object.assign(existing, { number: lesson.number, date: lesson.date ? lesson.date.toISOString() : null, title: lesson.title, docente: lesson.docente, tags: lesson.tags, notes: lesson.notes });
      await FileSystemManager.writeTextFile(metaHandle, JSON.stringify(existing, null, 2));
      AppState.logActivity(subjectName, `Lezione modificata (AI): ${lesson.title||lesson.folderName}`);
      return lesson;
    },
    async delete({ subjectName, lessonId }){
      const s = findSubject(subjectName);
      const lesson = findLesson(subjectName, lessonId);
      if(!s || !lesson) throw new Error('Lezione non trovata.');
      await FileSystemManager.deleteEntry(s.handle, lesson.folderName);
      s.lessons = s.lessons.filter(l=>l.id!==lessonId);
      AppState.logActivity(subjectName, 'Lezione eliminata (AI)');
      return true;
    },
    async togglePin({ subjectName, lessonId }){
      const lesson = findLesson(subjectName, lessonId);
      if(!lesson) throw new Error('Lezione non trovata.');
      return await LibraryScanner.togglePinned(lesson);
    }
  },

  files: {
    resolve(lesson, fileName){ return resolveFileInLesson(lesson, fileName); },
    async read({ subjectName, lessonId, fileName }){
      const lesson = findLesson(subjectName, lessonId);
      if(!lesson) throw new Error('Lezione non trovata.');
      const found = resolveFileInLesson(lesson, fileName);
      if(!found) throw new Error('File non trovato: '+fileName);
      const ext = extOf(fileName);
      if(ext === 'pdf') throw new Error('Per i PDF usa search_pdf_content o get_pdf_context (indicano anche la pagina).');
      if(ext === 'docx') throw new Error('La lettura diretta di un DOCX non è supportata dai tool AI: apri il file nell\'editor per consultarlo.');
      return await FileSystemManager.readTextFile(found.file.handle);
    },
    async write({ subjectName, lessonId, fileName, content }){
      const lesson = findLesson(subjectName, lessonId);
      if(!lesson) throw new Error('Lezione non trovata.');
      const found = resolveFileInLesson(lesson, fileName);
      if(!found) return await this.create({ subjectName, lessonId, fileName, content });
      await FileSystemManager.writeTextFile(found.file.handle, content);
      AppState.logActivity(subjectName, `"${fileName}" aggiornato (AI)`);
      return true;
    },
    async create({ subjectName, lessonId, fileName, content='' }){
      const lesson = findLesson(subjectName, lessonId);
      if(!lesson) throw new Error('Lezione non trovata.');
      const kind = kindOf(fileName);
      const role = LibraryScanner.classifyFile(fileName, kind);
      const destFolder = await LibraryScanner.getOrCreateCategoryFolder(lesson, role);
      const handle = await FileSystemManager.getOrCreateFile(destFolder, fileName);
      await FileSystemManager.writeTextFile(handle, content || '');
      lesson.files[role] = lesson.files[role] || [];
      const idx = lesson.files[role].findIndex(f=>f.name===fileName);
      const entry = { name: fileName, handle, kind, folder: CATEGORY_FOLDERS[role] ? (RAW_FOLDER_NAME+'/'+CATEGORY_FOLDERS[role]) : RAW_FOLDER_NAME };
      if(idx>=0) lesson.files[role][idx] = entry; else lesson.files[role].push(entry);
      AppState.logActivity(subjectName, `"${fileName}" creato (AI)`);
      ContentIndex.invalidate();
      return entry;
    },
    async rename({ subjectName, lessonId, fileName, newName }){
      const lesson = findLesson(subjectName, lessonId);
      if(!lesson) throw new Error('Lezione non trovata.');
      const found = resolveFileInLesson(lesson, fileName);
      if(!found) throw new Error('File non trovato: '+fileName);
      const parent = await getParentDirHandle(lesson, found.file, found.source);
      await FileSystemManager.renameFile(parent, fileName, newName);
      found.file.name = newName;
      found.file.handle = await parent.getFileHandle(newName);
      AppState.logActivity(subjectName, `"${fileName}" rinominato in "${newName}" (AI)`);
      ContentIndex.invalidate();
      return true;
    },
    async delete({ subjectName, lessonId, fileName }){
      const lesson = findLesson(subjectName, lessonId);
      if(!lesson) throw new Error('Lezione non trovata.');
      const found = resolveFileInLesson(lesson, fileName);
      if(!found) throw new Error('File non trovato: '+fileName);
      const parent = await getParentDirHandle(lesson, found.file, found.source);
      await FileSystemManager.deleteEntry(parent, fileName);
      if(found.source === 'mainFile') lesson.mainFile = null;
      else if(found.source === 'root') lesson.otherRootFiles = (lesson.otherRootFiles||[]).filter(f=>f.name!==fileName);
      else lesson.files[found.source] = (lesson.files[found.source]||[]).filter(f=>f.name!==fileName);
      AppState.logActivity(subjectName, `"${fileName}" eliminato (AI)`);
      ContentIndex.invalidate();
      return true;
    },
    async moveToFolder({ subjectName, lessonId, fileName, folderName }){
      const lesson = findLesson(subjectName, lessonId);
      if(!lesson) throw new Error('Lezione non trovata.');
      const found = resolveFileInLesson(lesson, fileName);
      if(!found) throw new Error('File non trovato: '+fileName);
      const oldParent = await getParentDirHandle(lesson, found.file, found.source);
      const raw = await LibraryScanner.getRawFolder(lesson);
      let sub = (lesson.subfolders||[]).find(sf=>sf.name===folderName);
      let newFolderHandle;
      if(sub) newFolderHandle = sub.handle;
      else{
        newFolderHandle = await FileSystemManager.createSubDir(raw, folderName);
        lesson.subfolders.push({ name: folderName, handle: newFolderHandle, role:null, folderPath: RAW_FOLDER_NAME+'/'+folderName });
      }
      const fileObj = await found.file.handle.getFile();
      const newHandle = await FileSystemManager.copyFileInto(newFolderHandle, fileObj, fileName);
      await FileSystemManager.deleteEntry(oldParent, fileName);
      if(found.source === 'mainFile') lesson.mainFile = null;
      else if(found.source === 'root') lesson.otherRootFiles = (lesson.otherRootFiles||[]).filter(f=>f.name!==fileName);
      else lesson.files[found.source] = (lesson.files[found.source]||[]).filter(f=>f.name!==fileName);
      const kind = kindOf(fileName);
      const role = LibraryScanner.classifyFile(fileName, kind);
      lesson.files[role] = lesson.files[role] || [];
      lesson.files[role].push({ name: fileName, handle: newHandle, kind, folder: RAW_FOLDER_NAME+'/'+folderName });
      AppState.logActivity(subjectName, `"${fileName}" spostato in "${folderName}" (AI)`);
      ContentIndex.invalidate();
      return true;
    },
    async setMain({ subjectName, lessonId, fileName }){
      const lesson = findLesson(subjectName, lessonId);
      if(!lesson) throw new Error('Lezione non trovata.');
      const found = resolveFileInLesson(lesson, fileName);
      if(!found) throw new Error('Il documento principale può essere impostato solo tra i file sciolti nella root della lezione: "'+fileName+'" non è tra questi.');
      await LibraryScanner.setMainFile(lesson, found.file);
      AppState.logActivity(subjectName, `Documento principale impostato (AI): ${fileName}`);
      return true;
    }
  },

  search: {
    fullText(query){
      const r = SearchEngine.search(query);
      const contentHits = ContentIndex.ready ? ContentIndex.search(query) : [];
      const out = [];
      r.lessons.slice(0,10).forEach(({item})=>out.push({ type:'lesson', subjectName:item.subjectName, lessonId:item.id, lessonNumber:item.number, title:item.title||item.folderName }));
      r.files.slice(0,10).forEach(({item,lesson})=>out.push({ type:'file', subjectName:lesson.subjectName, lessonId:lesson.id, lessonNumber:lesson.number, fileName:item.name }));
      contentHits.slice(0,10).forEach(ch=>out.push({ type:'content', subjectName:ch.lesson.subjectName, lessonId:ch.lesson.id, lessonNumber:ch.lesson.number, fileName:ch.file.name, snippet:ch.snippet }));
      return out;
    },
    pdf(query){ return PdfIndex.ready ? PdfIndex.search(query) : []; }
  },

  ui: {
    navigate(page, params){ Router.go(page, params||{}); },
    openSubject(subjectName){ Router.go('subject', { subjectName }); },
    openLesson(subjectName, lessonId){ Router.go('lesson', { subjectName, lessonId }); },
    openFile(subjectName, lessonId, fileName, page){
      const lesson = findLesson(subjectName, lessonId);
      if(!lesson) return;
      const found = resolveFileInLesson(lesson, fileName);
      if(!found) return;
      if(found.file.kind === 'pdf' && page) PDFViewerModal.open(lesson, found.file, { page });
      else FileViewer.open(lesson, found.file);
    }
  }
};
window.UniNotesAPI = UniNotesAPI; // esposta anche a window per debug/console

/* ============================================================
   TOOL REGISTRY — unica fonte di verità per ciò che l'AI può fare.
   Ogni tool ritorna sempre { ok, data, summary, error }.
   ============================================================ */
function makeOk(data, summary){ return { ok:true, data, summary, error:null }; }
function makeErr(message, code){ return { ok:false, data:null, summary:message, error:{ code: code||'error', message } }; }

const AITools = {
  list_subjects: {
    description: 'Elenca tutte le materie della libreria, con numero di lezioni e statistiche di completamento.',
    parameters: { type:'object', properties:{}, required:[] },
    async execute(){ return makeOk(UniNotesAPI.subjects.list(), 'Materie elencate.'); }
  },
  get_subject: {
    description: 'Ottieni i dettagli di una materia, incluso l\'elenco delle sue lezioni con id, numero, titolo, data e stato.',
    parameters: { type:'object', properties:{ subjectName:{type:'string'} }, required:['subjectName'] },
    async execute({ subjectName }){
      const s = findSubject(subjectName);
      if(!s) return makeErr('Materia non trovata: '+subjectName, 'not_found');
      return makeOk({
        name:s.name, docente:s.docente, codice:s.codice, aula:s.aula,
        lessons: s.lessons.map(l=>({ id:l.id, number:l.number, title:l.title, date:l.date?l.date.toISOString():null, status:lessonStatus(l), pinned:l.pinned }))
      }, 'Dettagli materia "'+s.name+'".');
    }
  },
  search_content: {
    description: 'Cerca un testo nei nomi di materie/lezioni/file e nel contenuto dei file testuali (txt, md, tex, csv, json) e dei PDF già indicizzati. USA SEMPRE questo tool prima di rispondere a domande sul contenuto delle lezioni: non inventare mai risposte.',
    parameters: { type:'object', properties:{ query:{type:'string'} }, required:['query'] },
    async execute({ query }){
      await PdfIndex.ensureFresh();
      const text = UniNotesAPI.search.fullText(query);
      const pdf = UniNotesAPI.search.pdf(query).map(r=>Object.assign({ type:'pdf' }, r));
      const all = [...text, ...pdf];
      if(!all.length) return makeOk([], 'Nessun risultato trovato per "'+query+'".');
      return makeOk(all.slice(0,25), all.length+' risultati trovati.');
    }
  },
  search_pdf_content: {
    description: 'Cerca un testo specificamente dentro i PDF indicizzati: restituisce materia, lezione, nome file e numero di pagina esatto di ogni corrispondenza.',
    parameters: { type:'object', properties:{ query:{type:'string'} }, required:['query'] },
    async execute({ query }){
      await PdfIndex.ensureFresh();
      const r = UniNotesAPI.search.pdf(query);
      return makeOk(r.slice(0,25), r.length ? (r.length+' corrispondenze trovate nei PDF.') : 'Nessuna corrispondenza nei PDF.');
    }
  },
  get_pdf_context: {
    description: 'Ottieni il testo completo di una pagina specifica di un PDF già indicizzato, per leggere il contesto attorno a un risultato di ricerca.',
    parameters: { type:'object', properties:{ subjectName:{type:'string'}, lessonId:{type:'string'}, fileName:{type:'string'}, page:{type:'number'} }, required:['subjectName','lessonId','fileName','page'] },
    async execute({ subjectName, lessonId, fileName, page }){
      await PdfIndex.ensureFresh();
      const text = PdfIndex.getContext(subjectName, lessonId, fileName, page);
      if(text == null) return makeErr('Pagina non trovata o PDF non ancora indicizzato.', 'not_found');
      return makeOk({ text }, 'Contenuto della pagina '+page+'.');
    }
  },
  create_subject: {
    description: 'Crea una nuova materia (cartella) nella libreria.',
    parameters: { type:'object', properties:{ name:{type:'string'}, docente:{type:'string'}, codice:{type:'string'}, aula:{type:'string'} }, required:['name'] },
    async execute(args){ const s = await UniNotesAPI.subjects.create(args); Router.render(); return makeOk({ name:s.name }, 'Materia "'+s.name+'" creata.'); }
  },
  update_subject: {
    description: 'Modifica i metadati di una materia esistente (docente, codice corso, aula).',
    parameters: { type:'object', properties:{ subjectName:{type:'string'}, docente:{type:'string'}, codice:{type:'string'}, aula:{type:'string'} }, required:['subjectName'] },
    async execute({ subjectName, ...changes }){ await UniNotesAPI.subjects.update({ subjectName, changes }); Router.render(); return makeOk(null, 'Materia aggiornata.'); }
  },
  delete_subject: {
    description: 'Elimina definitivamente una materia e tutto il suo contenuto. Operazione DISTRUTTIVA e irreversibile.',
    destructive: true,
    parameters: { type:'object', properties:{ subjectName:{type:'string'} }, required:['subjectName'] },
    async execute({ subjectName }){ await UniNotesAPI.subjects.delete({ subjectName }); Router.go('subjects'); return makeOk(null, 'Materia "'+subjectName+'" eliminata.'); }
  },
  create_lesson: {
    description: 'Crea una nuova lezione dentro una materia esistente.',
    parameters: { type:'object', properties:{ subjectName:{type:'string'}, number:{type:'number'}, date:{type:'string'}, title:{type:'string'}, docente:{type:'string'}, tags:{type:'array', items:{type:'string'}}, notes:{type:'string'} }, required:['subjectName'] },
    async execute(args){ const lesson = await UniNotesAPI.lessons.create(args); Router.render(); return makeOk({ lessonId:lesson.id, folderName:lesson.folderName }, 'Lezione creata: '+lesson.folderName+'.'); }
  },
  update_lesson: {
    description: 'Modifica i metadati di una lezione esistente (numero, data, titolo, docente, tag, note).',
    parameters: { type:'object', properties:{ subjectName:{type:'string'}, lessonId:{type:'string'}, number:{type:'number'}, date:{type:'string'}, title:{type:'string'}, docente:{type:'string'}, tags:{type:'array', items:{type:'string'}}, notes:{type:'string'} }, required:['subjectName','lessonId'] },
    async execute({ subjectName, lessonId, ...changes }){ await UniNotesAPI.lessons.update({ subjectName, lessonId, changes }); Router.render(); return makeOk(null, 'Lezione aggiornata.'); }
  },
  delete_lesson: {
    description: 'Elimina definitivamente una lezione e tutti i suoi file. Operazione DISTRUTTIVA e irreversibile.',
    destructive: true,
    parameters: { type:'object', properties:{ subjectName:{type:'string'}, lessonId:{type:'string'} }, required:['subjectName','lessonId'] },
    async execute({ subjectName, lessonId }){ await UniNotesAPI.lessons.delete({ subjectName, lessonId }); Router.go('subject', { subjectName }); return makeOk(null, 'Lezione eliminata.'); }
  },
  toggle_lesson_pin: {
    description: 'Aggiunge o rimuove una lezione dai preferiti.',
    parameters: { type:'object', properties:{ subjectName:{type:'string'}, lessonId:{type:'string'} }, required:['subjectName','lessonId'] },
    async execute({ subjectName, lessonId }){ const pinned = await UniNotesAPI.lessons.togglePin({ subjectName, lessonId }); Router.render(); return makeOk({ pinned }, pinned ? 'Lezione aggiunta ai preferiti.' : 'Lezione rimossa dai preferiti.'); }
  },
  list_files: {
    description: 'Elenca tutti i file di una lezione (documento principale, file sciolti, materiale grezzo).',
    parameters: { type:'object', properties:{ subjectName:{type:'string'}, lessonId:{type:'string'} }, required:['subjectName','lessonId'] },
    async execute({ subjectName, lessonId }){
      const lesson = findLesson(subjectName, lessonId);
      if(!lesson) return makeErr('Lezione non trovata.', 'not_found');
      const all = [];
      if(lesson.mainFile) all.push({ name:lesson.mainFile.name, kind:lesson.mainFile.kind, role:'documento principale' });
      (lesson.otherRootFiles||[]).forEach(f=>all.push({ name:f.name, kind:f.kind, role:'root' }));
      Object.entries(lesson.files).forEach(([role,arr])=>arr.forEach(f=>all.push({ name:f.name, kind:f.kind, role })));
      return makeOk(all, all.length+' file trovati.');
    }
  },
  read_file: {
    description: 'Legge il contenuto testuale di un file (txt, md, tex, csv, json). Non funziona per PDF (usa search_pdf_content/get_pdf_context) o DOCX.',
    parameters: { type:'object', properties:{ subjectName:{type:'string'}, lessonId:{type:'string'}, fileName:{type:'string'} }, required:['subjectName','lessonId','fileName'] },
    async execute(args){ const content = await UniNotesAPI.files.read(args); return makeOk({ content }, 'File letto ('+content.length+' caratteri).'); }
  },
  write_file: {
    description: 'Scrive/sostituisce il contenuto di un file testuale esistente, oppure lo crea se non esiste ancora.',
    parameters: { type:'object', properties:{ subjectName:{type:'string'}, lessonId:{type:'string'}, fileName:{type:'string'}, content:{type:'string'} }, required:['subjectName','lessonId','fileName','content'] },
    async execute(args){ await UniNotesAPI.files.write(args); ContentIndex.invalidate(); Router.render(); return makeOk(null, 'File "'+args.fileName+'" salvato.'); }
  },
  create_file: {
    description: 'Crea un nuovo file (appunto/nota testuale) dentro una lezione, con contenuto iniziale opzionale.',
    parameters: { type:'object', properties:{ subjectName:{type:'string'}, lessonId:{type:'string'}, fileName:{type:'string'}, content:{type:'string'} }, required:['subjectName','lessonId','fileName'] },
    async execute(args){ const entry = await UniNotesAPI.files.create(args); Router.render(); return makeOk({ fileName:entry.name }, 'File "'+entry.name+'" creato.'); }
  },
  rename_file: {
    description: 'Rinomina un file esistente all\'interno di una lezione.',
    parameters: { type:'object', properties:{ subjectName:{type:'string'}, lessonId:{type:'string'}, fileName:{type:'string'}, newName:{type:'string'} }, required:['subjectName','lessonId','fileName','newName'] },
    async execute(args){ await UniNotesAPI.files.rename(args); Router.render(); return makeOk(null, 'File rinominato in "'+args.newName+'".'); }
  },
  move_file: {
    description: 'Sposta un file in una sottocartella dentro "Materiale grezzo" di una lezione, creandola se non esiste.',
    parameters: { type:'object', properties:{ subjectName:{type:'string'}, lessonId:{type:'string'}, fileName:{type:'string'}, folderName:{type:'string'} }, required:['subjectName','lessonId','fileName','folderName'] },
    async execute(args){ await UniNotesAPI.files.moveToFolder(args); Router.render(); return makeOk(null, 'File spostato in "'+args.folderName+'".'); }
  },
  delete_file: {
    description: 'Elimina definitivamente un file. Operazione DISTRUTTIVA e irreversibile.',
    destructive: true,
    parameters: { type:'object', properties:{ subjectName:{type:'string'}, lessonId:{type:'string'}, fileName:{type:'string'} }, required:['subjectName','lessonId','fileName'] },
    async execute(args){ await UniNotesAPI.files.delete(args); Router.render(); return makeOk(null, 'File "'+args.fileName+'" eliminato.'); }
  },
  set_main_file: {
    description: 'Imposta come documento principale della lezione un file già presente nella root della lezione.',
    parameters: { type:'object', properties:{ subjectName:{type:'string'}, lessonId:{type:'string'}, fileName:{type:'string'} }, required:['subjectName','lessonId','fileName'] },
    async execute(args){ await UniNotesAPI.files.setMain(args); Router.render(); return makeOk(null, 'Documento principale impostato: '+args.fileName+'.'); }
  },
  refresh_library: {
    description: 'Risincronizza la libreria con il contenuto reale della cartella e reindicizza i contenuti (testo e PDF).',
    parameters: { type:'object', properties:{}, required:[] },
    async execute(){ await Router.resync(); PdfIndex.invalidate(); return makeOk(null, 'Libreria sincronizzata.'); }
  },
  open_subject: {
    description: 'Apre nell\'interfaccia la pagina di una materia.',
    parameters: { type:'object', properties:{ subjectName:{type:'string'} }, required:['subjectName'] },
    async execute({ subjectName }){ UniNotesAPI.ui.openSubject(subjectName); return makeOk(null, 'Materia aperta nell\'interfaccia.'); }
  },
  open_lesson: {
    description: 'Apre nell\'interfaccia la pagina di una lezione.',
    parameters: { type:'object', properties:{ subjectName:{type:'string'}, lessonId:{type:'string'} }, required:['subjectName','lessonId'] },
    async execute({ subjectName, lessonId }){ UniNotesAPI.ui.openLesson(subjectName, lessonId); return makeOk(null, 'Lezione aperta nell\'interfaccia.'); }
  },
  open_file: {
    description: 'Apre un file nell\'interfaccia. Se è un PDF e viene indicata una pagina, il lettore si posiziona automaticamente su quella pagina.',
    parameters: { type:'object', properties:{ subjectName:{type:'string'}, lessonId:{type:'string'}, fileName:{type:'string'}, page:{type:'number'} }, required:['subjectName','lessonId','fileName'] },
    async execute({ subjectName, lessonId, fileName, page }){ UniNotesAPI.ui.openFile(subjectName, lessonId, fileName, page); return makeOk(null, 'File aperto'+(page?' a pagina '+page:'')+'.'); }
  },
  prepare_latex: {
    description: 'Compone il materiale pronto per l\'AI (prompt della materia + appunti + trascrizione) di una lezione, come fa il pulsante "Prepara LaTeX".',
    parameters: { type:'object', properties:{ subjectName:{type:'string'}, lessonId:{type:'string'} }, required:['subjectName','lessonId'] },
    async execute({ subjectName, lessonId }){
      const lesson = findLesson(subjectName, lessonId);
      if(!lesson) return makeErr('Lezione non trovata.', 'not_found');
      const subject = findSubject(subjectName);
      const promptText = await PromptsPage.loadPrompt(subject, 'principale');
      const appuntiFile = (lesson.files.appunti||[])[0];
      const trascrizioneFile = (lesson.files.trascrizione||[])[0];
      let appuntiText='', trascrizioneText='';
      try{ if(appuntiFile) appuntiText = await FileSystemManager.readTextFile(appuntiFile.handle); }catch(e){}
      try{ if(trascrizioneFile) trascrizioneText = await FileSystemManager.readTextFile(trascrizioneFile.handle); }catch(e){}
      return makeOk({ promptText, appuntiText, trascrizioneText }, 'Materiale composto.');
    }
  }
};
window.AITools = AITools;

function getOllamaToolsSchema(){
  return Object.entries(AITools).map(([name, t]) => ({
    type: 'function',
    function: { name, description: t.description, parameters: t.parameters }
  }));
}

/* ============================================================
   CONFERMA OPERAZIONI DISTRUTTIVE
   ============================================================ */
const AIConfirmGate = {
  confirm(message){
    return new Promise(resolve=>{
      const m = ModalManager.open(`
        <div class="modal-header"><div class="modal-title">${icon('alert',16)} Conferma richiesta</div></div>
        <div class="modal-body"><div style="font-size:13.5px; white-space:pre-wrap; line-height:1.6;">${esc(message)}</div></div>
        <div class="modal-footer"><button class="btn" id="ai-conf-no">Annulla</button><button class="btn btn-danger" id="ai-conf-yes">Conferma</button></div>
      `);
      m.querySelector('#ai-conf-no').onclick = () => { ModalManager.close(); resolve(false); };
      m.querySelector('#ai-conf-yes').onclick = () => { ModalManager.close(); resolve(true); };
    });
  }
};

/* ============================================================
   SYSTEM PROMPT
   ============================================================ */
const AI_SYSTEM_PROMPT = `Sei l'agente AI integrato in Uni Notes, un'app locale per organizzare materie universitarie, lezioni e materiali di studio (registrazioni, trascrizioni, appunti, PDF, LaTeX, documenti Word).

Regole fondamentali:
1. Usa SEMPRE i tool per ottenere informazioni reali sulla libreria dell'utente: non inventare mai materie, lezioni, file, pagine o contenuti che non provengono da un risultato di un tool.
2. Prima cerca (search_content e/o search_pdf_content), poi rispondi. Se non trovi nulla, dillo chiaramente invece di inventare.
3. Per i PDF cita sempre il numero di pagina preciso restituito da search_pdf_content o get_pdf_context.
4. Dopo un'operazione di scrittura/creazione/modifica/eliminazione, il risultato del tool (ok:true/false) è l'unica verità: se ok è false, spiega il problema e NON dichiarare di aver completato l'operazione.
5. Se una richiesta è ambigua, usa i tool disponibili (list_subjects, get_subject, list_files) per risolverla nel modo più ragionevole prima di chiedere chiarimenti.
6. Usa più tool in sequenza quando serve per completare richieste complesse (es. crea materia → crea lezione → crea file → scrivi contenuto).
7. Quando citi una fonte locale nella risposta, indica sempre materia, numero di lezione e nome file (e pagina se è un PDF).
8. Puoi chiamare SOLO i tool messi a disposizione: non proporre né eseguire codice arbitrario.
9. Rispondi sempre in italiano, in modo chiaro, diretto e conciso.`;

/* ============================================================
   AGENT LOOP
   ============================================================ */
const AIAgent = {
  running: false,
  controller: null,

  tryParseFallbackToolCall(content){
    if(!content) return null;
    const match = content.match(/\{[\s\S]*\}/);
    if(!match) return null;
    try{
      const obj = JSON.parse(match[0]);
      if(obj && typeof obj.tool === 'string' && AITools[obj.tool]) return obj;
    }catch(e){}
    return null;
  },

  async run(conversationMessages, { onToken, onStep, maxSteps=12 } = {}){
    this.running = true;
    this.controller = new AbortController();
    const tools = getOllamaToolsSchema();
    let messages = conversationMessages.slice();
    let steps = 0;
    try{
      while(steps < maxSteps){
        steps++;
        let assistantMsg;
        try{
          assistantMsg = await OllamaManager.chat({ messages, tools, signal: this.controller.signal, onToken });
        }catch(err){
          if(err.name === 'AbortError') return { aborted:true, messages };
          throw err;
        }
        messages.push({ role:'assistant', content: assistantMsg.content || '', tool_calls: assistantMsg.tool_calls });

        let toolCalls = assistantMsg.tool_calls;
        if(!toolCalls || !toolCalls.length){
          const fallback = this.tryParseFallbackToolCall(assistantMsg.content);
          if(fallback) toolCalls = [{ function: { name: fallback.tool, arguments: fallback.arguments || fallback.args || {} } }];
        }
        if(!toolCalls || !toolCalls.length){
          return { finalMessage: assistantMsg.content || '', messages };
        }

        for(const call of toolCalls){
          const name = (call.function && call.function.name) || call.name;
          let args = (call.function && call.function.arguments) || call.arguments || {};
          if(typeof args === 'string'){ try{ args = JSON.parse(args); }catch(e){ args = {}; } }
          const tool = AITools[name];
          if(!tool){
            const res = makeErr('Tool sconosciuto: '+name, 'unknown_tool');
            messages.push({ role:'tool', content: JSON.stringify(res) });
            if(onStep) onStep({ name, args, result:res, status:'done' });
            continue;
          }
          if(onStep) onStep({ name, args, status:'running' });
          if(tool.destructive && AIPermissions.mode() !== 'autonomous'){
            const confirmed = await AIConfirmGate.confirm(
              'L\'assistente vuole eseguire un\'operazione irreversibile:\n\n' + tool.description + '\n\nParametri: ' + JSON.stringify(args) + '\n\nConfermi?'
            );
            if(!confirmed){
              const res = makeErr('Operazione annullata dall\'utente.', 'user_cancelled');
              messages.push({ role:'tool', content: JSON.stringify(res) });
              if(onStep) onStep({ name, args, result:res, status:'cancelled' });
              continue;
            }
          }
          let result;
          try{ result = await tool.execute(args || {}); }
          catch(err){ result = makeErr(err.message || String(err)); }
          messages.push({ role:'tool', content: JSON.stringify(result) });
          if(onStep) onStep({ name, args, result, status:'done' });
        }
      }
      return { finalMessage: 'Ho raggiunto il numero massimo di passaggi consentiti senza completare la richiesta. Prova a essere più specifico o a dividerla in più richieste.', messages };
    } finally {
      this.running = false;
    }
  },
  stop(){ if(this.controller) this.controller.abort(); }
};
window.AIAgent = AIAgent;

/* ============================================================
   PANNELLO CHAT AI
   ============================================================ */
const AI_STEP_LABELS = {
  list_subjects:'Elenco le materie', get_subject:'Controllo la materia',
  search_content: a => `Cerco "${(a&&a.query)||''}"`,
  search_pdf_content: a => `Cerco nei PDF "${(a&&a.query)||''}"`,
  get_pdf_context: a => `Leggo pagina ${a&&a.page}`,
  create_subject: a => `Creo la materia "${a&&a.name||''}"`, update_subject:'Modifico la materia',
  delete_subject: a => `Elimino la materia "${a&&a.subjectName||''}"`,
  create_lesson:'Creo la lezione', update_lesson:'Modifico la lezione', delete_lesson:'Elimino la lezione',
  toggle_lesson_pin:'Aggiorno i preferiti', list_files:'Elenco i file',
  read_file: a => `Leggo "${a&&a.fileName||''}"`, write_file: a => `Scrivo "${a&&a.fileName||''}"`,
  create_file: a => `Creo "${a&&a.fileName||''}"`, rename_file: a => `Rinomino "${a&&a.fileName||''}"`,
  move_file: a => `Sposto "${a&&a.fileName||''}"`, delete_file: a => `Elimino "${a&&a.fileName||''}"`,
  set_main_file:'Imposto il documento principale', refresh_library:'Sincronizzo la libreria',
  open_subject:'Apro la materia', open_lesson:'Apro la lezione', open_file:'Apro il file',
  prepare_latex:'Preparo il materiale'
};

const AIPanel = {
  isOpen: false,
  currentChat: null,

  open(){
    this.isOpen = true;
    if(!this.currentChat) this.newChat();
    this.mount();
    document.getElementById('ai-panel').classList.add('open');
    this.refreshStatus();
  },
  close(){ const el = document.getElementById('ai-panel'); if(el) el.classList.remove('open'); this.isOpen = false; },
  toggle(){ this.isOpen ? this.close() : this.open(); },
  newChat(){
    this.currentChat = { id:'chat_'+uid(), title:'Nuova conversazione', createdAt:Date.now(), updatedAt:Date.now(), model: OllamaManager.getModel(), messages: [] };
  },

  mount(){
    const root = document.getElementById('ai-panel');
    root.innerHTML = `
      <div class="ai-header">
        <span class="ai-status-dot" id="ai-status-dot" title="Stato Ollama"></span>
        <b style="font-size:13px;">Assistente Uni Notes</b>
        <div style="flex:1;"></div>
        <select id="ai-model-select" class="btn btn-sm" style="cursor:pointer; max-width:130px;"></select>
        <button class="icon-btn" id="ai-history-btn" title="Cronologia">${icon('clock',15)}</button>
        <button class="icon-btn" id="ai-newchat-btn" title="Nuova conversazione">${icon('plus',15)}</button>
        <button class="icon-btn" id="ai-close-btn" title="Chiudi">${icon('x',15)}</button>
      </div>
      <div class="ai-messages" id="ai-messages"></div>
      <div class="ai-inputbar">
        <textarea id="ai-input" placeholder="Chiedi qualcosa sulla tua libreria…" rows="1"></textarea>
        <button class="btn btn-primary btn-sm" id="ai-send-btn">${icon('send',15)}</button>
      </div>
    `;
    root.querySelector('#ai-close-btn').addEventListener('click', () => this.close());
    root.querySelector('#ai-newchat-btn').addEventListener('click', () => { this.newChat(); this.renderMessages(); });
    root.querySelector('#ai-history-btn').addEventListener('click', () => this.openHistory());
    const input = root.querySelector('#ai-input');
    input.addEventListener('keydown', e => { if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); this.send(); } });
    root.querySelector('#ai-send-btn').addEventListener('click', () => this.send());
    this.populateModelSelect();
    this.renderMessages();
  },

  async refreshStatus(){
    const dot = document.getElementById('ai-status-dot');
    if(!dot) return;
    dot.className = 'ai-status-dot';
    const r = await OllamaManager.testConnection();
    if(r.ok){ dot.classList.add('on'); dot.title = 'Ollama connesso'; }
    else { dot.classList.add('off'); dot.title = 'Ollama non raggiungibile: ' + r.error; }
  },
  async populateModelSelect(){
    const sel = document.getElementById('ai-model-select');
    if(!sel) return;
    sel.innerHTML = `<option>Caricamento…</option>`;
    const r = await OllamaManager.testConnection();
    if(!r.ok){ sel.innerHTML = `<option value="">Non disponibile</option>`; return; }
    const current = OllamaManager.getModel();
    sel.innerHTML = r.models.map(m=>`<option value="${esc(m)}" ${m===current?'selected':''}>${esc(m)}</option>`).join('') || `<option value="">Nessun modello</option>`;
    if(!current && r.models[0]) OllamaManager.setModel(r.models[0]);
    sel.onchange = () => OllamaManager.setModel(sel.value);
  },

  renderMessages(){
    const el = document.getElementById('ai-messages');
    if(!el) return;
    el.innerHTML = this.currentChat.messages.map(m => this.renderMsg(m)).join('');
    el.scrollTop = el.scrollHeight;
    this.bindCitations(el);
  },
  renderMsg(m){
    if(m.role === 'user') return `<div class="ai-msg user">${esc(m.content)}</div>`;
    if(m.role === 'assistant') return `<div class="ai-msg assistant">${esc(m.content)||'<span class=\"muted\">…</span>'}${(m.citations||[]).map(c=>this.renderCitation(c)).join('')}</div>`;
    if(m.role === 'activity') return `<div class="ai-activity">${(m.steps||[]).map(s=>`<div class="ai-activity-step">${s.status==='cancelled'?icon('x',12):s.status==='done'?icon('check',12):icon('clock',12)} ${esc(s.label)}</div>`).join('')}</div>`;
    return '';
  },
  renderCitation(c){
    return `<span class="ai-citation" data-cite='${esc(JSON.stringify(c))}'>${icon('file',11)} ${esc(c.subjectName||'')}${c.lessonNumber!=null?' · Lezione '+esc(String(c.lessonNumber)):''}${c.fileName?' · '+esc(c.fileName):''}${c.page?' · pag. '+c.page:''}</span>`;
  },
  bindCitations(el){
    el.querySelectorAll('[data-cite]').forEach(elm=>{
      elm.addEventListener('click', () => {
        const c = JSON.parse(elm.dataset.cite);
        if(c.fileName) UniNotesAPI.ui.openFile(c.subjectName, c.lessonId, c.fileName, c.page);
      });
    });
  },
  activityLabel(step){
    const l = AI_STEP_LABELS[step.name];
    if(typeof l === 'function') return l(step.args);
    return l || step.name;
  },

  async send(){
    const input = document.getElementById('ai-input');
    if(!input) return;
    const text = input.value.trim();
    if(!text || AIAgent.running) return;
    input.value = '';
    const model = OllamaManager.getModel();
    if(!model){ Toast.error('Seleziona prima un modello Ollama (in alto nel pannello AI o nelle Impostazioni).'); return; }

    this.currentChat.messages.push({ role:'user', content:text });
    this.renderMessages();

    const activityMsg = { role:'activity', steps:[] };
    this.currentChat.messages.push(activityMsg);
    const assistantPlaceholder = { role:'assistant', content:'', citations:[] };
    this.currentChat.messages.push(assistantPlaceholder);
    this.renderMessages();

    const convoForModel = [
      { role:'system', content: AI_SYSTEM_PROMPT },
      ...this.currentChat.messages
        .filter(m => (m.role==='user' || m.role==='assistant') && m !== assistantPlaceholder)
        .map(m => ({ role:m.role, content:m.content }))
    ];

    const sendBtn = document.getElementById('ai-send-btn');
    if(sendBtn){ sendBtn.innerHTML = icon('stopcircle',15); sendBtn.onclick = () => AIAgent.stop(); }

    try{
      const result = await AIAgent.run(convoForModel, {
        onToken: (tok) => { assistantPlaceholder.content += tok; this.renderMessages(); },
        onStep: (step) => {
          activityMsg.steps.push({ name: step.name, status: step.status || 'running', label: this.activityLabel(step) });
          if(step.result && step.result.ok && step.result.data){
            const arr = Array.isArray(step.result.data) ? step.result.data : [step.result.data];
            arr.forEach(item=>{
              if(item && item.fileName && item.subjectName){
                assistantPlaceholder.citations.push({ subjectName:item.subjectName, lessonId:item.lessonId, lessonNumber:item.lessonNumber, fileName:item.fileName, page:item.page });
              }
            });
          }
          this.renderMessages();
        }
      });
      if(result.aborted){
        assistantPlaceholder.content = assistantPlaceholder.content || 'Generazione interrotta.';
      } else {
        assistantPlaceholder.content = result.finalMessage || assistantPlaceholder.content;
      }
      assistantPlaceholder.citations = (assistantPlaceholder.citations||[]).filter((c,i,arr)=>arr.findIndex(x=>x.fileName===c.fileName && x.lessonId===c.lessonId)===i).slice(0,5);
    }catch(err){
      console.error(err);
      assistantPlaceholder.content = 'Errore: ' + (err.message || err);
    }finally{
      if(sendBtn){ sendBtn.innerHTML = icon('send',15); sendBtn.onclick = () => this.send(); }
      this.currentChat.updatedAt = Date.now();
      if(this.currentChat.title === 'Nuova conversazione' && text) this.currentChat.title = text.slice(0,40);
      ChatHistoryStore.save(this.currentChat).catch(()=>{});
      this.renderMessages();
    }
  },

  async openHistory(){
    const list = await ChatHistoryStore.list();
    const m = ModalManager.open(`
      <div class="modal-header"><div class="modal-title">${icon('clock',16)} Cronologia conversazioni</div><button class="icon-btn" id="m-close">${icon('x',16)}</button></div>
      <div class="modal-body" style="max-height:60vh; overflow:auto;">
        ${list.length ? list.map(c=>`
          <div class="card card-hover" data-open-chat="${c.id}" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; cursor:pointer;">
            <div style="min-width:0;"><div style="font-size:13px; font-weight:650;">${esc(c.title)}</div><div class="muted" style="font-size:11px;">${fmtRelative(new Date(c.updatedAt))}</div></div>
            <button class="icon-btn" data-delete-chat="${c.id}">${icon('trash',14)}</button>
          </div>
        `).join('') : `<div class="muted" style="padding:20px 0; text-align:center;">Nessuna conversazione salvata ancora.</div>`}
      </div>
      <div class="modal-footer"><button class="btn" id="m-ok">Chiudi</button></div>
    `);
    m.querySelector('#m-close').onclick = () => ModalManager.close();
    m.querySelector('#m-ok').onclick = () => ModalManager.close();
    m.querySelectorAll('[data-open-chat]').forEach(elm=>{
      elm.addEventListener('click', () => {
        const chat = list.find(c=>c.id===elm.dataset.openChat);
        if(chat){ this.currentChat = chat; this.renderMessages(); }
        ModalManager.close();
      });
    });
    m.querySelectorAll('[data-delete-chat]').forEach(elm=>{
      elm.addEventListener('click', async (e) => {
        e.stopPropagation();
        await ChatHistoryStore.delete(elm.dataset.deleteChat);
        Toast.success('Conversazione eliminata');
        ModalManager.close();
        this.openHistory();
      });
    });
  }
};
window.AIPanel = AIPanel;

/* ============================================================
   INTEGRAZIONE NELL'APP ESISTENTE (senza toccare il file originale)
   ============================================================ */

// CSS del pannello AI
const AI_STYLE = document.createElement('style');
AI_STYLE.textContent = `
#ai-panel{ position:fixed; top:0; right:0; height:100vh; width:400px; max-width:92vw; background:var(--bg-elevated); border-left:1px solid var(--border); box-shadow:var(--shadow-lg); transform:translateX(100%); transition:transform 220ms cubic-bezier(0.4,0,0.2,1); z-index:750; display:flex; flex-direction:column; }
#ai-panel.open{ transform:translateX(0); }
.ai-header{ display:flex; align-items:center; gap:8px; padding:12px 14px; border-bottom:1px solid var(--border); flex-shrink:0; }
.ai-status-dot{ width:8px; height:8px; border-radius:50%; background:var(--text-tertiary); flex-shrink:0; }
.ai-status-dot.on{ background:var(--success); }
.ai-status-dot.off{ background:var(--danger); }
.ai-messages{ flex:1; overflow-y:auto; padding:14px; display:flex; flex-direction:column; gap:12px; }
.ai-msg{ max-width:92%; padding:9px 12px; border-radius:12px; font-size:13px; line-height:1.55; white-space:pre-wrap; }
.ai-msg.user{ align-self:flex-end; background:var(--accent); color:#fff; border-bottom-right-radius:4px; }
.ai-msg.assistant{ align-self:flex-start; background:var(--surface); border:1px solid var(--border); border-bottom-left-radius:4px; }
.ai-activity{ align-self:flex-start; max-width:92%; background:var(--surface-2); border:1px solid var(--border); border-radius:10px; padding:8px 10px; font-size:11.5px; color:var(--text-secondary); }
.ai-activity-step{ display:flex; align-items:center; gap:6px; padding:2px 0; }
.ai-citation{ display:block; margin-top:6px; padding:7px 9px; border-radius:8px; background:var(--accent-soft); color:var(--accent); font-size:11.5px; cursor:pointer; }
.ai-inputbar{ border-top:1px solid var(--border); padding:10px; display:flex; gap:8px; flex-shrink:0; }
.ai-inputbar textarea{ flex:1; resize:none; border:1px solid var(--border); border-radius:10px; background:var(--surface-2); padding:8px 10px; font-size:13px; max-height:110px; }
`;
document.head.appendChild(AI_STYLE);

// Contenitore del pannello
if(!document.getElementById('ai-panel')){
  const panelDiv = document.createElement('div');
  panelDiv.id = 'ai-panel';
  document.body.appendChild(panelDiv);
}

// Pulsante AI nella topbar (si aggancia ad ogni render della topbar esistente)
if(typeof TopbarView !== 'undefined' && !TopbarView.__aiPatched){
  const _origTopbarRender = TopbarView.render.bind(TopbarView);
  TopbarView.render = function(crumbs, actionsHtml){
    _origTopbarRender(crumbs, actionsHtml);
    const el = document.getElementById('topbar');
    if(el && !el.querySelector('#topbar-ai-btn')){
      const btn = document.createElement('button');
      btn.className = 'icon-btn';
      btn.id = 'topbar-ai-btn';
      btn.title = 'Assistente AI';
      btn.innerHTML = icon('ai',17);
      btn.addEventListener('click', () => AIPanel.toggle());
      const syncBtn = el.querySelector('#topbar-sync-btn');
      if(syncBtn) el.insertBefore(btn, syncBtn); else el.appendChild(btn);
    }
  };
  TopbarView.__aiPatched = true;
}

// PDFViewerModal.open(lesson, file, { page }) — apre direttamente alla pagina indicata
if(typeof PDFViewerModal !== 'undefined' && !PDFViewerModal.__aiPatched){
  const _origPdfOpen = PDFViewerModal.open.bind(PDFViewerModal);
  PDFViewerModal.open = async function(lesson, file, opts){
    await _origPdfOpen(lesson, file);
    if(opts && opts.page){
      setTimeout(()=>{
        const target = document.querySelector(`.pdfr-page[data-page="${opts.page}"]`);
        if(target) target.scrollIntoView({ block:'start' });
      }, 450);
    }
  };
  PDFViewerModal.__aiPatched = true;
}

// Sezione "AI locale (Ollama)" nelle Impostazioni
if(typeof SettingsPage !== 'undefined' && !SettingsPage.__aiPatched){
  const _origSettingsRender = SettingsPage.render.bind(SettingsPage);
  SettingsPage.render = function(){
    _origSettingsRender();
    const page = document.querySelector('#content .page');
    if(!page || document.getElementById('ai-settings-card')) return;
    const card = document.createElement('div');
    card.className = 'card';
    card.id = 'ai-settings-card';
    card.style.marginTop = '14px';
    card.innerHTML = `
      <div style="font-size:13px; font-weight:650; margin-bottom:4px;">AI locale (Ollama)</div>
      <div class="muted" style="font-size:12.5px; margin-bottom:10px;" id="ai-set-status">Verifica in corso…</div>
      <div class="field"><label>Modello predefinito</label><select id="ai-set-model"></select></div>
      <div class="field"><label>Modalità permessi AI</label>
        <select id="ai-set-mode">
          <option value="conservative">Conservativa — conferma ogni operazione distruttiva</option>
          <option value="balanced">Bilanciata — conferma eliminazioni e cancellazioni</option>
          <option value="autonomous">Autonoma — nessuna conferma (usa con cautela)</option>
        </select>
      </div>
      <div style="display:flex; gap:8px; margin-top:10px;">
        <button class="btn btn-sm" id="ai-set-testconn">${icon('refresh',14)} Verifica connessione</button>
      </div>
      <div class="muted" style="font-size:11.5px; margin-top:10px; line-height:1.6;" id="ai-set-cors-help"></div>
    `;
    page.appendChild(card);

    const modeSel = card.querySelector('#ai-set-mode');
    modeSel.value = AIPermissions.mode();
    modeSel.addEventListener('change', () => AIPermissions.setMode(modeSel.value));

    async function refresh(){
      const statusEl = card.querySelector('#ai-set-status');
      const modelSel = card.querySelector('#ai-set-model');
      const corsEl = card.querySelector('#ai-set-cors-help');
      statusEl.textContent = 'Verifica in corso…';
      corsEl.textContent = '';
      const r = await OllamaManager.testConnection();
      if(r.ok){
        statusEl.innerHTML = '🟢 Ollama connesso su ' + OllamaManager.baseUrl;
        const current = OllamaManager.getModel();
        modelSel.innerHTML = r.models.map(m=>`<option value="${esc(m)}" ${m===current?'selected':''}>${esc(m)}</option>`).join('') || `<option value="">Nessun modello installato</option>`;
        if(!current && r.models[0]) OllamaManager.setModel(r.models[0]);
        modelSel.onchange = () => OllamaManager.setModel(modelSel.value);
      } else {
        statusEl.innerHTML = '🔴 Ollama non raggiungibile (' + esc(r.error||'') + ')';
        modelSel.innerHTML = `<option value="">Non disponibile</option>`;
        corsEl.textContent = 'Se questa pagina è servita da GitHub Pages, il browser potrebbe bloccare la richiesta per via dell\'origine. Configura OLLAMA_ORIGINS per consentire l\'origine di questa pagina, poi riavvia Ollama. Esempio su macOS: launchctl setenv OLLAMA_ORIGINS "*" e poi riavvia l\'app Ollama.';
      }
    }
    card.querySelector('#ai-set-testconn').addEventListener('click', refresh);
    refresh();
  };
  SettingsPage.__aiPatched = true;
}

console.info('[Uni Notes AI Agent] Modulo caricato. Apri il pannello AI dalla topbar per iniziare.');

})();
