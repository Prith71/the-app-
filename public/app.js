/* ============================================================
   ANGY PRODUCTIONS — frontend
   Talks to server.js over Socket.IO. No passwords live in this
   file — the server checks them and just tells us pass/fail.
   ============================================================ */

const socket = io();

/* ---------------- STATIC CONTENT ---------------- */
const GOALS = [
  "Make films that people remember long after the credits roll.",
  "Become the most Gen Z and unserious production house on the planet.",
  "Win awards while posting the dumbest behind-the-scenes content imaginable.",
  "Prove that professionalism and absolute chaos can coexist.",
  "Build a team where everyone is family, everyone gets roasted, and everyone gets heard.",
  "Keep learning. Keep improving. Keep cooking.",
  "Tell stories that make people laugh, cry, think, or question their entire existence.",
  "Create opportunities for young filmmakers to do what they love.",
  "Never let ego get bigger than the story.",
  "Have fun making every single project.",
  "One day hear someone say, \"Produced by Angy Productions,\" and know exactly what kind of film they're about to watch.",
  "Become one of the greatest film production companies in the world... while somehow staying completely unserious."
];

const CREW_META = [
  { id: "urvish", name: "Urvish Mukherjee", role: "Director, Scriptwriter, Cinematographer" },
  { id: "aayush", name: "Aayush Sarkar", role: "Assistant Director, Scriptwriter" },
  { id: "abhishek", name: "Abhishek Chatterjee", role: "Editor, Cinematographer" },
  { id: "pranjal", name: "Pranjal Chaudhuri", role: "Scriptwriter" },
  { id: "sabarna", name: "Sabarna Chakraborty", role: "Sound" },
  { id: "naina", name: "Nayna Mukherjee", role: "Social Media, Marketing" },
  { id: "asmit", name: "Asmit Ghoshal", role: "Consultant" }
];

const SIX_CAST = [
  "Abhishek Chatterjee","Nayna Mukherjee","Pranjal Chaudhuri","Alisha Khan","Aadit Ghosh",
  "Debotra Basu","Neil Roy","Arkaprava Gupta","Abhishek Raffelle Gomes","Debsourya Chowdhury",
  "Abhinit Mukherjee","Yudhajit Bhattacharya","Aaditya Sen","Diptayan Roy","Kunal Aswani",
  "Hrishit Sur","Rivu Sreemany","Shivang Sarkar","Mayukh Roy","Syamantak Mitra",
  "Anurag Nandy","Siddhartha Kundu","Soumyadip Nag","Aditya Mukherjee","Nirvani Charkraborty",
  "Shivam Bhattacharya","Antarik Bhaduri","Abdul Haadi"
];

const FOUNDERS_META = [
  { id: "urvish", name: "Urvish Mukherjee", role: "Founder" },
  { id: "ayush", name: "Aayush Sarkar", role: "Board of Directors" },
  { id: "pranjal", name: "Pranjal Chaudhuri", role: "Board of Directors" },
  { id: "nayna", name: "Nayna Mukherjee", role: "Board of Directors" }
];

const PEOPLE_GROUPS = {
  founders: { meta: FOUNDERS_META, container: 'founders-grid' },
  crew: { meta: CREW_META, container: 'crew-grid' }
};
let peopleCache = { founders: {}, crew: {} };

/* ---------------- STATE ---------------- */
let chatUnlocked = false;
let coreUnlocked = false;
let chatName = "";
let productionsCache = ["SIX"];
let btsCache = { link: '', photos: [] };
let doubtsCache = [];

/* ---------------- ROUTING ---------------- */
function go(view){
  if(view === 'chat' && !chatUnlocked){ view = 'chat-gate'; }
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + view).classList.add('active');
  document.querySelectorAll('.navlinks button').forEach(b => b.classList.remove('active'));
  const navKey = (view === 'chat-gate') ? 'chat' : view;
  const btn = document.querySelector('.navlinks button[data-nav="' + navKey + '"]');
  if(btn) btn.classList.add('active');
  if(view === 'chat'){ scrollChatToBottom(); }
}

/* ---------------- SIDE MENU (hamburger) ---------------- */
function openMenu(){
  document.getElementById('side-menu-overlay').classList.add('open');
}
function closeMenu(){
  document.getElementById('side-menu-overlay').classList.remove('open');
  document.querySelectorAll('.side-menu-section.open').forEach(el => el.classList.remove('open'));
}
function toggleMenuSection(key){
  const el = document.getElementById('menu-section-' + key);
  if(!el) return;
  const isOpen = el.classList.contains('open');
  document.querySelectorAll('.side-menu-section.open').forEach(e => e.classList.remove('open'));
  if(!isOpen) el.classList.add('open');
}
function goToHelp(){
  closeMenu();
  go('core');
  showSixTab('doubts');
}
document.addEventListener('keydown', (e) => {
  if(e.key === 'Escape'){
    const overlay = document.getElementById('side-menu-overlay');
    if(overlay && overlay.classList.contains('open')) closeMenu();
  }
});

/* ---------------- GOALS ---------------- */
function renderGoals(){
  document.getElementById('goals-list').innerHTML = GOALS.map((g,i) => `
    <div class="shot">
      <div class="shot-num">SCENE<b>${String(i+1).padStart(2,'0')}</b></div>
      <div class="shot-body">${escapeHtml(g)}</div>
    </div>
  `).join('');
}

/* ---------------- SIX: CAST ---------------- */
function renderSixCast(filter){
  const q = (filter || '').trim().toLowerCase();
  const list = q ? SIX_CAST.filter(n => n.toLowerCase().includes(q)) : SIX_CAST;
  const grid = document.getElementById('six-cast-grid');
  grid.innerHTML = list.length
    ? list.map((n,i) => `
        <div class="cast-item"><span class="cast-num">${String(i+1).padStart(2,'0')}</span>${escapeHtml(n)}</div>
      `).join('')
    : '<div class="doubt-empty">No cast members match that search.</div>';
}
function filterCast(){
  renderSixCast(document.getElementById('cast-search').value);
}
function showSixTab(tab){
  document.querySelectorAll('.subtab-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('.subtab-btn[data-sixtab="' + tab + '"]').classList.add('active');
  document.querySelectorAll('.subpage').forEach(p => p.classList.remove('active'));
  document.getElementById('six-' + tab).classList.add('active');
}

/* ---------------- PEOPLE (Founders / Crew — photo + bio, core-only) ---------------- */
function renderPeople(group){
  const cfg = PEOPLE_GROUPS[group];
  const grid = document.getElementById(cfg.container);
  if(!grid) return;
  const cache = peopleCache[group] || {};
  grid.innerHTML = cfg.meta.map(p => {
    const data = cache[p.id] || { photo: '', bio: '' };
    const photoHtml = data.photo
      ? `<img src="${escapeHtml(data.photo)}" alt="${escapeHtml(p.name)}">`
      : `<div class="placeholder">No photo yet</div>`;
    return `
      <div class="founder-card">
        <div class="founder-top">
          <div class="founder-photo">${photoHtml}</div>
          <div class="founder-id">
            <div class="founder-name">${escapeHtml(p.name)}</div>
            <div class="founder-role">${escapeHtml(p.role)}</div>
          </div>
        </div>
        <div class="founder-bio${data.bio ? '' : ' empty'}">
          ${data.bio ? escapeHtml(data.bio) : (coreUnlocked ? 'No bio yet — add one below.' : 'No bio yet.')}
        </div>
        <div class="founder-edit${coreUnlocked ? ' show' : ''}">
          <textarea id="person-bio-input-${group}-${p.id}" placeholder="Write a short bio for ${escapeHtml(p.name)}…">${escapeHtml(data.bio || '')}</textarea>
          <div class="founder-edit-row">
            <button class="btn primary" onclick="savePersonBio('${group}','${p.id}')">Save bio</button>
          </div>
          <div class="founder-edit-row">
            <input type="file" id="person-photo-input-${group}-${p.id}" accept="image/*">
            <button class="btn" onclick="uploadPersonPhoto('${group}','${p.id}')">Upload photo</button>
          </div>
          <div class="founder-upload-status" id="person-upload-status-${group}-${p.id}"></div>
        </div>
      </div>
    `;
  }).join('');
}
function renderAllPeople(){
  Object.keys(PEOPLE_GROUPS).forEach(renderPeople);
}
function savePersonBio(group, id){
  const val = document.getElementById(`person-bio-input-${group}-${id}`).value.trim();
  socket.emit('core:set-person-bio', { group, id, bio: val });
}
function uploadPersonPhoto(group, id){
  const fileInput = document.getElementById(`person-photo-input-${group}-${id}`);
  const statusEl = document.getElementById(`person-upload-status-${group}-${id}`);
  const file = fileInput.files[0];
  if(!file){ statusEl.textContent = 'Pick an image file first.'; return; }
  openUploadCodeModal('Confirm your core access code to upload this photo.', async (code) => {
    statusEl.textContent = 'Uploading…';
    try{
      const form = new FormData();
      form.append('photo', file);
      form.append('code', code);
      const res = await fetch(`/api/people/${group}/${id}/photo`, { method: 'POST', body: form });
      const data = await res.json();
      if(!res.ok){
        statusEl.textContent = data.error || 'Upload failed.';
        return;
      }
      statusEl.textContent = 'Uploaded ✓';
      fileInput.value = '';
    }catch(e){
      statusEl.textContent = 'Upload failed — check your connection.';
    }
  });
}
socket.on('founders:update', (data) => { peopleCache.founders = data; renderPeople('founders'); });
socket.on('crew:update', (data) => { peopleCache.crew = data; renderPeople('crew'); });

/* ---------------- PRODUCTIONS ---------------- */
function renderProductions(list){
  productionsCache = list;
  const grid = document.getElementById('reel-grid');
  document.getElementById('prod-count').textContent =
    list.length + (list.length === 1 ? ' production currently rolling' : ' productions currently rolling');
  const statEl = document.getElementById('stat-productions');
  if(statEl) statEl.textContent = list.length;
  grid.innerHTML = list.map((title, i) => {
    const clickable = title.trim().toLowerCase() === 'six';
    const titleHtml = clickable
      ? `<div class="reel-six-logo-wrap"><img class="reel-six-logo" src="assets/six-logo.png" alt="${escapeHtml(title)} logo"></div>`
      : `<div class="reel-title">${escapeHtml(title)}</div>`;
    return `
    <div class="reel-card${clickable ? ' clickable six' : ''}" ${clickable ? `onclick="go('core')"` : ''}>
      <div>
        <div class="reel-index">Reel ${String(i+1).padStart(2,'0')}</div>
        ${titleHtml}
      </div>
      ${coreUnlocked ? `<button class="reel-remove" onclick="event.stopPropagation(); removeProduction(${i})">Remove</button>` : (clickable ? `<div class="reel-hint">Tap to meet the core →</div>` : '')}
    </div>
  `;
  }).join('');
}
function addProduction(){
  const input = document.getElementById('new-prod');
  const val = input.value.trim();
  if(!val) return;
  input.value = '';
  socket.emit('core:add-production', val);
}
function removeProduction(idx){
  socket.emit('core:remove-production', idx);
}

/* ---------------- CORE ACCESS (shared by Productions / Status / Trailer / People) ---------------- */
function toggleCore(){
  if(coreUnlocked){
    coreUnlocked = false;
    setCoreUI();
    renderProductions(productionsCache);
    renderAllPeople();
    renderMessages(chatCache);
    renderBts();
    renderDoubts();
    return;
  }
  openUnlockModal();
}
socket.on('core:auth:result', (res) => {
  if(coreModalMode !== 'unlock'){
    // Result arrived outside of an active unlock attempt (e.g. modal
    // already closed) — nothing to update on screen.
    return;
  }
  if(res.locked){
    document.getElementById('core-modal-error').textContent = `Too many wrong attempts. Try again in ${res.wait}s.`;
    return;
  }
  if(res.success){
    coreUnlocked = true;
    closeCoreModal();
    setCoreUI();
    renderProductions(productionsCache);
    renderAllPeople();
    renderMessages(chatCache);
    renderBts();
    renderDoubts();
  }else{
    const left = res.remaining !== undefined ? ` (${res.remaining} attempt${res.remaining===1?'':'s'} left)` : '';
    document.getElementById('core-modal-error').textContent = 'Wrong code.' + left;
    document.getElementById('core-modal-input').value = '';
    document.getElementById('core-modal-input').focus();
  }
});

/* ---------------- CORE ACCESS MODAL ---------------- */
let coreModalMode = null; // 'unlock' | 'upload'
let coreModalUploadCallback = null;

function openUnlockModal(){
  document.getElementById('core-modal-title').textContent = 'Core Access';
  document.getElementById('core-modal-message').textContent = 'Enter the core access code to unlock editing across the site.';
  document.getElementById('core-modal-input').value = '';
  document.getElementById('core-modal-error').textContent = '';
  document.getElementById('core-modal-confirm-label').textContent = 'Unlock';
  coreModalMode = 'unlock';
  coreModalUploadCallback = null;
  const overlay = document.getElementById('core-modal-overlay');
  overlay.style.display = 'flex';
  setTimeout(() => document.getElementById('core-modal-input').focus(), 50);
}
function openUploadCodeModal(message, callback){
  document.getElementById('core-modal-title').textContent = 'Confirm Core Code';
  document.getElementById('core-modal-message').textContent = message;
  document.getElementById('core-modal-input').value = '';
  document.getElementById('core-modal-error').textContent = '';
  document.getElementById('core-modal-confirm-label').textContent = 'Confirm';
  coreModalMode = 'upload';
  coreModalUploadCallback = callback;
  const overlay = document.getElementById('core-modal-overlay');
  overlay.style.display = 'flex';
  setTimeout(() => document.getElementById('core-modal-input').focus(), 50);
}
function closeCoreModal(){
  document.getElementById('core-modal-overlay').style.display = 'none';
  coreModalMode = null;
  coreModalUploadCallback = null;
}
function submitCoreModal(){
  const val = document.getElementById('core-modal-input').value;
  if(!val) return;
  if(coreModalMode === 'unlock'){
    document.getElementById('core-modal-error').textContent = '';
    socket.emit('core:auth', val);
  }else if(coreModalMode === 'upload'){
    const cb = coreModalUploadCallback;
    closeCoreModal();
    if(cb) cb(val);
  }
}

function setCoreUI(){
  ['core-toggle','core-toggle-2','core-toggle-3','core-toggle-4','core-toggle-5','core-toggle-6','core-toggle-7'].forEach(id => {
    const pill = document.getElementById(id);
    if(!pill) return;
    pill.textContent = coreUnlocked ? '✅ Core mode' : '🔒 Core access';
    pill.classList.toggle('on', coreUnlocked);
  });
  document.getElementById('add-row').style.display = coreUnlocked ? 'flex' : 'none';
  document.getElementById('status-edit').style.display = coreUnlocked ? 'flex' : 'none';
  document.getElementById('trailer-edit').style.display = coreUnlocked ? 'flex' : 'none';
  document.getElementById('bts-link-edit').style.display = coreUnlocked ? 'flex' : 'none';
}

/* ---------------- STATUS ---------------- */
function saveStatus(){
  const val = document.getElementById('status-input').value.trim();
  if(!val) return;
  socket.emit('core:set-status', val);
}
socket.on('status:update', (value) => {
  document.getElementById('status-display').textContent = value;
  document.getElementById('status-input').value = value;
});

/* ---------------- TRAILER ---------------- */
function toEmbedUrl(url){
  try{
    const u = new URL(url);
    if(u.hostname.includes('youtube.com')){
      const id = u.searchParams.get('v');
      if(id) return 'https://www.youtube.com/embed/' + id;
      if(u.pathname.startsWith('/embed/')) return url;
    }
    if(u.hostname === 'youtu.be'){
      const id = u.pathname.replace('/', '');
      if(id) return 'https://www.youtube.com/embed/' + id;
    }
    if(u.hostname.includes('vimeo.com')){
      const id = u.pathname.split('/').filter(Boolean).pop();
      if(id) return 'https://player.vimeo.com/video/' + id;
    }
  }catch(e){ /* not a valid URL */ }
  return null;
}
function renderTrailer(url){
  const el = document.getElementById('trailer-display');
  if(!url){
    el.innerHTML = '<div class="trailer-empty">No trailer uploaded yet.</div>';
    return;
  }
  const embed = toEmbedUrl(url);
  if(embed){
    el.innerHTML = `<div class="trailer-embed"><iframe src="${embed}" title="Trailer" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe></div>`;
  }else{
    el.innerHTML = `<div class="trailer-link-card">Trailer link: <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a></div>`;
  }
}
function saveTrailer(){
  const val = document.getElementById('trailer-input').value.trim();
  socket.emit('core:set-trailer', val);
}
socket.on('trailer:update', (value) => {
  renderTrailer(value);
  document.getElementById('trailer-input').value = value;
});

/* ---------------- BTS (Behind the Scenes) ---------------- */
function renderBts(){
  const linkEl = document.getElementById('bts-link-display');
  if(!btsCache.link){
    linkEl.innerHTML = '<div class="trailer-empty">No BTS footage linked yet.</div>';
  }else{
    const embed = toEmbedUrl(btsCache.link);
    if(embed){
      linkEl.innerHTML = `<div class="trailer-embed"><iframe src="${embed}" title="BTS footage" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe></div>`;
    }else{
      linkEl.innerHTML = `<div class="trailer-link-card">BTS link: <a href="${escapeHtml(btsCache.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(btsCache.link)}</a></div>`;
    }
  }
  document.getElementById('bts-link-input').value = btsCache.link || '';

  const grid = document.getElementById('bts-grid');
  const photos = btsCache.photos || [];
  const slotsHtml = [];
  for(let i = 0; i < 20; i++){
    const slotNum = i + 1;
    const data = photos[i] || { photo: '', caption: '' };
    const hasPhoto = !!data.photo;
    if(!hasPhoto && !coreUnlocked) continue; // hide empty slots from regular visitors
    const photoHtml = hasPhoto
      ? `<img src="${escapeHtml(data.photo)}" alt="BTS photo ${slotNum}">`
      : `<div class="placeholder">Empty slot</div>`;
    slotsHtml.push(`
      <div class="bts-slot">
        <div class="bts-slot-photo">${photoHtml}</div>
        <div class="bts-slot-num">Slot ${String(slotNum).padStart(2,'0')}</div>
        <div class="bts-caption${data.caption ? '' : ' empty'}">${data.caption ? escapeHtml(data.caption) : (coreUnlocked ? 'No caption yet.' : '')}</div>
        ${coreUnlocked ? `
          <div class="bts-slot-edit">
            <input type="text" id="bts-caption-input-${slotNum}" placeholder="Short caption (~20 words)" value="${escapeHtml(data.caption || '')}">
            <input type="file" id="bts-photo-input-${slotNum}" accept="image/*">
            <div class="bts-slot-btn-row">
              <button class="btn primary" onclick="saveBtsCaption(${slotNum})">Save caption</button>
              <button class="btn" onclick="uploadBtsPhoto(${slotNum})">Upload</button>
              ${hasPhoto ? `<button class="reel-remove" onclick="deleteBtsPhoto(${slotNum})">Delete</button>` : ''}
            </div>
            <div class="bts-slot-status" id="bts-status-${slotNum}"></div>
          </div>
        ` : ''}
      </div>
    `);
  }
  grid.innerHTML = slotsHtml.length
    ? slotsHtml.join('')
    : '<div class="doubt-empty">No BTS photos yet.</div>';
}
function saveBtsLink(){
  const val = document.getElementById('bts-link-input').value.trim();
  socket.emit('core:set-bts-link', val);
}
function saveBtsCaption(slot){
  const val = document.getElementById('bts-caption-input-' + slot).value.trim();
  socket.emit('core:set-bts-caption', { slot, caption: val });
}
function uploadBtsPhoto(slot){
  const fileInput = document.getElementById('bts-photo-input-' + slot);
  const statusEl = document.getElementById('bts-status-' + slot);
  const file = fileInput.files[0];
  if(!file){ statusEl.textContent = 'Pick an image file first.'; return; }
  openUploadCodeModal('Confirm your core access code to upload this BTS photo.', async (code) => {
    statusEl.textContent = 'Uploading…';
    try{
      const form = new FormData();
      form.append('photo', file);
      form.append('code', code);
      const res = await fetch(`/api/bts/${slot}/photo`, { method: 'POST', body: form });
      const data = await res.json();
      if(!res.ok){
        statusEl.textContent = data.error || 'Upload failed.';
        return;
      }
      statusEl.textContent = 'Uploaded ✓';
      fileInput.value = '';
    }catch(e){
      statusEl.textContent = 'Upload failed — check your connection.';
    }
  });
}
function deleteBtsPhoto(slot){
  if(!confirm('Delete this BTS photo and caption?')) return;
  socket.emit('core:delete-bts-photo', slot);
}
socket.on('bts:update', (data) => { btsCache = data; renderBts(); });

/* ---------------- DOUBTS (anonymous questions to Core) ---------------- */
const DOUBT_SUGGESTIONS = [
  "When's the next shoot day?",
  "How do I get involved in a production?",
  "Can non-crew members visit a set?",
  "How are cast members picked?",
  "Is there a budget I should know about?",
  "Can I suggest an idea for a future project?"
];
function renderDoubtSuggestions(){
  const el = document.getElementById('doubt-suggestions');
  if(!el) return;
  el.innerHTML = DOUBT_SUGGESTIONS.map(q => `
    <button type="button" class="doubt-chip" onclick="useDoubtSuggestion(this)">${escapeHtml(q)}</button>
  `).join('');
}
function useDoubtSuggestion(btn){
  const input = document.getElementById('doubt-input');
  input.value = btn.textContent;
  input.focus();
}
function submitDoubt(){
  const input = document.getElementById('doubt-input');
  const val = input.value.trim();
  const msgEl = document.getElementById('doubt-sent-msg');
  if(!val){ return; }
  socket.emit('doubt:submit', val);
  input.value = '';
  msgEl.textContent = 'Sent anonymously to Core. Thanks!';
  setTimeout(() => { if(msgEl.textContent === 'Sent anonymously to Core. Thanks!') msgEl.textContent = ''; }, 4000);
}
function renderDoubts(){
  const list = document.getElementById('doubts-list');
  if(!coreUnlocked){
    list.innerHTML = '';
    return;
  }
  if(doubtsCache.length === 0){
    list.innerHTML = '<div class="doubt-empty">No questions yet.</div>';
    return;
  }
  const sorted = [...doubtsCache].sort((a,b) => b.ts - a.ts);
  list.innerHTML = sorted.map(d => `
    <div class="doubt-item">
      <div>
        <div class="doubt-item-text">${escapeHtml(d.text)}</div>
        <div class="doubt-item-meta">${formatTime(d.ts)}</div>
      </div>
      <button class="reel-remove" onclick="deleteDoubt(${d.id})">Delete</button>
    </div>
  `).join('');
}
function deleteDoubt(id){
  if(!confirm('Delete this question?')) return;
  socket.emit('doubt:delete', id);
}
socket.on('doubts:update', (list) => { doubtsCache = list; renderDoubts(); });

/* ---------------- CHAT GATE ---------------- */
function checkChatPassword(){
  const val = document.getElementById('chat-pass').value;
  socket.emit('chat:auth', val);
}
socket.on('chat:auth:result', (res) => {
  const err = document.getElementById('chat-pass-error');
  if(res.locked){
    err.textContent = `Too many wrong attempts. Try again in ${res.wait}s.`;
    return;
  }
  if(res.success){
    chatUnlocked = true;
    mySenderId = res.senderId || null;
    err.textContent = '';
    go('chat');
    autoJoinIfSavedName();
  }else{
    const left = res.remaining !== undefined ? ` (${res.remaining} left)` : '';
    err.textContent = 'Wrong code. Try again.' + left;
  }
});
socket.on('chat:history', (messages) => {
  chatCache = messages;
  renderMessages(chatCache);
});

/* ---------------- CHAT ---------------- */
let mySenderId = null;
const CHAT_NAME_STORAGE_KEY = 'angyChatName';
function autoJoinIfSavedName(){
  let saved = null;
  try{ saved = localStorage.getItem(CHAT_NAME_STORAGE_KEY); }catch(e){ /* storage unavailable — fine, just skip */ }
  if(!saved) return false;
  chatName = saved;
  document.getElementById('name-card').style.display = 'none';
  document.getElementById('chat-shell').style.display = 'flex';
  document.getElementById('chat-name-display').textContent = chatName;
  socket.emit('chat:set-name', chatName);
  return true;
}
function setChatName(){
  const val = document.getElementById('chat-name-input').value.trim();
  if(!val) return;
  chatName = val;
  try{ localStorage.setItem(CHAT_NAME_STORAGE_KEY, chatName); }catch(e){ /* storage unavailable — name just won't be remembered */ }
  document.getElementById('name-card').style.display = 'none';
  document.getElementById('chat-shell').style.display = 'flex';
  document.getElementById('chat-name-display').textContent = chatName;
  socket.emit('chat:set-name', chatName);
}
function changeChatName(){
  try{ localStorage.removeItem(CHAT_NAME_STORAGE_KEY); }catch(e){}
  chatName = '';
  document.getElementById('chat-shell').style.display = 'none';
  document.getElementById('name-card').style.display = 'block';
  document.getElementById('chat-name-input').value = '';
  document.getElementById('chat-name-input').focus();
}
let chatCache = [];
function renderMessages(list){
  renderPinnedStrip(list);
  const log = document.getElementById('chat-log');
  if(list.length === 0){
    log.innerHTML = '<div class="chat-empty">No messages yet. Say hi.</div>';
    return;
  }
  const wasNearBottom = (log.scrollHeight - log.scrollTop - log.clientHeight) < 80;
  let lastDateKey = null;
  const parts = [];
  list.forEach(m => {
    const dateKey = new Date(m.ts).toDateString();
    if(dateKey !== lastDateKey){
      parts.push(`<div class="chat-date-divider"><span>${formatDateLabel(m.ts)}</span></div>`);
      lastDateKey = dateKey;
    }
    const isMe = m.name === chatName && m.senderId === mySenderId;
    const canDelete = coreUnlocked || (m.senderId && m.senderId === mySenderId);
    const actions = [];
    if(coreUnlocked){
      actions.push(`<button class="msg-action" onclick="togglePin(${m.id}, ${!m.pinned})" title="${m.pinned ? 'Unpin' : 'Pin'}">${m.pinned ? '📌' : '📍'}</button>`);
    }
    if(canDelete){
      actions.push(`<button class="msg-action" onclick="deleteMessage(${m.id})" title="Delete">🗑</button>`);
    }
    parts.push(`
    <div class="msg ${isMe ? 'me' : ''}${m.pinned ? ' pinned' : ''}">
      <div class="meta">
        <span>${m.pinned ? '📌 ' : ''}${escapeHtml(m.name)} · ${formatTime(m.ts)}</span>
        ${actions.length ? `<span class="msg-actions">${actions.join('')}</span>` : ''}
      </div>
      <div class="bubble">${escapeHtml(m.text)}</div>
    </div>
  `);
  });
  log.innerHTML = parts.join('');
  if(wasNearBottom) scrollChatToBottom();
}
function renderPinnedStrip(list){
  const strip = document.getElementById('pinned-strip');
  if(!strip) return;
  const pinned = list.filter(m => m.pinned);
  if(pinned.length === 0){
    strip.style.display = 'none';
    strip.innerHTML = '';
    return;
  }
  strip.style.display = 'flex';
  strip.innerHTML = pinned.map(m => `
    <div class="pinned-item">
      <span class="pinned-icon">📌</span>
      <span class="pinned-name">${escapeHtml(m.name)}:</span>
      <span class="pinned-text">${escapeHtml(m.text)}</span>
      ${coreUnlocked ? `<button class="msg-action" onclick="togglePin(${m.id}, false)" title="Unpin">✕</button>` : ''}
    </div>
  `).join('');
}
function deleteMessage(id){
  if(!confirm('Delete this message?')) return;
  socket.emit('chat:delete', id);
}
function togglePin(id, pinned){
  socket.emit('chat:pin', { id, pinned });
}
socket.on('chat:deleted', ({ id }) => {
  chatCache = chatCache.filter(m => m.id !== id);
  renderMessages(chatCache);
});
socket.on('chat:pinned', ({ id, pinned }) => {
  const m = chatCache.find(m => m.id === id);
  if(m) m.pinned = pinned;
  renderMessages(chatCache);
});
function scrollChatToBottom(){
  const log = document.getElementById('chat-log');
  if(log) log.scrollTop = log.scrollHeight;
}
function sendMessage(){
  const input = document.getElementById('chat-input');
  const val = input.value.trim();
  if(!val || !chatName) return;
  input.value = '';
  socket.emit('chat:send', { name: chatName, text: val });
}
socket.on('chat:new', (message) => {
  chatCache.push(message);
  renderMessages(chatCache);
});

/* ---------------- SPEECH TO TEXT (chat input) ---------------- */
let speechRecognition = null;
let micListening = false;
function initSpeechToText(){
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  const btn = document.getElementById('mic-btn');
  if(!SpeechRec){
    if(btn) btn.classList.add('unsupported'); // browser doesn't support it — hide the button
    return;
  }
  speechRecognition = new SpeechRec();
  speechRecognition.continuous = false;
  speechRecognition.interimResults = false;
  speechRecognition.lang = 'en-US';
  speechRecognition.onresult = (e) => {
    const transcript = e.results[0][0].transcript.trim();
    if(!transcript) return;
    const input = document.getElementById('chat-input');
    input.value = input.value ? (input.value.trim() + ' ' + transcript) : transcript;
    input.focus();
  };
  speechRecognition.onend = () => { micListening = false; updateMicButton(); };
  speechRecognition.onerror = () => { micListening = false; updateMicButton(); };
}
function toggleMic(){
  if(!speechRecognition) return;
  if(micListening){
    speechRecognition.stop();
    micListening = false;
  }else{
    try{
      speechRecognition.start();
      micListening = true;
    }catch(e){
      micListening = false;
    }
  }
  updateMicButton();
}
function updateMicButton(){
  const btn = document.getElementById('mic-btn');
  if(btn) btn.classList.toggle('listening', micListening);
}

/* ---------------- SOCKET LIFECYCLE ---------------- */
socket.on('init', (data) => {
  renderProductions(data.productions);
  document.getElementById('status-display').textContent = data.status;
  document.getElementById('status-input').value = data.status;
  renderTrailer(data.trailer);
  document.getElementById('trailer-input').value = data.trailer;
  peopleCache.founders = data.founders || {};
  peopleCache.crew = data.crew || {};
  renderAllPeople();
  btsCache = data.bts || { link: '', photos: [] };
  renderBts();
  renderPresence(data.presence);
});
socket.on('productions:update', (list) => renderProductions(list));
socket.on('connect', () => {
  const statusEl = document.getElementById('chat-status');
  if(statusEl) statusEl.textContent = '● live';
});
socket.on('disconnect', () => {
  const statusEl = document.getElementById('chat-status');
  if(statusEl) statusEl.textContent = '○ reconnecting…';
});

/* ---------------- CLICK ANIMATION ---------------- */
document.addEventListener('click', function(e){
  const el = e.target.closest('.btn, .navlinks button, .core-pill, .reel-remove, .reel-card.clickable, .subtab-btn, .explore-card, .footer-links button, .doubt-chip, .mic-btn, .change-name-link, .hamburger-btn, .side-menu-item-btn, .side-menu-close');
  if(!el) return;
  const rect = el.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height) * 1.2;
  const ripple = document.createElement('span');
  ripple.className = 'click-ripple';
  ripple.style.width = ripple.style.height = size + 'px';
  ripple.style.left = (e.clientX - rect.left - size/2) + 'px';
  ripple.style.top = (e.clientY - rect.top - size/2) + 'px';
  el.appendChild(ripple);
  setTimeout(() => ripple.remove(), 600);
});

/* ---------------- UTIL ---------------- */
function escapeHtml(str){
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function formatTime(ts){
  const d = new Date(ts);
  return d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
}
function formatDateLabel(ts){
  const d = new Date(ts);
  const now = new Date();
  const sameDay = (a,b) => a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate();
  if(sameDay(d, now)) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if(sameDay(d, yesterday)) return 'Yesterday';
  const opts = d.getFullYear() === now.getFullYear()
    ? { weekday:'short', month:'short', day:'numeric' }
    : { weekday:'short', month:'short', day:'numeric', year:'numeric' };
  return d.toLocaleDateString([], opts);
}
function formatRelativeTime(ts){
  if(!ts) return 'a while ago';
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if(min < 1) return 'just now';
  if(min < 60) return min + 'm ago';
  const hr = Math.floor(min / 60);
  if(hr < 24) return hr + 'h ago';
  const day = Math.floor(hr / 24);
  if(day < 7) return day + 'd ago';
  return new Date(ts).toLocaleDateString([], {month:'short', day:'numeric'});
}

/* ---------------- PRESENCE (who's online / last seen) ---------------- */
let presenceCache = { online: [], lastSeen: {} };
function renderPresence(data){
  presenceCache = data || { online: [], lastSeen: {} };
  const bar = document.getElementById('participants-bar');
  if(!bar) return;
  const online = new Set(presenceCache.online || []);
  const lastSeen = presenceCache.lastSeen || {};
  const allNames = new Set([...online, ...Object.keys(lastSeen)]);
  if(allNames.size === 0){
    bar.style.display = 'none';
    bar.innerHTML = '';
    return;
  }
  const list = [...allNames].map(name => ({
    name,
    isOnline: online.has(name),
    lastSeenTs: lastSeen[name] || 0
  }));
  list.sort((a,b) => {
    if(a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
    return b.lastSeenTs - a.lastSeenTs;
  });
  bar.style.display = 'flex';
  bar.innerHTML = list.map(p => `
    <div class="participant-chip${p.isOnline ? ' online' : ''}" title="${p.isOnline ? 'Online now' : 'Last seen ' + formatRelativeTime(p.lastSeenTs)}">
      <span class="dot"></span>${escapeHtml(p.name)}${p.isOnline ? '' : ` <span class="last-seen">· ${formatRelativeTime(p.lastSeenTs)}</span>`}
    </div>
  `).join('');
}
socket.on('presence:update', renderPresence);

/* ---------------- INIT ---------------- */
renderGoals();
renderSixCast();
renderDoubtSuggestions();
initSpeechToText();
