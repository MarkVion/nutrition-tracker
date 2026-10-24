/* Nutrition Tracker PWA — app logic
   Storage: IndexedDB (ticket 03) + localStorage for settings.
   No CDN runtime: IndexedDB helper is inline so the service worker
   can keep the app fully offline. Same model as ticket 03 (date-keyed,
   async, queryable by date range).
*/

/* ---------- IndexedDB helper (drop-in, no deps) ---------- */
function openDB(name, store, version = 1) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, version);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(store)) {
        const os = db.createObjectStore(store, { keyPath: 'date' });
        os.createIndex('byDate', 'date');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const os = t.objectStore(store);
    const r = fn(os);
    t.oncomplete = () => resolve(r && r.result !== undefined ? r.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
const dbStore = 'entries';
let _db;
async function _getDB() { if (!_db) _db = await openDB('nutrition-tracker', dbStore); return _db; }
async function dbGetByDate(date) { const db = await _getDB(); return tx(db, dbStore, 'readonly', (os) => os.get(date)); }
async function dbPut(entry) { const db = await _getDB(); return tx(db, dbStore, 'readwrite', (os) => os.put(entry)); }
async function dbAllDates() {
  const db = await _getDB();
  return tx(db, dbStore, 'readonly', (os) => os.getAllKeys());
}

/* ---------- localStorage settings ---------- */
const SETTINGS_KEY = 'nutrition.settings';
function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; }
}
function saveSettings(s) { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); }

/* ---------- helpers ---------- */
const $ = (sel) => document.querySelector(sel);
const todayISO = () => new Date().toISOString().slice(0, 10);
function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), ms);
}
function slugFood(text) { return text; }

/* ---------- Quick Add chips (ticket 02) ---------- */
const QUICK_CHIPS = [
  { label: '☕ Coffee', value: 'Coffee' },
  { label: '🥥 Water', value: 'Water' },
  { label: '🥣 Oatmeal', value: 'Oatmeal' },
  { label: '🍫 Granola bar', value: 'Granola bar' },
  { label: '🍗 Chicken', value: 'Chicken' },
  { label: '🥛 Greek yogurt', value: 'Greek yogurt' },
  { label: '🥦 Veggies', value: 'Veggies' },
  { label: '🍚 Rice', value: 'Rice' },
  { label: '🐟 Fish', value: 'Fish' },
  { label: '🌮 Protein shake', value: 'Protein shake' },
];
function renderChips() {
  const c = $('#chips'); c.innerHTML = '';
  QUICK_CHIPS.forEach((chip) => {
    const el = document.createElement('button');
    el.className = 'chip'; el.type = 'button';
    el.textContent = chip.label;
    el.setAttribute('aria-pressed', 'false');
    el.addEventListener('click', () => {
      const pressed = el.getAttribute('aria-pressed') === 'true';
      el.setAttribute('aria-pressed', String(!pressed));
      const val = $('#food-input');
      const items = val.value ? val.value.split(',').map((s) => s.trim()).filter(Boolean) : [];
      if (!pressed) { if (!items.includes(chip.value)) items.push(chip.value); val.value = items.join(', '); }
      else { const i = items.indexOf(chip.value); if (i >= 0) items.splice(i, 1); val.value = items.join(', '); }
    });
    c.appendChild(el);
  });
}

/* ---------- slider badge labels ---------- */
function energyLabel(v) { return String(v); }
function hungerLabel(v) {
  if (v <= 2) return 'Starving'; if (v <= 4) return 'Hungry';
  if (v <= 6) return 'Neutral'; return 'Satisfied';
}
function fogLabel(v) {
  if (v <= 2) return 'None'; if (v <= 4) return 'Light';
  if (v <= 7) return 'Moderate'; return 'Severe';
}
function wireSlider(id, badgeId, labelFn) {
  const el = $(id), b = $(badgeId);
  const update = () => (b.textContent = labelFn(Number(el.value)));
  el.addEventListener('input', update); update();
}

/* ---------- clock / period ---------- */
function fmtTime(d) { return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); }
const periodLabelFromHour = (h) => (h < 11 ? 'Morning' : h < 16 ? 'Afternoon' : 'Evening');
async function updatePeriod() {
  const now = new Date();
  $('#clock').textContent = now.toLocaleDateString(undefined, { weekday: 'short' }) + ' · ' + fmtTime(now);
  const h = now.getHours();
  $('#period-label').textContent = `Log a ${periodLabelFromHour(h).toLowerCase()} check-in`;
  const entries = await allEntries();
  const last = entries[entries.length - 1];
  $('#period-since').textContent = last ? `Since ${last.timestamp}` : 'First check-in — what\u2019s on the plate?';
}

/* ---------- photo ---------- */
let photoPreviewUrl = null;
function wirePhoto() {
  const input = $('#photo-input');
  $('#photo-btn').addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    const f = input.files && input.files[0];
    if (!f) return;
    const url = URL.createObjectURL(f);
    photoPreviewUrl = { name: f.name, size: f.size, type: f.type, blob: f };
    $('#photo-status').textContent = `${f.name} (${(f.size / 1024).toFixed(0)} KB)`;
    $('#photo-img').src = url; $('#photo-preview').hidden = false;
  });
  $('#photo-remove').addEventListener('click', () => {
    input.value = ''; photoPreviewUrl = null;
    $('#photo-status').textContent = '';
    $('#photo-preview').hidden = true; $('#photo-img').src = '';
  });
}
function compressImage(file, maxDim = 720) {
  // downscale for export payload size (photo kept as dataURL in entry)
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      const scale = Math.min(1, maxDim / Math.max(width, height));
      width = Math.round(width * scale); height = Math.round(height * scale);
      const c = document.createElement('canvas'); c.width = width; c.height = height;
      const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, width, height);
      const data = c.toDataURL('image/jpeg', 0.72);
      URL.revokeObjectURL(url);
      resolve(data);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

/* ---------- save check-in ---------- */
async function saveCheckIn() {
  const food = $('#food-input').value.trim();
  const energy = Number($('#energy').value);
  const hunger = Number($('#hunger').value);
  const fog = Number($('#fog').value);
  const notes = $('#notes').value.trim();
  const date = todayISO();
  const stamp = new Date();

  let photo = null;
  if (photoPreviewUrl) photo = await compressImage(photoPreviewUrl.blob);

  const existing = await dbGetByDate(date);
  let meals;
  const meal = {
    id: (crypto.randomUUID && crypto.randomUUID()) || (Date.now() + '-' + Math.random().toString(16).slice(2)),
    timestamp: stamp.toISOString(),
    type: periodLabelFromHour(stamp.getHours()).toLowerCase(),
    foods: food ? food.split(',').map((s) => s.trim()).filter(Boolean) : [],
    notes,
    energy, hunger, fog,
    photoRef: photo,
    photoName: photo ? (photoPreviewUrl && photoPreviewUrl.name) || 'photo.jpg' : null,
  };
  if (existing) {
    meals = Array.isArray(existing.meals) ? [...existing.meals, meal] : [meal];
  } else {
    meals = [meal];
  }
  const entry = {
    date, timestamp: stamp.toISOString(),
    settings: loadSettings(),
    meals,
    lastSaved: stamp.toISOString(),
  };
  await dbPut(entry);

  const s = loadSettings();
  $('#save-status').textContent = `Saved ${fmtTime(stamp)} · protein target ${s.proteinTarget || '—'} g`;
  // reset transient form
  $('#food-input').value = ''; $('#notes').value = '';
  document.querySelectorAll('#chips .chip').forEach((c) => c.setAttribute('aria-pressed', 'false'));
  $('#photo-input').value = ''; photoPreviewUrl = null;
  $('#photo-status').textContent = ''; $('#photo-preview').hidden = true; $('#photo-img').src = '';
  await refreshHistory(); updatePeriod();
  toast('Check-in saved ✓');
  refreshSyncStatus();
}

/* ---------- history ---------- */
async function allEntries() {
  const keys = await dbAllDates();
  const out = [];
  for (const k of keys) out.push(await dbGetByDate(k));
  out.sort((a, b) => (a.date < b.date ? -1 : 1));
  return out;
}
async function refreshHistory() {
  const entries = await allEntries();
  const box = $('#history');
  if (!entries.length) { box.hidden = true; return; }
  box.hidden = false;
  const ul = $('#history-list'); ul.innerHTML = '';
  entries.slice(-5).reverse().forEach((e) => {
    const li = document.createElement('li');
    const last = e.meals[e.meals.length - 1];
    const foodStr = last && last.foods && last.foods.length ? last.foods.join(', ') : '—';
    li.innerHTML =
      `<div>${e.date} · E${last.energy} · H${last.hunger} · F${last.fog}</div>` +
      `<div class="meta">${foodStr}</div>`;
    ul.appendChild(li);
  });
}

/* ---------- export / sample ---------- */
async function exportJSON() {
  const keys = await dbAllDates();
  const days = [];
  for (const k of keys) days.push(await dbGetByDate(k));
  days.sort((a, b) => (a.date < b.date ? -1 : 1));
  const s = loadSettings();
  const payload = {
    meta: {
      formatVersion: '1.0',
      exportTimestamp: new Date().toISOString(),
      deviceInfo: { app: 'nutrition-tracker', screen: window.screen.width + 'x' + window.screen.height },
      proteinTarget: s.proteinTarget || null,
    },
    days,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'nutrition-tracker-data.json';
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  toast('Sync file downloaded ✓');
}
async function importSample() {
  const s = loadSettings();
  const now = new Date(); const iso = (off) => new Date(now.getTime() + off * 864e5).toISOString().slice(0, 10);
  const days = [
    { date: iso(-2), timestamp: iso(-2) + 'T12:12:00Z', meals: [
      { id: 's1', timestamp: iso(-2) + 'T12:12:00Z', type: 'afternoon', foods: ['Oatmeal', 'Greek yogurt'], notes: '', energy: 5, hunger: 4, fog: 3, photoRef: null, photoName: null },
    ]},
    { date: iso(-1), timestamp: iso(-1) + 'T16:20:00Z', meals: [
      { id: 's2', timestamp: iso(-1) + 'T16:20:00Z', type: 'evening', foods: ['Chicken', 'Rice', 'Veggies'], notes: 'Good protein day', energy: 6, hunger: 6, fog: 2, photoRef: null, photoName: null },
    ]},
    { date: iso(0), timestamp: iso(0) + 'T11:05:00Z', meals: [
      { id: 's3', timestamp: iso(0) + 'T11:05:00Z', type: 'morning', foods: ['Coffee', 'Granola bar'], notes: '', energy: 4, hunger: 3, fog: 5, photoRef: null, photoName: null },
    ]},
  ];
  for (const d of days) await dbPut(d);
  saveSettings({ ...s, proteinTarget: s.proteinTarget || 90 });
  toast('Sample loaded ✓');
  await refreshHistory(); updatePeriod();
  $('#sync-status').textContent = `${days.length} sample days — try Export JSON`;
}

/* ---------- settings dialog ---------- */
function wireSettings() {
  const dlg = $('#settings');
  $('#settings-btn').addEventListener('click', () => {
    const s = loadSettings();
    $('#protein-target').value = s.proteinTarget || '';
    dlg.showModal();
  });
  $('#settings-save').addEventListener('click', (e) => {
    e.preventDefault();
    const target = Number($('#protein-target').value) || null;
    saveSettings({ ...loadSettings(), proteinTarget: target });
    dlg.close(); toast('Settings saved ✓'); updatePeriod();
    $('#save-status').textContent = `Saved · protein target ${target || '—'} g`;
  });
}

/* ---------- sync status ---------- */
async function refreshSyncStatus() {
  const keys = await dbAllDates();
  const s = loadSettings();
  $('#sync-status').textContent = keys.length
    ? `${keys.length} day(s) on this device · range ${keys.sort()[0]} → ${keys.sort().slice(-1)[0]}`
    : 'No data yet — log a check-in or load sample';
  $('#import-sample').hidden = keys.length > 0;
}

/* ---------- service worker ---------- */
function registerSW() {
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

/* ---------- boot ---------- */
(async function boot() {
  renderChips();
  wireSlider('#energy', '#energy-value', energyLabel);
  wireSlider('#hunger', '#hunger-value', hungerLabel);
  wireSlider('#fog', '#fog-value', fogLabel);
  wirePhoto();
  wireSettings();
  $('#save').addEventListener('click', saveCheckIn);
  $('#export').addEventListener('click', exportJSON);
  $('#import-sample').addEventListener('click', importSample);
  await updatePeriod();
  await refreshHistory();
  await refreshSyncStatus();
  registerSW();
  // 60s clock tick
  setInterval(() => updatePeriod(), 60000);
})();
