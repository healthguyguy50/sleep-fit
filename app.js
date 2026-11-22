'use strict';
/* 睡眠健身紀錄 v2 — App（前端）
 * 資料先存在這台裝置（IndexedDB），有網路時再和 GAS 同步，所以離線也能記錄。 */
const APP_VERSION = '2.0.0';

/* ============================================================
 * 共用邏輯（和 Code.gs 相同，修改時兩邊要一起改）
 * ============================================================ */
const NUT_FIELDS = ['name', 'kcal', 'protein', 'carbs', 'fat', 'aiStatus', 'aiNote'];
const SERVER_FIELDS = ['photoId', 'thumbId'];

function mergeRec(t, a, b) {
  if (!a) return Object.assign({}, b);
  if (!b) return Object.assign({}, a);
  const n = x => Number(x) || 0;
  const m = Object.assign({}, n(b.updatedAt) > n(a.updatedAt) ? b : a);
  if (t === 'meal') {
    const nut = n(b.nutAt) > n(a.nutAt) ? b : a;
    NUT_FIELDS.forEach(f => { m[f] = nut[f]; });
    m.nutAt = Math.max(n(a.nutAt), n(b.nutAt));
    SERVER_FIELDS.forEach(f => { m[f] = b[f] || a[f] || ''; });
  }
  m.updatedAt = Math.max(n(a.updatedAt), n(b.updatedAt));
  m.t = t;
  return m;
}

function pairNights(events, now) {
  now = now || Date.now();
  const ev = events.filter(e => e && !e.deleted && e.time && (e.kind === 'bed' || e.kind === 'wake'))
    .sort((x, y) => (x.time - y.time) || (x.kind === 'bed' ? -1 : 1));
  const nights = [];
  let bed = null;
  ev.forEach(e => {
    if (e.kind === 'bed') { bed = e; return; }
    if (bed && e.time > bed.time && e.time - bed.time <= 20 * 36e5) {
      nights.push({ bed, wake: e, hours: Math.round((e.time - bed.time) / 36e5 * 10) / 10,
        quality: Number(e.quality) || null, tags: bed.tags || '' });
    }
    bed = null;
  });
  return { nights, open: bed && now - bed.time < 20 * 36e5 ? bed : null };
}

/* ============================================================
 * 常數與狀態
 * ============================================================ */
const H = 36e5, DAY = 864e5;
const Q_LABELS = ['很差', '差', '普通', '不錯', '很好'];
const INTENS = ['輕鬆', '適中', '很累'];
const MEALS = ['早餐', '午餐', '點心', '晚餐', '宵夜'];
const PORTIONS = ['小', '中', '大'];
const EATEN = ['全部', '大半', '一半', '少量'];

const DEFAULT_SETTINGS = {
  workoutTypes: ['重訓', '跑步', '騎車', '游泳', '瑜伽', '健走'],
  durations: [15, 30, 45, 60, 90],
  sleepTags: ['喝咖啡', '喝酒', '有運動', '滑手機太晚', '壓力大', '吃宵夜'],
  mealTags: ['自煮', '外食', '有蔬菜', '有蛋白質', '含糖飲料', '油炸', '吃太飽'],
  restSeconds: 90, weightStep: 2.5,
  templates: { 推日: ['臥推', '上斜啞鈴臥推', '肩推', '側平舉', '三頭下壓'],
    拉日: ['引體向上', '槓鈴划船', '滑輪下拉', '面拉', '二頭彎舉'],
    腿日: ['深蹲', '羅馬尼亞硬舉', '腿推', '腿彎舉', '提踵'] },
  goal: '均衡', kcalGoal: null, proteinGoal: null,
  ai: { provider: '', model: '', auto: true, dailyLimit: 10, context: true, enabled: false }
};

const S = {
  cfg: null,               // { api, key, deviceId, deviceName }
  R: new Map(),            // 所有資料：id → record
  settings: DEFAULT_SETTINGS,
  devices: {},             // 裝置 id → 名稱
  lastSync: 0, lastOk: 0, syncing: false, syncAgain: false, syncErr: '', authErr: '', skew: 0,
  pendingUploads: new Set(), aiRunning: new Set(), thumbs: new Map(), thumbTried: new Set(),
  advice: new Map(), session: null, tab: 'sleep', swReg: null, restTimer: null,
  ui: { sleepTags: [], bfQ: null, wType: null, dur: null, inten: '適中', sInten: '適中', bwType: '重訓', bwInten: '適中',
    fMeal: null, fPortion: '中', fEaten: '全部', fTags: [], photo: null, foodDate: null }
};
window.__S = S; // 方便除錯

/* ============================================================
 * 小工具
 * ============================================================ */
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const dayStr = ms => { const d = new Date(ms); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const today = () => dayStr(Date.now());
const hm = ms => { const d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
const md = ms => { const d = new Date(ms); return (d.getMonth() + 1) + '/' + d.getDate(); };
const toInput = ms => dayStr(ms) + 'T' + hm(ms);
const fromInput = v => { const t = v ? new Date(v).getTime() : NaN; return isFinite(t) ? t : null; };
const num = n => String(Math.round((Number(n) || 0) * 10) / 10);
const splitTags = s => String(s || '').split(/[,，、]/).map(x => x.trim()).filter(Boolean);
const toggle = (arr, v) => { const i = arr.indexOf(v); if (i >= 0) arr.splice(i, 1); else arr.push(v); };
const newId = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const nowTs = () => Date.now() + (Math.abs(S.skew) > 120000 ? S.skew : 0); // 裝置時間誤差太大時以伺服器時間校正
const numIn = id => { const v = $(id).value.trim(); return v === '' || !isFinite(Number(v)) ? null : Number(v); };
const stripRec = r => { const o = {}; Object.keys(r).forEach(k => { if (k[0] !== '_') o[k] = r[k]; }); return o; };
const safeImg = u => (/^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(String(u || '')) ? u : '');
const devName = id => S.devices[id] || '其他裝置';
const devTag = r => (r && r.device && S.cfg && r.device !== S.cfg.deviceId && S.devices[r.device]) ? '・' + esc(devName(r.device)) : '';
function guessMeal(ms) {
  const d = new Date(ms || Date.now()), h = d.getHours() + d.getMinutes() / 60;
  return h < 4 ? '宵夜' : h < 10.5 ? '早餐' : h < 14.5 ? '午餐' : h < 17 ? '點心' : h < 21 ? '晚餐' : '宵夜';
}
function normSettings(s) {
  const o = Object.assign({}, DEFAULT_SETTINGS, s || {});
  o.ai = Object.assign({}, DEFAULT_SETTINGS.ai, (s && s.ai) || {});
  if (!o.workoutTypes.length) o.workoutTypes = DEFAULT_SETTINGS.workoutTypes;
  if (!o.durations.length) o.durations = DEFAULT_SETTINGS.durations;
  return o;
}

/* ============================================================
 * 本機資料庫（IndexedDB）
 * ============================================================ */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('sleepfit', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('rec', { keyPath: 'id' });
        d.createObjectStore('blob', { keyPath: 'k' });
        d.createObjectStore('meta', { keyPath: 'k' });
      };
      r.onsuccess = () => { DB.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  _tx(store, mode, fn) {
    return new Promise((res, rej) => {
      const tx = DB.db.transaction(store, mode), st = tx.objectStore(store);
      let out;
      const q = fn(st);
      if (q) q.onsuccess = () => { out = q.result; };
      tx.oncomplete = () => res(out);
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error || new Error('儲存失敗（裝置空間可能不足）'));
    });
  },
  all: store => DB._tx(store, 'readonly', st => st.getAll()),
  get: (store, k) => DB._tx(store, 'readonly', st => st.get(k)),
  keys: (store, prefix) => DB._tx(store, 'readonly', st => st.getAllKeys(IDBKeyRange.bound(prefix, prefix + '￿'))),
  put: (store, v) => DB._tx(store, 'readwrite', st => st.put(v)),
  putMany: (store, arr) => arr.length ? DB._tx(store, 'readwrite', st => { arr.forEach(v => st.put(v)); }) : Promise.resolve(),
  del: (store, k) => DB._tx(store, 'readwrite', st => st.delete(k)),
  clear: store => DB._tx(store, 'readwrite', st => st.clear())
};
const getMeta = async k => { const r = await DB.get('meta', k); return r ? r.v : undefined; };
const setMeta = (k, v) => DB.put('meta', { k, v });

/* ============================================================
 * 資料操作
 * ============================================================ */
function recsAll(t) { const out = []; S.R.forEach(r => { if (r.t === t) out.push(r); }); return out; }
function recs(t) { return recsAll(t).filter(r => !r.deleted); }
function dirtyCount() { let n = 0; S.R.forEach(r => { if (r._dirty) n++; }); return n; }

/** 存一筆資料：base 更新一般欄位的時間戳，nut 更新營養欄位的時間戳 */
async function saveRec(r, opt) {
  opt = Object.assign({ base: true, nut: false }, opt);
  const now = nowTs(), old = S.R.get(r.id) || {};
  const rec = Object.assign({}, r);
  if (opt.base) { rec.updatedAt = Math.max(now, (old.updatedAt || 0) + 1); rec.device = S.cfg.deviceId; }
  if (opt.nut) rec.nutAt = Math.max(now, (old.nutAt || 0) + 1);
  if (!rec.updatedAt) rec.updatedAt = now;
  rec._dirty = 1;
  S.R.set(rec.id, rec);
  await DB.put('rec', rec);
  renderStatus();
  scheduleSync();
  return rec;
}

async function softDelete(id) {
  const r = S.R.get(id);
  if (!r) return;
  await saveRec(Object.assign({}, r, { deleted: true }));
  if (S.pendingUploads.has(id)) { S.pendingUploads.delete(id); await DB.del('blob', 'up:' + id); }
}

/* ============================================================
 * 伺服器
 * ============================================================ */
async function api(action, payload, timeoutMs) {
  if (!S.cfg) throw new Error('這台裝置還沒有配對');
  const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), timeoutMs || 90000);
  let res;
  try {
    res = await fetch(S.cfg.api, { method: 'POST', body: JSON.stringify(Object.assign({ action, key: S.cfg.key }, payload || {})), signal: ctl.signal });
  } catch (e) {
    const err = new Error(e.name === 'AbortError' ? '連線逾時' : '無法連線到伺服器');
    err.code = 'network';
    throw err;
  } finally { clearTimeout(tm); }
  let data;
  try { data = await res.json(); } catch (e) {
    const err = new Error('伺服器回應格式錯誤（' + res.status + '），請確認 GAS 已部署且權限設定正確');
    err.code = 'server';
    throw err;
  }
  if (data.serverTime) S.skew = data.serverTime - Date.now();
  if (!data.ok) {
    const err = new Error(data.error || '伺服器錯誤');
    err.code = data.code;
    if (data.code === 'unauthorized') { S.authErr = data.error; renderBanner(); renderStatus(); }
    throw err;
  }
  return data;
}

/* ============================================================
 * 同步：先送出這台裝置的修改，再取回其他裝置的修改
 * ============================================================ */
let syncTimer = null;
function scheduleSync(ms) { clearTimeout(syncTimer); syncTimer = setTimeout(() => sync(), ms == null ? 1500 : ms); }

async function sync() {
  if (!S.cfg) return;
  if (S.syncing) { S.syncAgain = true; return; }
  if (!navigator.onLine) { renderStatus(); return; }
  S.syncing = true; S.syncErr = '';
  renderStatus();
  try {
    for (let round = 0; round < 6; round++) {
      const sent = [];
      S.R.forEach(r => { if (r._dirty && sent.length < 200) sent.push(stripRec(r)); });
      const res = await api('sync', { since: S.lastSync, changes: sent });
      await applySync(res, sent);
      if (!dirtyCount()) break;
    }
    S.authErr = '';
    await uploadPending();
    await runPendingAi();
    S.lastOk = Date.now();
  } catch (e) {
    S.syncErr = e.message;
  } finally {
    S.syncing = false;
    renderStatus(); renderBanner(); renderActive();
    if (S.syncAgain) { S.syncAgain = false; scheduleSync(300); }
  }
}

/** 把伺服器的版本併入本機（本機還沒送出的較新修改會保留） */
function mergeIn(sr) {
  delete sr.syncedAt;
  const local = S.R.get(sr.id);
  let next;
  if (!local || !local._dirty) next = sr;
  else { next = mergeRec(sr.t, sr, local); next._dirty = 1; }
  if (local && local._order !== undefined && next._order === undefined) next._order = local._order;
  S.R.set(sr.id, next);
  return next;
}

async function applySync(res, sent) {
  const puts = [], dels = [];
  sent.forEach(s => {
    const cur = S.R.get(s.id);
    if (cur && cur._dirty && (cur.updatedAt || 0) === (s.updatedAt || 0) && (cur.nutAt || 0) === (s.nutAt || 0)) {
      delete cur._dirty;
      puts.push(cur);
    }
  });
  (res.records || []).forEach(sr => puts.push(mergeIn(sr)));
  const foods = res.foods || [], keep = new Set(foods.map(f => f.id));
  foods.forEach((f, i) => { const r = mergeIn(f); r._order = i; puts.push(r); });
  S.R.forEach(r => { if (r.t === 'food' && !keep.has(r.id) && !r._dirty) { S.R.delete(r.id); dels.push(r.id); } });
  await DB.putMany('rec', puts);
  for (const id of dels) await DB.del('rec', id);
  S.settings = normSettings(res.settings);
  S.devices = {};
  (res.devices || []).forEach(d => { S.devices[d.id] = d.name; });
  S.lastSync = res.serverTime || S.lastSync;
  await setMeta('settings', S.settings);
  await setMeta('devices', S.devices);
  await setMeta('lastSync', S.lastSync);
}

/** 上傳離線時拍的照片（成功後才刪掉手機上的暫存） */
async function uploadPending() {
  const keys = await DB.keys('blob', 'up:');
  for (const k of keys) {
    const id = k.slice(3), m = S.R.get(id);
    if (!m || m.deleted) { await DB.del('blob', k); S.pendingUploads.delete(id); continue; }
    const b = await DB.get('blob', k);
    if (!b) continue;
    const analyze = !!(S.settings.ai.enabled && S.settings.ai.auto && m.aiStatus === 'pending');
    if (analyze) S.aiRunning.add(id);
    renderIf('food');
    try {
      const sent = stripRec(m);
      const res = await api('uploadPhoto', { meal: sent, full: b.full, thumb: b.thumb, analyze }, 180000);
      await DB.del('blob', k);
      S.pendingUploads.delete(id);
      const cur = S.R.get(id);
      if (cur && cur._dirty && cur.updatedAt === sent.updatedAt && (cur.nutAt || 0) === (sent.nutAt || 0)) delete cur._dirty;
      if (res.meal) await DB.put('rec', mergeIn(res.meal));
    } finally {
      S.aiRunning.delete(id);
      renderIf('food');
    }
  }
}

async function runPendingAi() {
  if (!S.settings.ai.enabled || !S.settings.ai.auto) return;
  const list = recs('meal').filter(m => m.aiStatus === 'pending' && !m._dirty && !S.pendingUploads.has(m.id) && !S.aiRunning.has(m.id)).slice(0, 3);
  for (const m of list) await analyzeMeal(m.id, true);
}

async function analyzeMeal(id, quiet) {
  S.aiRunning.add(id);
  renderIf('food');
  try {
    const res = await api('analyzeMeal', { id }, 120000);
    const r = mergeIn(res.meal);
    await DB.put('rec', r);
    if (!quiet) snack(r.aiStatus === 'done' ? 'AI 分析完成' : 'AI 分析未完成：' + (r.aiNote || ''), { err: r.aiStatus !== 'done' });
  } catch (e) {
    if (!quiet) snack('AI 分析失敗：' + e.message, { err: true });
  } finally {
    S.aiRunning.delete(id);
    renderIf('food');
  }
}

/* ============================================================
 * 畫面：共用元件
 * ============================================================ */
function chips(el, items, isOn, onTap, label) {
  if (!el) return;
  el.innerHTML = '';
  items.forEach((it, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (isOn(it, i) ? ' on' : '');
    if (label) b.innerHTML = label(it); else b.textContent = it;
    b.onclick = () => onTap(it, i);
    el.appendChild(b);
  });
}

let snackTimer = null;
function snack(msg, opt) {
  opt = opt || {};
  const el = $('snack');
  el.innerHTML = '<span>' + esc(msg) + '</span>' + (opt.action ? '<button type="button">' + esc(opt.action.label) + '</button>' : '');
  el.className = 'show' + (opt.err ? ' err' : '');
  if (opt.action) el.querySelector('button').onclick = () => { el.className = ''; opt.action.fn(); };
  clearTimeout(snackTimer);
  snackTimer = setTimeout(() => { el.className = ''; }, opt.ms || (opt.action ? 5000 : 2600));
}
const toast = (msg, err) => snack(msg, { err });

function openModal(html) { $('modalBox').innerHTML = html; $('modal').hidden = false; }
function closeModal() { $('modal').hidden = true; $('modalBox').innerHTML = ''; }

/** 危險操作要按兩次：第一次按鈕文字變成提示 */
function confirmTap(btn, label) {
  if (btn.dataset.armed === '1') return true;
  const old = btn.textContent;
  btn.dataset.armed = '1';
  btn.classList.add('armed');
  btn.textContent = label || '再按一次確認';
  setTimeout(() => { if (btn.isConnected) { btn.dataset.armed = ''; btn.classList.remove('armed'); btn.textContent = old; } }, 3000);
  return false;
}

async function busy(btn, promise) {
  if (btn) { btn.disabled = true; btn.dataset.label = btn.textContent; btn.textContent = '處理中…'; }
  try { return await promise; } finally {
    if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = btn.dataset.label; }
  }
}

function renderStatus() {
  const p = $('syncPill');
  if (!p) return;
  const n = dirtyCount() + S.pendingUploads.size;
  let cls = '', txt;
  if (S.authErr) { cls = 'err'; txt = '需要重新配對'; }
  else if (!navigator.onLine) { cls = n ? 'warn' : ''; txt = n ? '離線・' + n + ' 筆待同步' : '離線'; }
  else if (S.syncing) txt = '同步中…';
  else if (S.syncErr) { cls = 'err'; txt = '同步失敗・點此重試'; }
  else if (n) { cls = 'warn'; txt = n + ' 筆待同步'; }
  else { cls = 'ok'; txt = S.lastOk ? '已同步 ' + hm(S.lastOk) : '已連線'; }
  p.className = 'pill ' + cls;
  p.textContent = txt;
}

function renderBanner() {
  const bars = [];
  if (S.authErr) bars.push(['err', esc(S.authErr), '<button class="btn small" data-act="repair">重新配對</button>']);
  else if (S.syncErr && navigator.onLine) bars.push(['err', '同步失敗：' + esc(S.syncErr), '']);
  if (Math.abs(S.skew) > 120000) bars.push(['warn', '這台裝置的時間和伺服器相差約 ' + Math.round(Math.abs(S.skew) / 60000) + ' 分鐘，已自動校正；建議開啟手機的「自動設定時間」。', '']);
  if (S.updateReady) bars.push(['info', '有新版本', '<button class="btn small" data-act="swUpdate">更新</button>']);
  $('banner').innerHTML = bars.map(b => '<div class="bar ' + b[0] + '"><span>' + b[1] + '</span>' + b[2] + '</div>').join('');
}

function show(tab) {
  S.tab = tab;
  document.querySelectorAll('.tab').forEach(s => s.classList.toggle('on', s.id === 't-' + tab));
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  renderActive();
  window.scrollTo(0, 0);
}

function renderActive() {
  if (!S.cfg || $('app').hidden) return;
  ({ sleep: renderSleep, workout: renderWorkout, food: renderFood, stats: renderStats, more: renderMore })[S.tab]();
}
function renderIf(tab) { if (S.tab === tab) renderActive(); }

/* ============================================================
 * 睡眠
 * ============================================================ */
function renderSleep() {
  const { nights, open } = pairNights(recsAll('sleep'));
  const main = $('sleepMain');
  if (open) {
    main.innerHTML = '<div class="sub">已記錄就寢 ' + hm(open.time) + devTag(open) + (open.tags ? '・' + esc(open.tags) : '') + '</div>' +
      '<button class="btn primary big" data-act="wake">我起床了</button>' +
      '<button class="btn ghost" data-act="bedUndo" data-id="' + esc(open.id) + '">按錯了，取消這次就寢</button>';
  } else {
    main.innerHTML = '<div class="label top">今天的狀態（可複選，不選也可以）</div><div class="chips" id="sTags"></div>' +
      '<button class="btn primary big" data-act="bed">我要睡了</button>';
    chips($('sTags'), S.settings.sleepTags, t => S.ui.sleepTags.includes(t), t => { toggle(S.ui.sleepTags, t); renderSleep(); });
  }
  const last = nights[nights.length - 1], lc = $('sleepLast');
  if (!last) {
    lc.innerHTML = '<div class="sub">還沒有睡眠紀錄。睡前按「我要睡了」，起床按「我起床了」就好。</div>';
  } else {
    lc.innerHTML = '<div class="sub">上次睡眠' + devTag(last.wake) + '</div>' +
      '<div class="big-line">' + md(last.bed.time) + ' ' + hm(last.bed.time) + ' → ' + hm(last.wake.time) + '，<b>' + last.hours + '</b> 小時</div>' +
      (last.tags ? '<div class="sub">睡前：' + esc(last.tags) + '</div>' : '') +
      '<div class="label">睡得如何？</div><div class="chips" id="qChips"></div>';
    chips($('qChips'), Q_LABELS, (x, i) => Number(last.wake.quality) === i + 1, async (x, i) => {
      await saveRec(Object.assign({}, S.R.get(last.wake.id), { quality: i + 1 }));
      renderSleep();
      toast('已記錄睡眠品質：' + x);
    });
  }
  chips($('bfQ'), Q_LABELS, (x, i) => S.ui.bfQ === i + 1, (x, i) => { S.ui.bfQ = S.ui.bfQ === i + 1 ? null : i + 1; renderSleep(); });
}

const ACT = {};
ACT.bed = async () => {
  await saveRec({ id: newId('s'), t: 'sleep', kind: 'bed', time: nowTs(), tags: S.ui.sleepTags.join(','), quality: null, note: '', deleted: false });
  S.ui.sleepTags = [];
  renderSleep();
  toast('晚安，已記錄就寢時間');
};
ACT.wake = async () => {
  await saveRec({ id: newId('s'), t: 'sleep', kind: 'wake', time: nowTs(), tags: '', quality: null, note: '', deleted: false });
  renderSleep();
  const n = pairNights(recsAll('sleep')).nights.slice(-1)[0];
  toast(n ? '早安，睡了 ' + n.hours + ' 小時' : '已記錄起床時間');
};
ACT.bedUndo = async b => { if (!confirmTap(b)) return; await softDelete(b.dataset.id); renderSleep(); };
ACT.sleepBackfill = async () => {
  const bed = fromInput($('bfBed').value), wake = fromInput($('bfWake').value);
  if (!bed || !wake) return toast('請填就寢和起床時間', true);
  if (wake <= bed) return toast('起床時間要晚於就寢時間', true);
  if (wake - bed > 20 * H) return toast('一次睡眠不能超過 20 小時', true);
  if (recs('sleep').some(e => e.time >= bed - 60000 && e.time <= wake + 60000)) {
    return toast('這段時間已經有睡眠紀錄；要修改請先到「更多」刪除那一晚', true);
  }
  await saveRec({ id: newId('s'), t: 'sleep', kind: 'bed', time: bed, tags: '', quality: null, note: '補登', deleted: false });
  await saveRec({ id: newId('s'), t: 'sleep', kind: 'wake', time: wake, tags: '', quality: S.ui.bfQ, note: '補登', deleted: false });
  $('bfBed').value = ''; $('bfWake').value = ''; S.ui.bfQ = null;
  $('sleepBf').open = false;
  renderSleep();
  toast('已補登 ' + Math.round((wake - bed) / H * 10) / 10 + ' 小時');
};

/* ============================================================
 * 健身
 * ============================================================ */
function lastSetOf(name, excludeWorkout) {
  let best = null;
  S.R.forEach(r => {
    if (r.t === 'set' && !r.deleted && r.exercise === name && r.workoutId !== excludeWorkout && (!best || r.time > best.time)) best = r;
  });
  return best;
}
function mkEx(name) { const p = lastSetOf(name); return { name, weight: p ? Number(p.weight) : 20, reps: p ? Number(p.reps) : 8 }; }
function sessionSets() {
  return S.session ? recs('set').filter(s => s.workoutId === S.session.id).sort((a, b) => a.time - b.time) : [];
}
function checkSession() {
  if (!S.session) return;
  const w = S.R.get(S.session.id);
  if (!w || w.deleted || w.status === 'done') { S.session = null; setMeta('session', null); stopRest(); }
}

function renderWorkout() {
  const st = S.settings;
  checkSession();
  if (!S.ui.wType || !st.workoutTypes.includes(S.ui.wType)) S.ui.wType = S.session ? '重訓' : st.workoutTypes[0];
  chips($('wType'), st.workoutTypes, t => t === S.ui.wType, t => { S.ui.wType = t; renderWorkout(); });
  const strength = S.ui.wType === '重訓';
  $('cardio').hidden = strength;
  $('strength').hidden = !strength;
  renderNotice();
  if (strength) renderStrength(); else renderCardio();
  renderTodayWorkouts();
  chips($('bwType'), st.workoutTypes, t => t === S.ui.bwType, t => { S.ui.bwType = t; renderWorkout(); });
  chips($('bwInt'), INTENS, x => x === S.ui.bwInten, x => { S.ui.bwInten = x; renderWorkout(); });
}

function lastCardio() {
  return recs('workout').filter(w => w.type !== '重訓' && w.status === 'done').sort((a, b) => b.start - a.start)[0] || null;
}
function renderCardio() {
  const st = S.settings, L = lastCardio();
  if (!st.durations.includes(S.ui.dur)) S.ui.dur = st.durations[1] || st.durations[0];
  chips($('cDur'), st.durations.map(String), d => Number(d) === S.ui.dur, d => { S.ui.dur = Number(d); renderCardio(); });
  chips($('cInt'), INTENS, x => x === S.ui.inten, x => { S.ui.inten = x; renderCardio(); });
  $('cLast').textContent = L ? '上次：' + L.type + ' ' + (L.minutes || '?') + ' 分鐘' + (L.intensity ? '・' + L.intensity : '') + '（' + md(L.start) + '）' : '';
}

function renderNotice() {
  const others = recs('workout').filter(w => w.status === 'active' && (!S.session || w.id !== S.session.id));
  $('wkNotice').innerHTML = others.map(w => {
    const n = recs('set').filter(s => s.workoutId === w.id).length, stale = Date.now() - w.start > 8 * H;
    return '<div class="card notice"><div>' + (stale ? '有一個沒有結束的訓練' : '有進行中的訓練') + '：<b>' + esc(w.menu || w.type) + '</b>' + devTag(w) +
      '，' + md(w.start) + ' ' + hm(w.start) + ' 開始，已記錄 ' + n + ' 組</div><div class="row">' +
      (stale ? '' : '<button class="btn" data-act="wkAdopt" data-id="' + esc(w.id) + '">在這台接續</button>') +
      '<button class="btn" data-act="wkEndOther" data-id="' + esc(w.id) + '">標記為已結束</button></div></div>';
  }).join('');
}

function renderStrength() {
  const box = $('strength'), keep = $('addEx') ? $('addEx').value : '', st = S.settings, ss = S.session;
  if (!ss) {
    box.innerHTML = '<div class="card"><div class="label top">點選菜單開始訓練</div><div class="chips" id="tpl"></div>' +
      '<div class="label">或自訂動作（用逗號分隔）</div><input type="text" id="customEx" placeholder="深蹲, 臥推">' +
      '<button class="btn" data-act="wkCustom">開始自訂訓練</button></div>';
    chips($('tpl'), Object.keys(st.templates), () => false, n => startSession(n, st.templates[n]));
    return;
  }
  const sets = sessionSets(), mins = Math.max(0, Math.round((Date.now() - ss.start) / 60000));
  let h = '<div class="card"><b>' + esc(ss.menu) + '</b><div class="sub">' + hm(ss.start) + ' 開始・已進行 ' + mins + ' 分鐘・完成 ' + sets.length + ' 組</div>' +
    (mins > 480 ? '<div class="warn">這次訓練已超過 8 小時，記得按最下面的「結束訓練」。</div>' : '') + '</div>';
  ss.ex.forEach((e, i) => {
    const prev = lastSetOf(e.name, ss.id), mine = sets.filter(s => s.exercise === e.name);
    h += '<div class="card"><div class="row between"><b>' + esc(e.name) + '</b><span class="sub">' +
      (prev ? '上次 ' + num(prev.weight) + 'kg × ' + prev.reps : '第一次做') + '</span></div>' +
      '<div class="row stepper-row"><span class="sub">重量</span><div class="stepper">' +
      '<button type="button" data-act="adj" data-i="' + i + '" data-k="weight" data-d="-1" aria-label="減少重量">−</button><span>' + num(e.weight) + ' kg</span>' +
      '<button type="button" data-act="adj" data-i="' + i + '" data-k="weight" data-d="1" aria-label="增加重量">＋</button></div></div>' +
      '<div class="row stepper-row"><span class="sub">次數</span><div class="stepper">' +
      '<button type="button" data-act="adj" data-i="' + i + '" data-k="reps" data-d="-1" aria-label="減少次數">−</button><span>' + e.reps + ' 下</span>' +
      '<button type="button" data-act="adj" data-i="' + i + '" data-k="reps" data-d="1" aria-label="增加次數">＋</button></div></div>' +
      '<button class="btn primary" data-act="setDone" data-i="' + i + '">完成一組</button>' +
      (mine.length ? '<div class="sets">' + mine.map((s, k) => '<button type="button" class="setchip" data-act="setDel" data-id="' + esc(s.id) + '">第' + (k + 1) + '組 ' + num(s.weight) + '×' + s.reps + '</button>').join('') +
        '</div><div class="hint">按兩下某一組可以刪除</div>' : '') + '</div>';
  });
  h += '<div class="card"><div class="label top">加入其他動作</div>' +
    '<div class="row"><input type="text" id="addEx" placeholder="動作名稱"><button class="btn fit" data-act="addEx">加入</button></div>' +
    '<div class="label">整體強度</div><div class="chips" id="sInt"></div>' +
    '<div class="row"><button class="btn danger" data-act="wkCancel">放棄</button><button class="btn primary" data-act="wkFinish">結束訓練</button></div></div>';
  box.innerHTML = h;
  if (keep) $('addEx').value = keep;
  chips($('sInt'), INTENS, x => x === S.ui.sInten, x => { S.ui.sInten = x; renderStrength(); });
}

function renderTodayWorkouts() {
  const t = today(), list = recs('workout').filter(w => w.start && dayStr(w.start) === t).sort((a, b) => a.start - b.start);
  $('wkToday').innerHTML = '<div class="label top">今天的運動</div>' + (list.length ? list.map(w =>
    '<div class="li"><span>' + hm(w.start) + ' ' + esc(w.type) + (w.menu ? '・' + esc(w.menu) : '') + (w.minutes ? ' ' + w.minutes + ' 分鐘' : '') +
    (w.intensity ? '・' + esc(w.intensity) : '') + (w.note ? '・' + esc(w.note) : '') + (w.status === 'active' ? '（進行中）' : '') + devTag(w) + '</span></div>').join('')
    : '<div class="sub">還沒有紀錄</div>');
}

async function startSession(menu, list) {
  if (S.session) return toast('已經有進行中的訓練', true);
  const id = newId('w'), now = nowTs();
  S.session = { id, start: now, menu, ex: list.map(mkEx) };
  S.ui.sInten = '適中';
  await setMeta('session', S.session);
  await saveRec({ id, t: 'workout', start: now, end: null, type: '重訓', minutes: null, intensity: '', menu, note: '', status: 'active', deleted: false });
  renderWorkout();
}
ACT.wkCustom = () => {
  const list = $('customEx').value.split(/[,，、]/).map(s => s.trim()).filter(Boolean);
  if (!list.length) return toast('請輸入動作名稱', true);
  startSession('自訂訓練', list);
};
ACT.addEx = async () => {
  const n = $('addEx').value.trim();
  if (!n || !S.session) return;
  S.session.ex.push(mkEx(n));
  $('addEx').value = '';
  await setMeta('session', S.session);
  renderStrength();
};
ACT.adj = async b => {
  const e = S.session && S.session.ex[Number(b.dataset.i)];
  if (!e) return;
  const d = Number(b.dataset.d);
  if (b.dataset.k === 'weight') e.weight = Math.max(0, Math.round((e.weight + d * S.settings.weightStep) * 100) / 100);
  else e.reps = Math.max(1, e.reps + d);
  await setMeta('session', S.session);
  renderStrength();
};
ACT.setDone = async b => {
  const e = S.session && S.session.ex[Number(b.dataset.i)];
  if (!e) return;
  await saveRec({ id: newId('x'), t: 'set', workoutId: S.session.id, time: nowTs(), exercise: e.name, weight: e.weight, reps: e.reps, deleted: false });
  renderStrength();
  startRest();
  toast(e.name + ' ' + num(e.weight) + 'kg × ' + e.reps + ' 已記錄');
};
ACT.setDel = async b => { if (!confirmTap(b, '再按一次刪除')) return; await softDelete(b.dataset.id); renderStrength(); };
ACT.wkFinish = async () => {
  const ss = S.session, sets = sessionSets();
  if (!ss) return;
  if (!sets.length) return toast('還沒有完成任何一組；不練了可以按「放棄」', true);
  const w = S.R.get(ss.id), end = nowTs();
  await saveRec(Object.assign({}, w, { end, minutes: Math.max(1, Math.round((end - w.start) / 60000)), intensity: S.ui.sInten, status: 'done', note: sets.length + ' 組' }));
  S.session = null;
  await setMeta('session', null);
  stopRest();
  renderWorkout();
  toast('訓練完成，共 ' + sets.length + ' 組');
};
ACT.wkCancel = async b => {
  if (!confirmTap(b, '再按一次放棄（會刪除這次的組數）')) return;
  const ss = S.session;
  if (!ss) return;
  for (const s of sessionSets()) await softDelete(s.id);
  await softDelete(ss.id);
  S.session = null;
  await setMeta('session', null);
  stopRest();
  renderWorkout();
};
ACT.wkAdopt = async b => {
  if (S.session) return toast('這台裝置已經有進行中的訓練', true);
  const w = S.R.get(b.dataset.id);
  if (!w) return;
  const names = (S.settings.templates[w.menu] || []).slice();
  recs('set').filter(s => s.workoutId === w.id).forEach(s => { if (!names.includes(s.exercise)) names.push(s.exercise); });
  S.session = { id: w.id, start: w.start, menu: w.menu || '重訓', ex: names.map(mkEx) };
  await setMeta('session', S.session);
  S.ui.wType = '重訓';
  renderWorkout();
};
ACT.wkEndOther = async b => {
  const w = S.R.get(b.dataset.id);
  if (!w) return;
  const sets = recs('set').filter(s => s.workoutId === w.id).sort((a, c) => a.time - c.time);
  const end = sets.length ? sets[sets.length - 1].time : w.start + H;
  await saveRec(Object.assign({}, w, { end, minutes: Math.max(1, Math.round((end - w.start) / 60000)), status: 'done', note: sets.length + ' 組' }));
  renderWorkout();
};
ACT.cardioSave = async () => {
  const now = nowTs();
  await saveRec({ id: newId('w'), t: 'workout', start: now - S.ui.dur * 60000, end: now, type: S.ui.wType, minutes: S.ui.dur, intensity: S.ui.inten, menu: '', note: '', status: 'done', deleted: false });
  renderWorkout();
  toast('已記錄：' + S.ui.wType + ' ' + S.ui.dur + ' 分鐘');
};
ACT.cardioSame = async () => {
  const L = lastCardio();
  if (!L) return toast('還沒有上次的紀錄', true);
  const now = nowTs(), mins = Number(L.minutes) || 30;
  await saveRec({ id: newId('w'), t: 'workout', start: now - mins * 60000, end: now, type: L.type, minutes: mins, intensity: L.intensity, menu: '', note: '', status: 'done', deleted: false });
  renderWorkout();
  toast('已複製上次：' + L.type + ' ' + mins + ' 分鐘');
};

function parseSetLines(text) {
  const out = [], bad = [];
  String(text || '').split(/\n/).map(l => l.trim()).filter(Boolean).forEach(line => {
    const norm = line.replace(/(\d)\s*[x×*＊]\s*(?=\d)/gi, '$1 ').replace(/(kg|公斤)/gi, ' ').replace(/\s+/g, ' ').trim();
    const m = norm.match(/^(.+?)\s+(\d+(?:\.\d+)?)\s+(\d+)(?:\s+(\d+))?$/);
    if (!m) { bad.push(line); return; }
    out.push({ name: m[1].trim(), weight: Number(m[2]), reps: Number(m[3]), sets: Math.min(20, Math.max(1, Number(m[4] || 1))) });
  });
  return { out, bad };
}
ACT.wkBackfill = async () => {
  const start = fromInput($('bwTime').value), mins = numIn('bwMin');
  if (!start) return toast('請選開始時間', true);
  if (!mins || mins <= 0) return toast('請填時長（分鐘）', true);
  const p = parseSetLines($('bwSets').value);
  if (p.bad.length) return toast('看不懂這幾行：' + p.bad.join('、'), true);
  const id = newId('w');
  const total = p.out.reduce((a, x) => a + x.sets, 0);
  await saveRec({ id, t: 'workout', start, end: start + mins * 60000, type: S.ui.bwType, minutes: mins, intensity: S.ui.bwInten, menu: '', note: '補登' + (total ? '・' + total + ' 組' : ''), status: 'done', deleted: false });
  let k = 0;
  for (const x of p.out) {
    for (let i = 0; i < x.sets; i++) {
      await saveRec({ id: newId('x'), t: 'set', workoutId: id, time: start + (k++) * 120000, exercise: x.name, weight: x.weight, reps: x.reps, deleted: false });
    }
  }
  $('bwTime').value = ''; $('bwMin').value = ''; $('bwSets').value = '';
  $('bwBox').open = false;
  renderWorkout();
  toast('已補登 ' + md(start) + ' 的運動' + (total ? '（' + total + ' 組）' : ''));
};

function startRest() {
  clearInterval(S.restTimer);
  let left = S.settings.restSeconds;
  const el = $('rest');
  el.classList.add('on');
  const tick = () => {
    if (left <= 0) {
      clearInterval(S.restTimer);
      el.textContent = '休息結束，開始下一組';
      try { if (navigator.vibrate) navigator.vibrate([300, 150, 300]); } catch (e) { /* 不支援震動 */ }
      setTimeout(() => { if (el.textContent.indexOf('休息結束') === 0) el.classList.remove('on'); }, 4000);
      return;
    }
    el.textContent = '休息 ' + left + ' 秒（點一下略過）';
    left--;
  };
  tick();
  S.restTimer = setInterval(tick, 1000);
}
function stopRest() { clearInterval(S.restTimer); $('rest').classList.remove('on'); }
ACT.restSkip = stopRest;

/* ============================================================
 * 飲食
 * ============================================================ */
function renderFood() {
  if (!S.ui.foodDate) S.ui.foodDate = today();
  renderQuick();
  chips($('fMeal'), MEALS, m => m === (S.ui.fMeal || guessMeal()), m => { S.ui.fMeal = m; renderFood(); });
  chips($('fPortion'), PORTIONS, x => x === S.ui.fPortion, x => { S.ui.fPortion = x; renderFood(); });
  chips($('fEaten'), EATEN, x => x === S.ui.fEaten, x => { S.ui.fEaten = x; renderFood(); });
  chips($('fTags'), S.settings.mealTags, t => S.ui.fTags.includes(t), t => { toggle(S.ui.fTags, t); renderFood(); });
  renderPreview();
  renderDay();
}

function renderQuick() {
  const foods = recs('food').filter(f => f.button).sort((a, b) => (a._order || 0) - (b._order || 0));
  chips($('quickFoods'), foods.map(f => f.id), () => false, id => quickFood(id), id => {
    const f = S.R.get(id);
    return esc(f.name) + (f.kcal != null ? '<small>' + Math.round(f.kcal) + '</small>' : '');
  });
  const missing = foods.filter(f => f.kcal == null).length;
  $('quickHint').textContent = !foods.length ? '到試算表「常吃食物」勾選「顯示為按鈕」，這裡就會出現一鍵記錄的按鈕。'
    : missing ? '有 ' + missing + ' 個項目還沒有營養數字，可以到試算表「常吃食物」補上。' : '';
}

async function quickFood(id) {
  const f = S.R.get(id);
  if (!f) return;
  const now = nowTs();
  const r = await saveRec({ id: newId('m'), t: 'meal', time: now, meal: f.category === '早餐' ? '早餐' : guessMeal(now), source: 'preset',
    portion: '', eaten: '全部', tags: '', note: '', photoId: '', thumbId: '', name: f.name,
    kcal: f.kcal, protein: f.protein, carbs: f.carbs, fat: f.fat, aiStatus: 'preset', aiNote: '', deleted: false }, { nut: true });
  S.ui.foodDate = dayStr(now);
  renderFood();
  snack('已記錄：' + f.name, { action: { label: '復原', fn: async () => { await softDelete(r.id); renderFood(); } } });
}

function renderPreview() {
  $('fPreview').innerHTML = S.ui.photo
    ? '<img src="' + S.ui.photo.thumb + '" alt="照片預覽"><button class="btn ghost" data-act="clearPhoto">移除照片</button>' : '';
}

/** 把照片縮小並轉成 JPEG（同時清掉照片裡的位置等資訊） */
function compress(file, max, q) {
  return new Promise((res, rej) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.naturalWidth * s));
      c.height = Math.max(1, Math.round(img.naturalHeight * s));
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      res(c.toDataURL('image/jpeg', q));
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('無法讀取照片')); };
    img.src = url;
  });
}
async function onPhotoFile(file) {
  if (!file) return;
  try {
    const full = await compress(file, 1280, 0.72), thumb = await compress(file, 320, 0.6);
    S.ui.photo = { full, thumb };
    renderPreview();
  } catch (e) { toast('無法讀取這張照片', true); }
}

ACT.cam = () => $('cam').click();
ACT.gallery = () => $('gallery').click();
ACT.clearPhoto = () => { S.ui.photo = null; renderPreview(); };
ACT.saveMeal = async btn => {
  const note = $('fNote').value.trim(), ph = S.ui.photo, nm = $('fName').value.trim();
  const k = numIn('fKcal'), p = numIn('fProt'), c = numIn('fCarb'), f = numIn('fFat');
  const manual = k != null || p != null || c != null || f != null;
  if (!ph && !S.ui.fTags.length && !note && !nm && !manual) return toast('請拍照、選標籤或填寫內容', true);
  const tm = fromInput($('fTime').value) || nowTs(), id = newId('m'), ai = S.settings.ai;
  const wantAi = !manual && ai.enabled && ai.auto && !!(ph || note || nm);
  const rec = { id, t: 'meal', time: tm, meal: S.ui.fMeal || guessMeal(tm), source: ph ? 'photo' : (manual ? 'manual' : 'text'),
    portion: S.ui.fPortion, eaten: S.ui.fEaten, tags: S.ui.fTags.join(','), note, photoId: '', thumbId: '', name: nm,
    kcal: k, protein: p, carbs: c, fat: f, aiStatus: manual ? 'edited' : (wantAi ? 'pending' : ''), aiNote: '', deleted: false };
  btn.disabled = true;
  try {
    if (ph) {
      await DB.put('blob', { k: 'up:' + id, full: ph.full, thumb: ph.thumb });
      await DB.put('blob', { k: 'th:' + id, data: ph.thumb });
      S.thumbs.set(id, ph.thumb);
      S.pendingUploads.add(id);
    }
    await saveRec(rec, { nut: true });
  } catch (e) {
    return toast('儲存失敗：' + e.message, true);
  } finally { btn.disabled = false; }
  S.ui.photo = null; S.ui.fTags = []; S.ui.fMeal = null; S.ui.fPortion = '中'; S.ui.fEaten = '全部';
  ['fNote', 'fName', 'fKcal', 'fProt', 'fCarb', 'fFat', 'fTime'].forEach(i => { $(i).value = ''; });
  $('fMore').open = false;
  S.ui.foodDate = dayStr(tm);
  renderFood();
  toast(navigator.onLine ? '已儲存' + (wantAi ? '，AI 分析中' : '') : '已存在手機，有網路時會自動上傳');
};

function dayTotals(d) {
  const t = { kcal: 0, protein: 0, carbs: 0, fat: 0, n: 0, unknown: 0 };
  recs('meal').filter(m => m.time && dayStr(m.time) === d).forEach(m => {
    t.n++;
    if (m.kcal == null) { t.unknown++; return; }
    t.kcal += Number(m.kcal) || 0; t.protein += Number(m.protein) || 0; t.carbs += Number(m.carbs) || 0; t.fat += Number(m.fat) || 0;
  });
  return t;
}

function mealStatus(m) {
  if (S.pendingUploads.has(m.id)) return { cls: 'warn', text: navigator.onLine ? '照片上傳中…' : '照片待上傳（目前離線）' };
  if (S.aiRunning.has(m.id)) return { cls: 'info', text: 'AI 分析中…' };
  switch (m.aiStatus) {
    case 'pending': return { cls: 'info', text: m._dirty ? '同步後會自動分析' : '等待 AI 分析' };
    case 'error': return { cls: 'err', text: 'AI 分析失敗：' + (m.aiNote || '') };
    case 'limit': return { cls: 'warn', text: m.aiNote || '已達今天的 AI 上限' };
    case 'off': return { cls: 'warn', text: 'AI 尚未設定' };
    case 'edited': return { cls: 'ok', text: '已手動修正' };
    default: return (m.kcal == null && m.aiStatus !== 'preset') ? { cls: '', text: '還沒有營養數字' } : null;
  }
}
function canAi(m) {
  return S.settings.ai.enabled && navigator.onLine && m.source !== 'preset' && !S.pendingUploads.has(m.id) &&
    !S.aiRunning.has(m.id) && !!(m.photoId || m.note || m.name || m.tags);
}

function mealCard(m) {
  const th = safeImg(S.thumbs.get(m.id)), st = mealStatus(m);
  const pic = th ? '<img src="' + th + '" alt="" data-act="viewPhoto" data-id="' + esc(m.id) + '">'
    : '<div class="noimg">' + (m.photoId || S.pendingUploads.has(m.id) ? '照片' : esc(m.meal || '')) + '</div>';
  const nut = m.kcal != null ? '<div>' + Math.round(m.kcal) + ' kcal・蛋白質 ' + num(m.protein) + 'g・醣類 ' + num(m.carbs) + 'g・脂肪 ' + num(m.fat) + 'g</div>' : '';
  const extra = [m.portion && m.portion !== '中' ? '份量' + m.portion : '', m.eaten && m.eaten !== '全部' ? '吃了' + m.eaten : '', m.tags, m.note].filter(Boolean).join('・');
  return '<div class="meal">' + pic + '<div class="meal-body">' +
    '<div><b>' + esc(m.meal) + '</b> <span class="sub">' + hm(m.time) + devTag(m) + '</span></div>' +
    (m.name ? '<div>' + esc(m.name) + '</div>' : '') + nut +
    (st ? '<div class="status ' + st.cls + '">' + esc(st.text) + '</div>' : '') +
    (m.aiNote && m.aiStatus === 'done' ? '<div class="hint">' + esc(m.aiNote) + '</div>' : '') +
    (extra ? '<div class="hint">' + esc(extra) + '</div>' : '') +
    '<div class="meal-actions">' +
    (canAi(m) ? '<button class="btn small" data-act="mealAi" data-id="' + esc(m.id) + '">' + (m.aiStatus === 'done' ? '重新分析' : 'AI 分析') + '</button>' : '') +
    '<button class="btn small" data-act="mealEdit" data-id="' + esc(m.id) + '">修正</button>' +
    '<button class="btn small danger" data-act="mealDel" data-id="' + esc(m.id) + '">刪除</button></div></div></div>';
}

function renderDay() {
  const d = S.ui.foodDate, t = dayTotals(d), st = S.settings;
  const dd = new Date(d + 'T12:00');
  $('fDate').textContent = (dd.getMonth() + 1) + '/' + dd.getDate() + '（' + (d === today() ? '今天' : '週' + '日一二三四五六'[dd.getDay()]) + '）';
  const goal = (v, g, unit) => {
    if (!g) return Math.round(v) + ' ' + unit;
    const pct = Math.min(100, Math.round(v / g * 100));
    return Math.round(v) + ' / ' + g + ' ' + unit + '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%"></div></div>';
  };
  $('dayTotals').innerHTML = t.n && t.n === t.unknown ? '<div class="totals sub">' + t.n + ' 餐還沒有營養數字</div>' : t.n ? '<div class="totals"><div>熱量 ' + goal(t.kcal, st.kcalGoal, 'kcal') + '</div><div>蛋白質 ' + goal(t.protein, st.proteinGoal, 'g') +
    '</div><div class="sub">醣類 ' + Math.round(t.carbs) + 'g・脂肪 ' + Math.round(t.fat) + 'g' + (t.unknown ? '・' + t.unknown + ' 餐還沒有數字' : '') + '</div></div>' : '';
  const meals = recs('meal').filter(m => m.time && dayStr(m.time) === d).sort((a, b) => a.time - b.time);
  $('mealList').innerHTML = meals.length ? meals.map(mealCard).join('') : '<div class="sub" style="margin-top:12px">這天沒有紀錄</div>';
  renderAdvice();
  loadThumbs(meals);
}

async function loadThumbs(meals) {
  let changed = false;
  const need = [];
  for (const m of meals) {
    if (S.thumbs.has(m.id)) continue;
    const local = await DB.get('blob', 'th:' + m.id);
    if (local && local.data) { S.thumbs.set(m.id, local.data); changed = true; continue; }
    if (m.photoId && !S.thumbTried.has(m.id)) need.push(m.id);
  }
  if (need.length && navigator.onLine && S.cfg) {
    need.forEach(id => S.thumbTried.add(id));
    for (let i = 0; i < need.length; i += 12) {
      try {
        const res = await api('getThumbs', { ids: need.slice(i, i + 12) });
        for (const id of Object.keys(res.thumbs || {})) {
          const data = safeImg(res.thumbs[id]);
          if (!data) continue;
          S.thumbs.set(id, data);
          await DB.put('blob', { k: 'th:' + id, data });
          changed = true;
        }
      } catch (e) { /* 下次再試 */ }
    }
  }
  if (changed && S.tab === 'food') {
    const list = recs('meal').filter(m => m.time && dayStr(m.time) === S.ui.foodDate).sort((a, b) => a.time - b.time);
    if (list.length) $('mealList').innerHTML = list.map(mealCard).join('');
  }
}

function renderAdvice() {
  const box = $('adviceBox'), d = S.ui.foodDate, a = S.advice.get(d);
  if (!S.settings.ai.enabled) { box.innerHTML = '<div class="hint">設定好 AI 之後，這裡可以產生每日飲食建議。</div>'; return; }
  box.innerHTML = (a ? '<div class="advice">' + esc(a.text).replace(/\n/g, '<br>') + '<div class="hint">' + md(a.at) + ' ' + hm(a.at) + ' 產生・AI 建議僅供參考</div></div>' : '') +
    '<button class="btn small" style="margin-top:12px" data-act="advice"' + (a ? ' data-force="1"' : '') + '>' + (a ? '重新產生建議' : '產生這天的飲食建議（AI）') + '</button>';
}

ACT.dayShift = b => {
  const d = new Date(S.ui.foodDate + 'T12:00');
  d.setDate(d.getDate() + Number(b.dataset.d));
  S.ui.foodDate = dayStr(d.getTime());
  renderDay();
};
ACT.dayToday = () => { S.ui.foodDate = today(); renderDay(); };
ACT.mealAi = async b => {
  const id = b.dataset.id, m = S.R.get(id);
  if (!m) return;
  if (m._dirty) { await sync(); }
  if (S.R.get(id)._dirty) return toast('還沒同步完成，請稍後再試', true);
  analyzeMeal(id, false);
};
ACT.mealDel = async b => {
  if (!confirmTap(b, '再按一次刪除')) return;
  await softDelete(b.dataset.id);
  renderDay();
};
ACT.mealEdit = b => {
  const m = S.R.get(b.dataset.id);
  if (!m) return;
  const v = x => (x == null ? '' : x);
  openModal('<h3>修正這一餐</h3>' +
    '<div class="label">時間</div><input type="datetime-local" id="eTime" value="' + toInput(m.time) + '">' +
    '<div class="label">餐別</div><div class="chips" id="eMeal"></div>' +
    '<div class="label">品項</div><input type="text" id="eName" maxlength="80" value="' + esc(m.name) + '">' +
    '<div class="grid2">' +
    '<label>熱量 (kcal)<input type="number" id="eKcal" inputmode="decimal" value="' + esc(v(m.kcal)) + '"></label>' +
    '<label>蛋白質 (g)<input type="number" id="eProt" inputmode="decimal" value="' + esc(v(m.protein)) + '"></label>' +
    '<label>醣類 (g)<input type="number" id="eCarb" inputmode="decimal" value="' + esc(v(m.carbs)) + '"></label>' +
    '<label>脂肪 (g)<input type="number" id="eFat" inputmode="decimal" value="' + esc(v(m.fat)) + '"></label></div>' +
    '<label class="check"><input type="checkbox" id="eSave"> 存成「常吃食物」，以後可以一鍵記錄</label>' +
    '<div class="row"><button class="btn" data-act="modalClose">取消</button><button class="btn primary" data-act="mealEditSave" data-id="' + esc(m.id) + '">儲存</button></div>');
  S.ui.eMeal = m.meal;
  const draw = () => chips($('eMeal'), MEALS, x => x === S.ui.eMeal, x => { S.ui.eMeal = x; draw(); });
  draw();
};
ACT.mealEditSave = async b => {
  const m = S.R.get(b.dataset.id);
  if (!m) return closeModal();
  const time = fromInput($('eTime').value) || m.time, name = $('eName').value.trim();
  const kcal = numIn('eKcal'), protein = numIn('eProt'), carbs = numIn('eCarb'), fat = numIn('eFat');
  const baseChanged = time !== m.time || S.ui.eMeal !== m.meal;
  const nutChanged = name !== (m.name || '') || kcal !== m.kcal || protein !== m.protein || carbs !== m.carbs || fat !== m.fat;
  if (baseChanged || nutChanged) {
    const next = Object.assign({}, m, { time, meal: S.ui.eMeal });
    if (nutChanged) Object.assign(next, { name, kcal, protein, carbs, fat, aiStatus: m.aiStatus === 'preset' ? 'preset' : 'edited' });
    await saveRec(next, { base: baseChanged, nut: nutChanged });
  }
  if ($('eSave').checked && name) {
    await saveRec({ id: newId('f'), t: 'food', name, category: S.ui.eMeal === '早餐' ? '早餐' : '餐點', kcal, protein, carbs, fat, button: true, note: '', deleted: false, _order: 999 });
  }
  closeModal();
  S.ui.foodDate = dayStr(time);
  renderFood();
  toast('已更新');
};
ACT.viewPhoto = async b => {
  const m = S.R.get(b.dataset.id);
  if (!m) return;
  const th = safeImg(S.thumbs.get(m.id));
  openModal('<div id="photoBox">' + (th ? '<img src="' + th + '" alt="">' : '') + '</div><div class="hint" id="photoMsg">' +
    (m.photoId && navigator.onLine ? '載入原圖中…' : '') + '</div><button class="btn" data-act="modalClose">關閉</button>');
  if (!m.photoId || !navigator.onLine) return;
  try {
    const res = await api('getPhoto', { id: m.id }, 60000);
    const u = safeImg(res.dataUrl);
    if ($('photoBox') && u) { $('photoBox').innerHTML = '<img src="' + u + '" alt="">'; $('photoMsg').textContent = ''; }
  } catch (e) { if ($('photoMsg')) $('photoMsg').textContent = '無法載入原圖：' + e.message; }
};
ACT.modalClose = closeModal;
ACT.advice = async b => {
  if (!navigator.onLine) return toast('需要網路才能產生建議', true);
  const d = S.ui.foodDate;
  if (recs('meal').some(m => m._dirty)) await sync();
  try {
    const res = await busy(b, api('advice', { date: d, force: b.dataset.force === '1' }, 120000));
    S.advice.set(d, { text: res.text, at: res.at });
    const keep = {};
    Array.from(S.advice.keys()).sort().slice(-30).forEach(k => { keep[k] = S.advice.get(k); });
    await setMeta('advice', keep);
    renderAdvice();
  } catch (e) { toast(e.message, true); }
};

/* ============================================================
 * 統計（全部在手機上計算，離線也能看）
 * ============================================================ */
function computeStats() {
  const now = Date.now();
  const avg = a => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length * 10) / 10 : null;
  const { nights } = pairNights(recsAll('sleep'), now);
  const workouts = recs('workout').filter(w => w.start);
  const meals = recs('meal').filter(m => m.time);
  const last7 = nights.filter(n => now - n.wake.time < 7 * DAY);
  const wkDays = new Map();
  workouts.forEach(w => { const d = dayStr(w.start); wkDays.set(d, (wkDays.get(d) || 0) + 1); });
  const countFrom = from => Array.from(wkDays.keys()).filter(d => d >= from && d <= today()).length;
  const sleepDays = [];
  for (let i = 13; i >= 0; i--) {
    const d = dayStr(now - i * DAY);
    sleepDays.push({ d, h: Math.round(nights.filter(n => dayStr(n.wake.time) === d).reduce((a, n) => a + n.hours, 0) * 10) / 10 });
  }
  const first = now - 83 * DAY, heat = [];
  for (let i = 83; i >= 0; i--) { const d = dayStr(now - i * DAY); heat.push({ d, n: wkDays.get(d) || 0 }); }
  const heatOffset = (new Date(first).getDay() + 6) % 7;
  // 睡前狀態與睡眠的關係（近 60 天）
  const recent = nights.filter(n => now - n.wake.time < 60 * DAY);
  const nightOf = n => dayStr(n.bed.time - 6 * H);
  const dinner = new Map();
  meals.forEach(m => {
    if (m.meal !== '晚餐' && m.meal !== '宵夜') return;
    const d = dayStr(m.time);
    if (!dinner.has(d)) dinner.set(d, new Set());
    splitTags(m.tags).forEach(t => dinner.get(d).add(t));
  });
  const factors = [['當天有運動', n => wkDays.has(nightOf(n))]]
    .concat(S.settings.sleepTags.map(t => [t, n => splitTags(n.tags).includes(t)]))
    .concat(S.settings.mealTags.map(t => ['晚餐：' + t, n => (dinner.get(nightOf(n)) || new Set()).has(t)]));
  const factorRows = factors.map(([label, has]) => {
    const w = recent.filter(has), wo = recent.filter(n => !has(n));
    return { label, n: w.length, m: wo.length, wh: avg(w.map(n => n.hours)), woh: avg(wo.map(n => n.hours)),
      wq: avg(w.map(n => n.quality).filter(Boolean)), woq: avg(wo.map(n => n.quality).filter(Boolean)) };
  }).filter(r => r.n >= 2 && r.m >= 2);
  // 個人紀錄（Epley 公式估算 1RM）
  const pr = {};
  recs('set').forEach(s => {
    if (!s.exercise) return;
    const w = Number(s.weight) || 0, reps = Number(s.reps) || 0, e1 = reps > 1 ? w * (1 + reps / 30) : w;
    const p = pr[s.exercise] || (pr[s.exercise] = { ex: s.exercise, maxW: 0, e1: 0, d: '' });
    if (w > p.maxW) { p.maxW = w; p.d = dayStr(s.time); }
    if (e1 > p.e1) p.e1 = Math.round(e1 * 10) / 10;
  });
  // 近 7 天飲食
  const nut = [];
  for (let i = 6; i >= 0; i--) { const d = dayStr(now - i * DAY); nut.push(Object.assign({ d }, dayTotals(d))); }
  const nutDays = nut.filter(x => x.n && x.n > x.unknown);
  return {
    avgH: avg(last7.map(n => n.hours)), avgQ: avg(last7.map(n => n.quality).filter(Boolean)),
    wk7: countFrom(dayStr(now - 6 * DAY)), wkMonth: countFrom(today().slice(0, 8) + '01'),
    kcal7: avg(nutDays.map(x => x.kcal)), prot7: avg(nutDays.map(x => x.protein)),
    sleepDays, heat, heatOffset, factorRows, prs: Object.values(pr).sort((a, b) => b.maxW - a.maxW), nut
  };
}

function renderStats() {
  const s = computeStats(), v = x => (x == null ? '—' : x);
  const maxH = Math.max(10, ...s.sleepDays.map(d => d.h));
  let h = '<div class="card"><div class="metrics">' +
    '<div class="metric"><span class="sub">近 7 天平均睡眠</span><b>' + v(s.avgH) + ' 小時</b></div>' +
    '<div class="metric"><span class="sub">近 7 天睡眠品質</span><b>' + v(s.avgQ) + ' / 5</b></div>' +
    '<div class="metric"><span class="sub">近 7 天運動</span><b>' + s.wk7 + ' 天</b></div>' +
    '<div class="metric"><span class="sub">本月運動</span><b>' + s.wkMonth + ' 天</b></div>' +
    '<div class="metric"><span class="sub">近 7 天平均熱量</span><b>' + v(s.kcal7 == null ? null : Math.round(s.kcal7)) + ' kcal</b></div>' +
    '<div class="metric"><span class="sub">近 7 天平均蛋白質</span><b>' + v(s.prot7 == null ? null : Math.round(s.prot7)) + ' g</b></div>' +
    '</div><div class="hint">熱量和蛋白質只計算有營養數字的日子；AI 估計的數字可能有誤差，請看趨勢。</div></div>';
  h += '<div class="card"><div class="label top">近 14 天睡眠時數</div><div class="bars">' +
    s.sleepDays.map(d => '<div title="' + d.d + '：' + d.h + ' 小時" style="height:' + (d.h / maxH * 100) + '%"></div>').join('') +
    '</div><div class="row between sub" style="margin-top:4px"><span>' + s.sleepDays[0].d.slice(5) + '</span><span>' + s.sleepDays[13].d.slice(5) + '</span></div></div>';
  h += '<div class="card"><div class="label top">近 12 週運動日</div><div class="heat">' + '<i class="x"></i>'.repeat(s.heatOffset) +
    s.heat.map(d => '<i class="' + (d.n > 1 ? 'l2' : d.n ? 'l1' : '') + '" title="' + d.d + '"></i>').join('') +
    '</div><div class="hint">每一欄是一週，由上到下是週一到週日</div></div>';
  h += '<div class="card"><div class="label top">近 7 天飲食</div><table><tr><th>日期</th><th>熱量</th><th>蛋白質</th><th>餐數</th></tr>' +
    s.nut.map(x => '<tr><td>' + x.d.slice(5) + '</td><td>' + (x.n > x.unknown ? Math.round(x.kcal) : '—') + '</td><td>' + (x.n > x.unknown ? Math.round(x.protein) + 'g' : '—') +
      '</td><td>' + x.n + (x.unknown ? '（' + x.unknown + ' 無數字）' : '') + '</td></tr>').join('') + '</table></div>';
  h += '<div class="card"><div class="label top">哪些狀態影響睡眠（近 60 天）</div>' + (s.factorRows.length
    ? '<table><tr><th>狀態</th><th>有</th><th>沒有</th></tr>' + s.factorRows.map(r => '<tr><td>' + esc(r.label) + '<div class="hint">' + r.n + ' 晚</div></td><td>' +
      v(r.wh) + ' 小時<div class="hint">品質 ' + v(r.wq) + '</div></td><td>' + v(r.woh) + ' 小時<div class="hint">品質 ' + v(r.woq) + '</div></td></tr>').join('') + '</table>'
    : '<div class="sub">資料還不夠。「有」和「沒有」各至少 2 晚之後就會出現。</div>') + '</div>';
  if (s.prs.length) {
    h += '<div class="card"><div class="label top">個人紀錄</div><table><tr><th>動作</th><th>最大重量</th><th>估算 1RM</th></tr>' +
      s.prs.map(p => '<tr><td>' + esc(p.ex) + '</td><td>' + num(p.maxW) + ' kg<div class="hint">' + p.d + '</div></td><td>' + num(p.e1) + ' kg</td></tr>').join('') + '</table></div>';
  }
  $('t-stats').innerHTML = h;
}

/* ============================================================
 * 更多
 * ============================================================ */
function renderMore() {
  const n = dirtyCount(), up = S.pendingUploads.size, ai = S.settings.ai;
  const { nights } = pairNights(recsAll('sleep'));
  const ws = recs('workout').sort((a, b) => b.start - a.start).slice(0, 20);
  let h = '<div class="card"><div class="label top">同步</div>' +
    '<div>' + (n || up ? '待同步：' + n + ' 筆資料' + (up ? '、' + up + ' 張照片' : '') : '所有資料都已同步') + '</div>' +
    '<div class="hint">' + (S.lastOk ? '上次同步：' + md(S.lastOk) + ' ' + hm(S.lastOk) : '這次開啟後還沒同步') + (navigator.onLine ? '' : '・目前離線') + '</div>' +
    '<button class="btn" data-act="syncNow">立即同步</button></div>';
  h += '<div class="card"><div class="label top">這台裝置</div><div>' + esc(S.cfg.deviceName) + '</div><div class="hint">裝置代號 ' + esc(S.cfg.deviceId) + '</div>' +
    '<div class="label">已配對的裝置</div><div class="sub">' + (Object.values(S.devices).map(esc).join('、') || '—') + '</div>' +
    '<div class="hint">要停用某台裝置，請到試算表「裝置」工作表勾選「停用」。</div></div>';
  h += '<div class="card"><div class="label top">AI</div><div>' + (ai.enabled ? esc(ai.provider) + '・' + esc(ai.model) + (ai.auto ? '・自動分析照片' : '・手動分析') : 'AI 尚未設定（請看安裝說明）') + '</div>' +
    (ai.enabled ? '<button class="btn" data-act="aiTest">測試 AI 連線</button>' : '') + '</div>';
  h += '<div class="card"><div class="label top">最近的睡眠</div>' + (nights.length ? nights.slice(-14).reverse().map(x =>
    '<div class="li"><span>' + md(x.bed.time) + ' ' + hm(x.bed.time) + ' → ' + hm(x.wake.time) + '・' + x.hours + ' 小時' + (x.quality ? '・' + Q_LABELS[x.quality - 1] : '') + '</span>' +
    '<button class="btn small danger" data-act="nightDel" data-b="' + esc(x.bed.id) + '" data-w="' + esc(x.wake.id) + '">刪除</button></div>').join('') : '<div class="sub">沒有紀錄</div>') + '</div>';
  h += '<div class="card"><div class="label top">最近的運動</div>' + (ws.length ? ws.map(w =>
    '<div class="li"><span>' + md(w.start) + ' ' + hm(w.start) + ' ' + esc(w.type) + (w.menu ? '・' + esc(w.menu) : '') + (w.minutes ? '・' + w.minutes + ' 分鐘' : '') + devTag(w) + '</span>' +
    '<button class="btn small danger" data-act="workoutDel" data-id="' + esc(w.id) + '">刪除</button></div>').join('') : '<div class="sub">沒有紀錄</div>') + '</div>';
  h += '<div class="card"><div class="label top">關於</div><div class="sub">版本 ' + APP_VERSION + '。按鈕的選項、菜單、目標和 AI 設定，都在試算表的「設定」工作表修改，下次同步後生效。</div>' +
    '<button class="btn danger" data-act="unpair">解除這台裝置的配對</button></div>';
  $('t-more').innerHTML = h;
}

ACT.syncNow = () => { S.syncErr = ''; sync(); };
ACT.aiTest = async b => {
  try { const r = await busy(b, api('aiTest', {}, 60000)); toast('AI 回應：' + r.text); }
  catch (e) { toast(e.message, true); }
};
ACT.nightDel = async b => {
  if (!confirmTap(b, '再按一次')) return;
  await softDelete(b.dataset.b);
  await softDelete(b.dataset.w);
  renderMore();
};
ACT.workoutDel = async b => {
  if (!confirmTap(b, '再按一次')) return;
  const id = b.dataset.id;
  for (const s of recs('set').filter(x => x.workoutId === id)) await softDelete(s.id);
  await softDelete(id);
  if (S.session && S.session.id === id) { S.session = null; await setMeta('session', null); }
  renderMore();
};
ACT.unpair = async b => {
  const n = dirtyCount() + S.pendingUploads.size;
  if (!confirmTap(b, n ? '還有 ' + n + ' 筆沒同步，會遺失！再按一次確認' : '再按一次確認解除')) return;
  await DB.clear('rec'); await DB.clear('blob'); await DB.clear('meta');
  location.reload();
};
ACT.repair = async () => { await setMeta('cfg', null); location.reload(); };
ACT.swUpdate = () => { if (S.swReg && S.swReg.waiting) S.swReg.waiting.postMessage('skipWaiting'); else location.reload(); };

/* ============================================================
 * 配對
 * ============================================================ */
function parsePairLink(s) {
  const m = String(s || '').match(/pair=([A-Za-z0-9_-]+)/);
  if (!m) return null;
  let b = m[1].replace(/-/g, '+').replace(/_/g, '/');
  while (b.length % 4) b += '=';
  try {
    const o = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b), c => c.charCodeAt(0))));
    return o && o.u && o.c ? o : null;
  } catch (e) { return null; }
}
function defaultName() {
  const ua = navigator.userAgent;
  return /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android 手機' : '電腦';
}
function showPairing(msg) {
  $('app').hidden = true;
  $('pairing').hidden = false;
  if (/pair=/.test(location.hash)) $('pairLink').value = location.href;
  if (!$('pairName').value) $('pairName').value = defaultName();
  $('pairMsg').textContent = msg || '';
}
ACT.pairGo = async b => {
  const msg = t => { $('pairMsg').textContent = t; };
  const p = parsePairLink($('pairLink').value.trim());
  const api = p ? p.u : $('pairApi').value.trim(), code = p ? p.c : $('pairCode').value.trim();
  const name = $('pairName').value.trim() || defaultName();
  if (!/^https?:\/\/\S+$/.test(api) || !code) return msg('請貼上配對連結，或填寫 API 網址和配對碼');
  b.disabled = true;
  msg('配對中…');
  try {
    const res = await fetch(api, { method: 'POST', body: JSON.stringify({ action: 'pair', code, name }) });
    let data;
    try { data = await res.json(); } catch (e) { throw new Error('伺服器回應格式錯誤：請確認 API 網址正確，而且部署時「誰可以存取」選「所有人」'); }
    if (!data.ok) throw new Error(data.error || '配對失敗');
    S.cfg = { api, key: data.key, deviceId: data.deviceId, deviceName: data.name };
    S.lastSync = 0;
    await setMeta('cfg', S.cfg);
    await setMeta('lastSync', 0);
    history.replaceState(null, '', location.pathname + location.search);
    startApp();
    sync();
  } catch (e) {
    msg(e.message === 'Failed to fetch' || e instanceof TypeError ? '無法連線：請確認網路、API 網址，以及部署時「誰可以存取」選「所有人」' : e.message);
  } finally { b.disabled = false; }
};

/* ============================================================
 * 事件與啟動
 * ============================================================ */
document.addEventListener('click', e => {
  const tabBtn = e.target.closest('#nav button');
  if (tabBtn) { show(tabBtn.dataset.tab); return; }
  const b = e.target.closest('[data-act]');
  if (b && ACT[b.dataset.act]) { e.preventDefault(); ACT[b.dataset.act](b, e); return; }
  if (e.target.id === 'modal') closeModal();
});
['cam', 'gallery'].forEach(id => {
  $(id).addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; onPhotoFile(f); });
});
$('bwBox').addEventListener('toggle', () => { if ($('bwBox').open && !$('bwTime').value) $('bwTime').value = toInput(Date.now() - H); });
$('sleepBf').addEventListener('toggle', () => {
  if (!$('sleepBf').open) return;
  if (!$('bfBed').value) { const d = new Date(); d.setDate(d.getDate() - 1); d.setHours(23, 0, 0, 0); $('bfBed').value = toInput(d.getTime()); }
  if (!$('bfWake').value) { const d = new Date(); d.setHours(7, 0, 0, 0); $('bfWake').value = toInput(d.getTime()); }
});
window.addEventListener('online', () => { renderStatus(); sync(); });
window.addEventListener('offline', () => { renderStatus(); renderBanner(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.cfg) { renderActive(); sync(); }
});
setInterval(() => { if (document.visibilityState === 'visible' && S.cfg) sync(); }, 5 * 60000);
setInterval(() => { if (S.tab === 'workout' && S.session && !$('app').hidden) renderStrength(); }, 60000);

function startApp() {
  $('pairing').hidden = true;
  $('app').hidden = false;
  show(S.tab);
  renderStatus();
  renderBanner();
}

async function boot() {
  try { await DB.open(); } catch (e) {
    document.body.innerHTML = '<p style="padding:24px">這個瀏覽器無法使用本機儲存空間（可能是無痕模式），請改用一般模式開啟。</p>';
    return;
  }
  S.cfg = (await getMeta('cfg')) || null;
  S.settings = normSettings(await getMeta('settings'));
  S.devices = (await getMeta('devices')) || {};
  S.lastSync = (await getMeta('lastSync')) || 0;
  S.session = (await getMeta('session')) || null;
  S.advice = new Map(Object.entries((await getMeta('advice')) || {}));
  (await DB.all('rec')).forEach(r => S.R.set(r.id, r));
  (await DB.keys('blob', 'up:')).forEach(k => S.pendingUploads.add(k.slice(3)));
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* 不支援 */ }
  if (!S.cfg) return showPairing();
  startApp();
  sync();
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then(reg => {
    S.swReg = reg;
    const ready = () => { S.updateReady = true; renderBanner(); };
    if (reg.waiting && navigator.serviceWorker.controller) ready();
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      if (nw) nw.addEventListener('statechange', () => { if (nw.state === 'installed' && navigator.serviceWorker.controller) ready(); });
    });
  }).catch(() => { /* 不支援離線時仍可線上使用 */ });
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (S.updateReady && !reloading) { reloading = true; location.reload(); } });
}

boot();
