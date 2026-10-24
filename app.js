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
function focusLabel(v) {
  if (v <= 3) return 'Low'; if (v <= 6) return 'Moderate'; return 'High';
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

/* ---------- med tracking helpers ---------- */
function collectSideEffects() {
  const boxes = document.querySelectorAll('.side-effects input[type="checkbox"]:checked');
  return Array.from(boxes).map(b => b.value);
}
function wireMedToggle() {
  const toggle = $('#med-taken');
  const details = $('#med-details');
  const update = () => { details.hidden = !toggle.checked; };
  toggle.addEventListener('change', update);
  update();
}
function setMedDefaults() {
  // Autofill med name/dose from settings (they rarely change within a day).
  // medStartTime is the *start date* of the medication (settings/export), not
  // the daily time-taken, so it intentionally does NOT autofill here.
  const s = loadSettings();
  if (s.currentMed) $('#med-name').value = s.currentMed;
  if (s.currentDose) $('#med-dose').value = s.currentDose;
}

/* ---------- Barcode lookup (Open Food Facts v2) ----------
   - Single product endpoint: GET https://world.openfoodfacts.org/api/v2/product/{code}.json
   - No API key. CORS: *.
   - Returns `nutriments` per 100g / 100ml and `quantity_number` / `quantity_unit`;
     we scale to the whole package for the preview card.
   - Local cache in localStorage so repeat scans are offline-fast and don't re-hit the API.
*/
const OFF_URL = (code) =>
  `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}` +
  `?json=1` +
  `&fields=code,product_name,brands,quantity,quantity_number,quantity_unit,status` +
  `,nutriments.proteins_100g,nutriments.energ-kcal_100g,nutriments.carbohydrates_100g,nutriments.fat_100g` +
  `,nutriments.saturated-fat_100g,nutriments.sugars_100g,nutriments.fiber_100g,nutriments.salt_100g,nutriments.sodium_100g`;

const OFF_CACHE_KEY = 'nutrition.off-cache.v1';
function offCache() { try { return JSON.parse(localStorage.getItem(OFF_CACHE_KEY)) || {}; } catch { return {}; } }
function offCacheSet(code, rec) {
  const all = offCache();
  all[code] = { ...rec, _ts: Date.now() };
  // soft trim: keep most-recent 200
  const keys = Object.keys(all).sort((a, b) => (all[b]._ts || 0) - (all[a]._ts || 0)).slice(0, 200);
  for (const k of Object.keys(all)) if (!keys.includes(k)) delete all[k];
  try { localStorage.setItem(OFF_CACHE_KEY, JSON.stringify(all)); } catch { /* quota */ }
}
function offCacheGet(code) { return offCache()[code] || null; }

const OFF_FIELDS = [
  ['kcal',   'nutriments.energ-kcal_100g'],
  ['protein','nutriments.proteins_100g'],
  ['carbs',  'nutriments.carbohydrates_100g'],
  ['fat',    'nutriments.fat_100g'],
];

function cleanBarcode(raw) {
  // Digits only. Don't strip leading zeros — they carry meaning for EAN-13 (e.g. US/Canada prefix "0").
  return (raw || '').replace(/\D+/g, '').slice(0, 14);
}

async function offLookup(code) {
  const norm = cleanBarcode(code);
  if (!norm) throw new Error('No barcode to look up.');
  const cached = offCacheGet(norm);
  if (cached) {
    return { ...cached, _source: 'cache' };
  }
  const res = await fetch(OFF_URL(norm), { cache: 'no-store' });
  if (!res.ok) throw new Error(`OFF responded ${res.status}`);
  const d = await res.json();
  if (d.status !== 1 || !d.product) {
    if (d.status === 0) throw new Error('Product not found in Open Food Facts.');
    throw new Error(`OFF returned status ${d.status}.`);
  }
  const p = d.product;
  const qtyNum = Number(p.quantity_number || 0) || 0;
  const qtyUnit = p.quantity_unit || '';
  const rec = {
    code: p.code || norm,
    name: p.product_name || null,
    brand: p.brands || null,
    qty: p.quantity || null,
    qtyNum, qtyUnit,
    per100: OFF_FIELDS.map(([k, field]) => {
      const v = p.nutriments && p.nutriments[field.split('.')[1]];
      return { k, v: (v === undefined || v === null || v === '') ? null : Number(v) };
    }),
    countries: p.countries || null,
  };
  offCacheSet(norm, rec);
  return { ...rec, _source: 'live' };
}

function fmtQty(rec) {
  if (rec.qty) return rec.qty;
  if (rec.qtyNum && rec.qtyUnit) return `${rec.qtyNum} ${rec.qtyUnit}`;
  return null;
}

// Best-effort parse of OFF's `quantity` string ("400 g e", "250 ml", "100 g", "150 g, 4 x 150 g", ...).
// Returns {n, unit} or null.
function parseQuantityString(qty) {
  if (!qty) return null;
  const s = String(qty).trim().toLowerCase();
  // Grab first number.
  const m = s.match(/(\d+[.,]?\d*)\s*(ml|l|g|kg|kg|oz|lb)?/);
  if (!m) return null;
  const raw = m[1].replace(',', '.');
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  let unit = m[2] || '';
  // Convert kg -> g; oz/lb -> approximate g only if you want — we leave them alone and skip scaling.
  if (unit === 'kg') { return { n: n * 1000, unit: 'g' }; }
  if (!unit) return { n, unit: '' };
  if (unit === 'ml' || unit === 'l') return { n, unit };
  if (unit === 'l') return { n: n * 1000, unit: 'ml' };
  return { n, unit };
}
function qtyFactor(rec) {
  // OFF per-100 units: 100g or 100ml. Convert our quantity -> multiplier.
  const n = (rec.qtyNum != null) ? Number(rec.qtyNum) : null;
  const u = (rec.qtyUnit || '').toLowerCase();
  if (Number.isFinite(n) && n > 0) {
    const factor = (n / 100);
    // If unit is a volume or grams, OFF's _100g fields are per 100 g/ml. Good.
    // For weightless units (pieces) we can't trust the multiplier — caller falls back.
    if (u.startsWith('ml') || u.startsWith('l') || u.startsWith('g') || u === 'kg' || !u) return factor;
    return null; // unknown unit -> refuse to scale instead of guessing
  }
  // Fall back to parsing the quantity string.
  const parsed = parseQuantityString(rec.qty);
  if (parsed && Number.isFinite(parsed.n)) {
    if (parsed.unit.startsWith('ml') || parsed.unit.startsWith('l') || parsed.unit.startsWith('g') || parsed.unit === '' || parsed.unit === 'oz') {
      return parsed.n / 100;
    }
    return null;
  }
  return null;
}
function perPackage(rec) {
  const factor = qtyFactor(rec);
  if (factor == null) return rec.per100; // can't scale -> show per-100 values (UI will flag this)
  return rec.per100.map(p => p.v === null ? { k: p.k, v: null } : { k: p.k, v: round1(Number(p.v) * factor) });
}
function round1(x) { return Math.round((x + Number.EPSILON) * 10) / 10; }

function offRenderResult(rec) {
  const box = $('#barcode-result');
  const scaled = qtyFactor(rec) != null;
  const total = perPackage(rec);
  const u = scaled ? '' : ' per 100g';
  const row = (label, key, unit) => {
    const p = total.find(x => x.k === key) || { v: null };
    const v = p.v === null ? '—' : p.v;
    return `<span class="bc-stat"><b>${v}</b>${unit}${u ? ' <i class="muted" style="font-size:.75em;font-style:normal">/100g</i>' : ''}</span>` +
           `<span class="bc-stat-l">${label}</span>`;
  };
  const name = rec.name ? escapeHtml(rec.name) : '(unnamed product)';
  const brand = rec.brand ? ` · ${escapeHtml(rec.brand)}` : '';
  const qty = fmtQty(rec) ? ` · ${escapeHtml(fmtQty(rec))}` : '';
  const src = rec._source === 'cache' ? '' : ' · <span class="bc-live">live</span>';
  const note = scaled ? '' :
    '<p class="muted bc-note">Couldn&rsquo;t determine package size &mdash; showing per-100-g values. Portion by hand when you add it.</p>';
  box.innerHTML = `
    <div class="bc-card">
      <div class="bc-name">${name}${brand}${qty}${src}</div>
      <div class="bc-stats">
        ${row('kcal','kcal',' kcal')}
        ${row('protein','protein',' g')}
        ${row('carbs','carbs',' g')}
        ${row('fat','fat',' g')}
      </div>
      ${note}
      <div class="bc-actions">
        <button id="bc-add" class="soft" type="button" style="flex:0 0 auto">＋ Add to this check-in</button>
        <span id="bc-added" class="muted" hidden>Added ✓</span>
      </div>
    </div>`;
  box.hidden = false;
  const addBtn = $('#bc-add');
  addBtn.addEventListener('click', (e) => {
    const label = rec.name || '(unnamed product)';
    addFoodToInput(label);
    addBtn.disabled = true;
    $('#bc-added').hidden = false;
    setTimeout(() => { $('#bc-added').hidden = true; addBtn.disabled = false; }, 1400);
  });
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function addFoodToInput(label) {
  const val = $('#food-input');
  const items = val.value ? val.value.split(',').map((s) => s.trim()).filter(Boolean) : [];
  if (!items.includes(label)) items.push(label);
  val.value = items.join(', ');
  val.dispatchEvent(new Event('input', { bubbles: true }));
}

/* ---------- Barcode camera (native BarcodeDetector + getUserMedia) ----------
   - Chrome, Edge, and Safari 17+ expose `BarcodeDetector`.
   - For other browsers we show a helpful message and still allow typing.
   - Frames are decoded in a rAF loop; on hit we stop everything, close the camera,
     and fire a `barcode-detected` event on `#barcode-block`.
*/
let _scanning = false;
async function startScan() {
  if (_scanning) return;
  if (typeof BarcodeDetector === 'undefined') {
    $('#barcode-status').textContent = 'Camera barcode decode not supported in this browser — please type the barcode instead (e.g. 3017620422003).';
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    $('#barcode-status').textContent = 'Camera not available — please type the barcode instead.';
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
    const video = $('#scan-video');
    video.srcObject = stream;
    $('#scan-view').hidden = false;
    $('#scan-hint').hidden = false;
    $('#btn-scan').hidden = true;
    $('#btn-stop-scan').hidden = false;
    _scanning = true;
    const Detector = window.BarcodeDetector;
    const detector = new Detector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code'] });
    video.onloadedmetadata = () => video.play().catch(() => {});
    let stopped = false;
    const tick = async () => {
      if (stopped || !_scanning) return;
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        try {
          const codes = await detector.detect(video);
          if (codes && codes.length) {
            const code = codes[0].rawValue || codes[0].displayValue || '';
            onBarcodeDetected(code);
            stopScan();
            return;
          }
        } catch (e) { /* keep ticking */ }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  } catch (e) {
    $('#barcode-status').textContent = 'Camera error: ' + (e && e.message ? e.message : e);
    $('#btn-scan').hidden = false;
    $('#btn-stop-scan').hidden = true;
    $('#scan-view').hidden = true;
  }
}
function stopScan() {
  _scanning = false;
  const v = $('#scan-video');
  if (v && v.srcObject) {
    for (const t of v.srcObject.getTracks()) t.stop();
    v.srcObject = null;
  }
  $('#scan-view').hidden = true;
  $('#scan-hint').hidden = true;
  $('#btn-scan').hidden = false;
  $('#btn-stop-scan').hidden = true;
}
function onBarcodeDetected(code) {
  $('#barcode-input').value = code;
  $('#barcode-status').textContent = `Detected ${code} — look it up →`;
}
function wireBarcode() {
  const btn = $('#btn-lookup');
  btn.addEventListener('click', async (e) => {
    const code = $('#barcode-input').value;
    if (!code.trim()) { $('#barcode-status').textContent = 'Type or scan a barcode first.'; return; }
    e.currentTarget.disabled = true;
    $('#barcode-status').textContent = 'Looking up…';
    $('#barcode-result').hidden = true;
    try {
      const rec = await offLookup(code);
      offRenderResult(rec);
      $('#barcode-status').textContent = (rec._source === 'cache' ? 'From local cache · ' : '') + `Found "${rec.name || 'product'}"`;
    } catch (err) {
      $('#barcode-status').textContent = err && err.message ? err.message : 'Lookup failed.';
    } finally {
      btn.disabled = false;
    }
  });
  const scanBtn = $('#btn-scan');
  scanBtn.addEventListener('click', startScan);
  $('#btn-stop-scan').addEventListener('click', stopScan);
  // Also let Enter in the barcode input trigger a lookup.
  $('#barcode-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); btn.click(); }
  });
  // Clean up camera on page hide.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && _scanning) stopScan();
  });
}

/* ---------- save check-in ---------- */
async function saveCheckIn() {
  const food = $('#food-input').value.trim();
  const energy = Number($('#energy').value);
  const hunger = Number($('#hunger').value);
  const fog = Number($('#fog').value);
  const focus = Number($('#focus').value);
  const notes = $('#notes').value.trim();
  const date = todayISO();
  const stamp = new Date();

  // med data
  const medTaken = $('#med-taken').checked;
  const medData = medTaken ? {
    taken: true,
    name: $('#med-name').value.trim() || null,
    dose: ($('#med-dose').value.trim() + '').replace(/\s*mg\s*/i, 'mg').trim() || null,
    time: $('#med-time').value || null,
    focus,
    sideEffects: collectSideEffects(),
  } : { taken: false };

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
    energy, hunger, fog, focus,
    photoRef: photo,
    photoName: photo ? (photoPreviewUrl && photoPreviewUrl.name) || 'photo.jpg' : null,
    medData,
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
  const medInfo = medData.taken ? ` · 💊 ${medData.name || 'med'} ${medData.dose || ''}` : '';
  $('#save-status').textContent = `Saved ${fmtTime(stamp)} · protein target ${s.proteinTarget || '—'} g${medInfo}`;
  // reset transient form
  $('#food-input').value = ''; $('#notes').value = '';
  document.querySelectorAll('#chips .chip').forEach((c) => c.setAttribute('aria-pressed', 'false'));
  $('#photo-input').value = ''; photoPreviewUrl = null;
  $('#photo-status').textContent = ''; $('#photo-preview').hidden = true; $('#photo-img').src = '';
  // reset barcode state (keep code + last lookup for convenience; they help re-add the same item)
  stopScan();
  // reset med checkboxes
  document.querySelectorAll('.side-effects input[type="checkbox"]').forEach((c) => c.checked = false);
  // keep med name/dose/time for convenience (they rarely change within a day); reset taken
  $('#med-taken').checked = false;
  $('#med-details').hidden = true;
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
    const medStr = last && last.medData && last.medData.taken
      ? ` · 💊 ${last.medData.name || 'med'} ${last.medData.dose || ''}`
      : '';
    li.innerHTML =
      `<div>${e.date} · E${last.energy} · F${last.focus ?? '—'}${medStr}</div>` +
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
      formatVersion: '2.0',
      exportTimestamp: new Date().toISOString(),
      deviceInfo: { app: 'nutrition-tracker', screen: window.screen.width + 'x' + window.screen.height },
      proteinTarget: s.proteinTarget || null,
      currentMed: s.currentMed || null,
      currentDose: s.currentDose || null,
      medStartDate: s.medStartDate || null,
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
    $('#current-med').value = s.currentMed || '';
    $('#current-dose').value = s.currentDose || '';
    $('#med-start-date').value = s.medStartDate || '';
    dlg.showModal();
  });
  $('#settings-save').addEventListener('click', (e) => {
    e.preventDefault();
    const s = loadSettings();
    saveSettings({
      ...s,
      proteinTarget: Number($('#protein-target').value) || null,
      currentMed: $('#current-med').value.trim() || null,
      currentDose: ($('#current-dose').value.trim() + '').replace(/\s*mg\s*/i, 'mg').trim() || null,
      medStartDate: ($('#med-start-date').value || '').length ? $('#med-start-date').value : null,
    });
    // persist defaults so they autofill on next check-in
    setMedDefaults();
    dlg.close(); toast('Settings saved ✓'); updatePeriod();
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
  wireSlider('#focus', '#focus-value', focusLabel);
  wirePhoto();
  wireMedToggle();
  setMedDefaults();
  wireSettings();
  wireBarcode();
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
