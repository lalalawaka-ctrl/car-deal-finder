'use strict';
/* 중고차 꿀매물 분석기 — 브라우저 전용. Python 버전(api_map/collector/analyzer/scorer)과 같은 로직. */

// ---------- 설정 ----------
const API = 'https://api.encar.com';
const URLS = {
  search: `${API}/search/car/list/general`,
  detail: id => `${API}/v1/readside/vehicle/${id}`,
  inspection: id => `${API}/v1/readside/inspection/vehicle/${id}`,
  record: id => `${API}/v1/readside/record/vehicle/${id}/open`,
  diagnosis: id => `${API}/v1/readside/diagnosis/vehicle/${id}`,
  page: id => `https://fem.encar.com/cars/detail/${id}`,
};
const PAGE_SIZE = 200;
const NAV_PARAM = '|Metadata|Sort';
const NON_PRICE_SELL = new Set(['리스', '렌트']);
const PRICE_PLACEHOLDER = 9999;
const TTL_H = { list: 6, nav: 168, detail: 12, inspection: 168, record: 168, diagnosis: 168 };
const DELAY = [1000, 2000];
const RETRIES = 3;

const CFG = {
  weights: { price: 35, history: 30, condition: 25, mileage: 10 },
  price: { min_reg: 15, min_grp: 3, full: 0.15, zero: 0.10, bait: 0.20 },
  history: { small: 1e6, big: 3e6, per_small: 0.07, per_mid: 0.15, per_big: 0.30, per_other: 0.02,
    per_owner: 0.06, per_plate: 0.04, government: 0.10, rent: 0.30, business: 0.30, no_record: 0.25 },
  condition: { r1_ex: 0.12, r1_sh: 0.06, r2_ex: 0.20, r2_sh: 0.10, leak: 0.10, issue: 0.05, tuning: 0.05,
    no_insp: 0.35, diag: 0.10, diag_plus: 0.15, ev: 0.05 },
  mileage: { std: 15000, low: 3000 },
  signals: { long_days: 60, few_photos: 10, short_desc: 80 },
  grades: [
    { grade: 'S', min: 90, label: '즉시 연락 추천', color: '#8B5CF6' },
    { grade: 'A', min: 80, label: '강력 추천', color: '#22C55E' },
    { grade: 'B', min: 70, label: '추천', color: '#3B82F6' },
    { grade: 'C', min: 60, label: '조건부 고려', color: '#EAB308' },
    { grade: 'D', min: 50, label: '비추천', color: '#F97316' },
    { grade: 'F', min: 0, label: '제외', color: '#EF4444' },
  ],
  bait_max: 'C',
};

const GOOD_STATUS = new Set(['양호', '없음', '적정', '정상']);
const LEAK_WORDS = ['누유', '누수', '누출'];
const OUTER_STATUS = { X: 'exchange', W: 'sheet', WC: 'weld_cut' };
const RANKS = { RANK_ONE: '1', RANK_TWO: '2', RANK_A: 'A', RANK_B: 'B', RANK_C: 'C' };
const FRAME_RANKS = new Set(['A', 'B', 'C']);
const DIAG_MARKS = new Set(['EncarDiagnosisP0', 'EncarDiagnosisP1', 'EncarDiagnosisP2']);
const DIAG_PLUS_MARKS = new Set(['EncarDiagnosisP2']);
const DIAG_SKIP = new Set(['CHECKER_COMMENT', 'OUTER_PANEL_COMMENT']);
const STATUS_KO = { sheet: '판금', exchange: '교환', frame: '골격손상' };

// ---------- 부위 매핑 (part_map.py) ----------
const PARTS = {
  bumper_f: '앞 범퍼', radiator: '라디에이터 서포트', hood: '후드',
  fender_fl: '좌측 프론트펜더', fender_fr: '우측 프론트펜더',
  door_fl: '좌측 앞도어', door_fr: '우측 앞도어', door_rl: '좌측 뒷도어', door_rr: '우측 뒷도어',
  roof: '루프', trunk: '트렁크', quarter_l: '좌측 쿼터패널', quarter_r: '우측 쿼터패널',
  sill_l: '좌측 사이드실', sill_r: '우측 사이드실', bumper_r: '뒤 범퍼',
  frame_front: '앞 골격(프론트패널·멤버·휠하우스)', frame_rear: '뒤 골격(리어패널·트렁크플로어)',
  frame_center: '실내 골격(대쉬·플로어)', pillar_l: '좌측 필러', pillar_r: '우측 필러',
};
const CODE_MAP = {
  P011: 'hood', P021: 'fender_fl', P022: 'fender_fr', P031: 'door_fl', P032: 'door_fr', P033: 'door_rl', P034: 'door_rr',
  P041: 'trunk', P051: 'radiator', P061: 'quarter_l', P062: 'quarter_r', P071: 'roof', P081: 'sill_l', P082: 'sill_r',
  P091: 'frame_front', P101: 'frame_front', P111: 'frame_front', P112: 'frame_front', P121: 'frame_front', P122: 'frame_front',
  P123: 'frame_rear', P124: 'frame_rear', P131: 'frame_front', P132: 'frame_front', P133: 'frame_rear', P134: 'frame_rear',
  P141: 'pillar_l', P142: 'pillar_l', P143: 'pillar_l', P144: 'pillar_r', P145: 'pillar_r', P146: 'pillar_r',
  P151: 'frame_center', P161: 'frame_center', P171: 'frame_rear', P181: 'frame_rear', P191: 'frame_rear',
};
const TITLE_RULES = [
  ['라디에이터', null, 'radiator'], ['후드', null, 'hood'], ['루프', null, 'roof'],
  ['트렁크 리드', null, 'trunk'], ['트렁크리드', null, 'trunk'],
  ['휀더', '좌', 'fender_fl'], ['휀더', '우', 'fender_fr'], ['펜더', '좌', 'fender_fl'], ['펜더', '우', 'fender_fr'],
  ['프론트 도어', '좌', 'door_fl'], ['프론트 도어', '우', 'door_fr'], ['리어 도어', '좌', 'door_rl'], ['리어 도어', '우', 'door_rr'],
  ['쿼터', '좌', 'quarter_l'], ['쿼터', '우', 'quarter_r'], ['사이드실', '좌', 'sill_l'], ['사이드실', '우', 'sill_r'],
  ['필러', '좌', 'pillar_l'], ['필러', '우', 'pillar_r'],
  ['리어', null, 'frame_rear'], ['트렁크 플로어', null, 'frame_rear'], ['패키지', null, 'frame_rear'],
  ['대쉬', null, 'frame_center'], ['플로어', null, 'frame_center'],
  ['프론트', null, 'frame_front'], ['인사이드', null, 'frame_front'], ['크로스', null, 'frame_front'],
  ['휠하우스', null, 'frame_front'], ['멤버', null, 'frame_front'],
];
const DIAG_MAP = {
  HOOD: 'hood', FRONT_FENDER_LEFT: 'fender_fl', FRONT_FENDER_RIGHT: 'fender_fr', FRONT_DOOR_LEFT: 'door_fl',
  FRONT_DOOR_RIGHT: 'door_fr', BACK_DOOR_LEFT: 'door_rl', BACK_DOOR_RIGHT: 'door_rr', TRUNK_LID: 'trunk',
  ROOF: 'roof', QUARTER_PANEL_LEFT: 'quarter_l', QUARTER_PANEL_RIGHT: 'quarter_r',
};
function toPartId(code, title) {
  if (CODE_MAP[code]) return CODE_MAP[code];
  const t = title || '';
  for (const [kw, side, pid] of TITLE_RULES)
    if (t.includes(kw) && (!side || t.includes(`(${side})`) || t.endsWith(side))) return pid;
  return 'frame_center';
}

// ---------- 유틸 ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = s => String(s ?? '').replace(/[\s\-_()]/g, '').toLowerCase();
const escq = v => String(v).replace(/\)/g, '_)');
const g = (o, path, d = null) => {
  for (const k of path.split('.')) { if (o == null || typeof o !== 'object') return d; o = o[k]; }
  return o ?? d;
};
const H = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const num = n => Number(n || 0).toLocaleString('ko-KR');
const clamp = x => Math.max(0, Math.min(1, x));
const median = a => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// ---------- 저장소 (IndexedDB, 실패 시 메모리) ----------
const Store = {
  db: null, mem: new Map(),
  async open() {
    try {
      this.db = await new Promise((res, rej) => {
        const r = indexedDB.open('car-deal-finder', 1);
        r.onupgradeneeded = () => { r.result.createObjectStore('cache'); r.result.createObjectStore('prices'); };
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
    } catch { this.db = null; }
  },
  async get(store, key) {
    if (!this.db) return this.mem.get(store + key);
    try {
      return await new Promise((res, rej) => {
        const r = this.db.transaction(store).objectStore(store).get(key);
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
    } catch { return this.mem.get(store + key); }
  },
  async set(store, key, val) {
    this.mem.set(store + key, val);
    if (!this.db) return;
    try {
      await new Promise((res, rej) => {
        const tx = this.db.transaction(store, 'readwrite');
        tx.objectStore(store).put(val, key); tx.oncomplete = res; tx.onerror = () => rej(tx.error);
      });
    } catch { /* 용량 초과 등 — 메모리 캐시만 사용 */ }
  },
  async clear() {
    this.mem.clear();
    if (!this.db) return;
    for (const s of ['cache']) await new Promise(res => { const tx = this.db.transaction(s, 'readwrite'); tx.objectStore(s).clear(); tx.oncomplete = res; tx.onerror = res; });
  },
};

// ---------- HTTP (딜레이·재시도·캐시) ----------
const net = { last: 0, cancelled: false, stats: { network: 0, cache: 0, errors: 0 } };
class FetchError extends Error {}
class Cancelled extends Error {}

async function fetchJSON(kind, url, params) {
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  const key = url + qs;
  const hit = await Store.get('cache', key);
  if (hit && Date.now() - hit.t < TTL_H[kind] * 3600e3) { net.stats.cache++; return hit; }
  let err;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (net.cancelled) throw new Cancelled();
    const wait = DELAY[0] + Math.random() * (DELAY[1] - DELAY[0]) - (Date.now() - net.last);
    if (wait > 0) await sleep(wait);
    try {
      net.last = Date.now(); net.stats.network++;
      const r = await fetch(key, { headers: { Accept: 'application/json' } });
      if (r.status === 404 || r.status === 410) {
        const v = { t: Date.now(), status: r.status, data: null };
        await Store.set('cache', key, v); return v;
      }
      if (r.ok) {
        const v = { t: Date.now(), status: 200, data: await r.json() };
        await Store.set('cache', key, v); return v;
      }
      err = `HTTP ${r.status}`;
    } catch (e) { err = e.message || String(e); }
    if (attempt < RETRIES) await sleep(2000 * 2 ** attempt);
  }
  net.stats.errors++;
  throw new FetchError(`${url} 실패: ${err}`);
}

// ---------- 검색 쿼리 ----------
function buildQuery(ct, maker, group, model, year) {
  let node = group ? `ModelGroup.${escq(group)}.` : null;
  if (group && model) node = `(C.ModelGroup.${escq(group)}._.Model.${escq(model)}.)`;
  const mk = node ? `(C.Manufacturer.${escq(maker)}._.${node})` : `Manufacturer.${escq(maker)}.`;
  let q = `(And.Hidden.N._.ServiceCopyCar.ORIGINAL._.(C.CarType.${ct}._.${mk})`;
  if (year) q += `_.Year.range(${year[0]}00..${year[1]}99).`;
  return q + ')';
}
function navFacets(nav, name) {
  const walk = nodes => {
    for (const n of nodes || []) {
      if (n.Name === name) return n.Facets || [];
      for (const f of n.Facets || []) if (f.IsSelected && f.Refinements) { const r = walk(f.Refinements.Nodes); if (r) return r; }
    }
    return null;
  };
  return walk(g(nav, 'iNav.Nodes', [])) || [];
}
const nav = async q => (await fetchJSON('nav', URLS.search, { count: 'true', q, inav: NAV_PARAM })).data || {};

async function loadMakers() {
  const out = [];
  for (const ct of ['Y', 'N'])
    for (const f of navFacets(await nav(`(And.Hidden.N._.CarType.${ct}.)`), 'Manufacturer'))
      if (f.Count) out.push({ ct, name: f.Value, count: f.Count });
  return out;
}
async function loadGroups(ct, maker) {
  return navFacets(await nav(buildQuery(ct, maker)), 'ModelGroup').filter(f => f.Count).map(f => ({ name: f.Value, count: f.Count }));
}
async function loadModels(ct, maker, group) {
  return navFacets(await nav(buildQuery(ct, maker, group)), 'Model').filter(f => f.Count).map(f => ({ name: f.Value, count: f.Count }));
}

// ---------- 파서 (api_map.py) ----------
function parseListItem(r) {
  const ym = parseInt(r.Year || 0, 10);
  return {
    id: String(r.Id), maker: r.Manufacturer, model: r.Model || '', badge: r.Badge || '', badge_detail: r.BadgeDetail || '',
    year_month: ym, year: ym ? Math.floor(ym / 100) : parseInt(r.FormYear || 0, 10),
    mileage: parseInt(r.Mileage || 0, 10), price: parseInt(r.Price || 0, 10), fuel: r.FuelType || '',
    region: r.OfficeCityState || '', sell_type: r.SellType || '', conditions: r.Condition || [],
    service_marks: r.ServiceMark || [], photo_count: (r.Photos || []).length,
  };
}
const dt = s => { const d = s ? new Date(s.slice(0, 19)) : null; return d && !isNaN(d) ? d : null; };
function parseDetail(d) {
  return {
    price: g(d, 'advertisement.price'), mileage: g(d, 'spec.mileage'), color: g(d, 'spec.colorName'),
    photo_count: (d.photos || []).length, desc_len: (g(d, 'contents.text', '') || '').trim().length,
    first_ad: dt(g(d, 'manage.firstAdvertisedDateTime') || g(d, 'manage.registDateTime')),
    diag_view: g(d, 'view.encarDiagnosis', -1) > 0, ev_battery_pass: !!g(d, 'view.isBatteryPass'),
    record_viewable: g(d, 'condition.accident.recordView'),
    seizing: g(d, 'condition.seizing.seizingCount', 0) + g(d, 'condition.seizing.pledgeCount', 0),
  };
}
function walkItems(nodes, out) {
  for (const n of nodes || []) {
    const st = g(n, 'statusType.title');
    if (st && !GOOD_STATUS.has(st)) out.push([g(n, 'type.title', ''), st]);
    walkItems(n.children, out);
  }
}
function parseInspection(d) {
  const det = g(d, 'master.detail', {}) || {};
  const outers = (d.outers || []).map(o => {
    const codes = (o.statusTypes || []).map(s => s.code);
    const status = ['WC', 'X', 'W'].map(c => codes.includes(c) ? OUTER_STATUS[c] : null).find(Boolean) || 'sheet';
    const rank = (o.attributes || []).map(a => RANKS[a]).find(Boolean) || null;
    return { code: g(o, 'type.code', ''), title: g(o, 'type.title', ''), status, rank };
  });
  const issues = [];
  walkItems(d.inners, issues);
  for (const grp of d.etcs || []) for (const c of grp.children || []) if (c.exists) issues.push([g(c, 'type.title', ''), g(grp, 'type.title', '') || '있음']);
  const isLeak = ([t, s]) => LEAK_WORDS.some(w => t.includes(w) || s.includes(w));
  return {
    accident: !!(g(d, 'master.accdient') || g(d, 'master.accident')), waterlog: !!det.waterlog, tuning: !!det.tuning,
    usage_change: (det.usageChangeTypes || []).map(x => x.title), outers,
    leaks: issues.filter(isLeak).map(([t, s]) => `${t}: ${s}`), issues: issues.filter(x => !isLeak(x)).map(([t, s]) => `${t}: ${s}`),
  };
}
function parseRecord(d) {
  const mine = (d.accidents || []).filter(a => String(a.type) === '2');
  const i = k => parseInt(d[k] || 0, 10);
  return {
    open: d.openData !== false, my_cnt: i('myAccidentCnt'), my_cost: i('myAccidentCost'),
    my_costs: mine.map(a => ((a.partCost || 0) + (a.laborCost || 0) + (a.paintingCost || 0)) || a.insuranceBenefit || 0),
    other_cnt: i('otherAccidentCnt'), other_cost: i('otherAccidentCost'), owner_changes: i('ownerChangeCnt'),
    plate_changes: i('carNoChangeCnt'), total_loss: i('totalLossCnt'), flood: i('floodTotalLossCnt') + i('floodPartLossCnt'),
    theft: i('robberCnt'), government: i('government'), business: i('business'), rent: i('loan'),
  };
}
function parseDiagnosis(d) {
  return { abnormal: (d.items || []).filter(x => !DIAG_SKIP.has(x.name) && x.resultCode && x.resultCode !== 'NORMAL').map(x => ({ name: x.name, result: x.result })) };
}

// ---------- 수집 ----------
async function search(t, year, maxItems = 4000) {
  const q = buildQuery(t.ct, t.maker, t.group, t.models.length === 1 ? t.models[0] : null, year);
  let items = [], offset = 0, total = null;
  while (offset < maxItems && (total === null || offset < total)) {
    const d = (await fetchJSON('list', URLS.search, { count: 'true', q, sr: `|ModifiedDate|${offset}|${PAGE_SIZE}` })).data || {};
    total = parseInt(d.Count || 0, 10);
    const page = d.SearchResults || [];
    items = items.concat(page.map(parseListItem));
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  const allowed = new Set(t.models), seen = new Set(), tokens = t.tokens, excl = t.exclude;
  return items.filter(it => {
    const text = norm(it.model + it.badge + it.badge_detail);
    if (seen.has(it.id) || (allowed.size && !allowed.has(it.model))) return false;
    if (!tokens.every(k => text.includes(k)) || excl.some(k => text.includes(k))) return false;
    seen.add(it.id); return true;
  });
}

async function recordPrices(items) {
  const now = Date.now();
  for (const it of items) {
    const h = (await Store.get('prices', it.id)) || [];
    if (!h.length || h[h.length - 1][1] !== it.price) { h.push([now, it.price]); await Store.set('prices', it.id, h); }
    it.price_history = h;
  }
}

async function getDoc(kind, id, parser) {
  try {
    const r = await fetchJSON(kind, URLS[kind](id));
    return r.status === 200 && r.data ? ['ok', parser(r.data)] : ['none', null];
  } catch (e) { if (e instanceof Cancelled) throw e; return ['error', null]; }
}

async function collectVehicle(item) {
  const car = { ...item, docs: {} };
  [car.docs.detail, car.detail] = await getDoc('detail', item.id, parseDetail);
  const det = car.detail || {};
  if (item.conditions.includes('Inspection') || car.docs.detail !== 'ok')
    [car.docs.inspection, car.inspection] = await getDoc('inspection', item.id, parseInspection);
  else [car.docs.inspection, car.inspection] = ['none', null];
  if (item.conditions.includes('Record') || det.record_viewable) {
    const [s, rec] = await getDoc('record', item.id, parseRecord);
    car.docs.record = s === 'none' || (rec && !rec.open) ? 'private' : s;
    car.record = s === 'ok' && rec.open ? rec : null;
  } else [car.docs.record, car.record] = ['private', null];
  if (item.service_marks.some(m => DIAG_MARKS.has(m)) || det.diag_view)
    [car.docs.diagnosis, car.diagnosis] = await getDoc('diagnosis', item.id, parseDiagnosis);
  else [car.docs.diagnosis, car.diagnosis] = ['none', null];
  car.diag_plus = item.service_marks.some(m => DIAG_PLUS_MARKS.has(m));
  car.url = URLS.page(item.id);
  return car;
}

// ---------- 시세 (analyzer.py MarketModel) ----------
const NOW = new Date();
function ageYears(ym) {
  if (!ym) return 1;
  const y = Math.floor(ym / 100), m = ym % 100 || 1;
  return Math.max(NOW.getFullYear() - y + (NOW.getMonth() + 1 - m) / 12, 0.5);
}
function lstsq3(X, y) {
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
  X.forEach((r, i) => { for (let j = 0; j < 3; j++) { b[j] += r[j] * y[i]; for (let k = 0; k < 3; k++) A[j][k] += r[j] * r[k]; } });
  for (let c = 0; c < 3; c++) {                       // 가우스 소거 (부분 피벗)
    let p = c; for (let r = c + 1; r < 3; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    if (Math.abs(A[c][c]) < 1e-12) return null;
    for (let r = 0; r < 3; r++) if (r !== c) { const f = A[r][c] / A[c][c]; for (let k = c; k < 3; k++) A[r][k] -= f * A[c][k]; b[r] -= f * b[c]; }
  }
  return b.map((v, i) => v / A[i][i]);
}
class MarketModel {
  constructor(comps) {
    this.df = comps.filter(c => c.price > 0 && c.price !== PRICE_PLACEHOLDER && !NON_PRICE_SELL.has(c.sell_type))
      .map(c => ({ ...c, age: ageYears(c.year_month) }));
    this.fits = new Map();
  }
  fit(key, sub) {
    if (!this.fits.has(key)) {
      const X = sub.map(c => [1, c.age, c.mileage / 1e4]), y = sub.map(c => Math.log(c.price));
      let coef = lstsq3(X, y);
      if (coef) {
        const res = y.map((v, i) => v - X[i].reduce((s, x, j) => s + x * coef[j], 0));
        const mu = res.reduce((s, v) => s + v, 0) / res.length;
        const sd = Math.sqrt(res.reduce((s, v) => s + (v - mu) ** 2, 0) / res.length) || 1;
        const keep = res.map(v => Math.abs(v) <= 2.5 * sd);
        if (keep.filter(Boolean).length >= CFG.price.min_reg) coef = lstsq3(X.filter((_, i) => keep[i]), y.filter((_, i) => keep[i])) || coef;
      }
      this.fits.set(key, coef && coef[1] <= 0.05 ? coef : null);
    }
    return this.fits.get(key);
  }
  estimate(car) {
    const age = ageYears(car.year_month);
    for (const level of [['model', 'badge', 'badge_detail'], ['model', 'badge'], ['model']]) {
      const sub = this.df.filter(c => c.id !== car.id && level.every(k => c[k] === car[k]));
      const label = level.map(k => car[k]).join(' ');
      if (sub.length >= CFG.price.min_reg) {
        const coef = this.fit(label + '|' + level.length, sub);
        if (coef) return { market_price: Math.round(Math.exp(coef[0] + coef[1] * age + coef[2] * car.mileage / 1e4)), market_method: '회귀', market_n: sub.length };
      }
      const near = sub.filter(c => Math.abs(c.age - age) <= 1 && Math.abs(c.mileage - car.mileage) <= 30000);
      if (near.length >= CFG.price.min_grp) return { market_price: Math.round(median(near.map(c => c.price))), market_method: '중앙값', market_n: near.length };
    }
    return { market_price: null, market_method: '추정불가', market_n: 0 };
  }
}

// ---------- 분석 (analyzer.py) ----------
function damageMap(car) {
  const sev = { sheet: 1, exchange: 2, frame: 3 }, out = {};
  const put = (pid, status, rank, title) => { if (!out[pid] || sev[status] > sev[out[pid].status]) out[pid] = { status, rank, title: title || PARTS[pid] }; };
  for (const o of (car.inspection || {}).outers || []) {
    const frame = FRAME_RANKS.has(o.rank) || o.status === 'weld_cut';
    put(toPartId(o.code, o.title), frame ? 'frame' : o.status, o.rank, o.title);
  }
  for (const d of (car.diagnosis || {}).abnormal || []) {
    const pid = DIAG_MAP[d.name];
    if (pid && !out[pid]) put(pid, (d.result || '').includes('교환') ? 'exchange' : 'sheet', '1', PARTS[pid]);
  }
  return out;
}
function hardReasons(car, f) {
  const rec = car.record || {}, ins = car.inspection || {}, usage = (ins.usage_change || []).join(' '), r = [];
  if (rec.flood || ins.waterlog) r.push('침수 이력');
  if (rec.total_loss) r.push('전손 이력');
  if (rec.theft) r.push('도난 이력');
  const frames = Object.values(car.damage).filter(v => v.status === 'frame').map(v => v.title);
  if (frames.length) r.push('주요골격 손상: ' + frames.join(', '));
  if (f.noOuter && Object.values(car.damage).some(v => v.status !== 'frame')) r.push('외판 사고(제외 설정)');
  if (f.excludeRent && (rec.rent || usage.includes('렌트'))) r.push('렌트 이력(제외 설정)');
  if (f.excludeBusiness && (rec.business || usage.includes('영업'))) r.push('영업용 이력(제외 설정)');
  return r;
}
function analyze(cars, market, filters) {
  const sg = CFG.signals;
  for (const car of cars) {
    const det = car.detail || {};
    if (det.price) car.price = +det.price;
    if (det.mileage) car.mileage = +det.mileage;
    Object.assign(car, market.estimate(car));
    car.discount = car.market_price ? (car.market_price - car.price) / car.market_price : null;
    car.bait = car.discount !== null && car.discount >= CFG.price.bait;
    car.age = ageYears(car.year_month);
    car.yearly_km = Math.round(car.mileage / car.age);
    car.damage = damageMap(car);
    car.hard = hardReasons(car, filters);
    const hist = (car.price_history || []).map(x => x[1]), drops = [];
    for (let i = 1; i < hist.length; i++) if (hist[i] < hist[i - 1]) drops.push(hist[i - 1] - hist[i]);
    car.days_listed = det.first_ad ? Math.floor((NOW - det.first_ad) / 864e5) : null;
    car.price_drops = drops.length;
    const photos = det.photo_count ?? car.photo_count, s = [];
    if (car.days_listed !== null && car.days_listed >= sg.long_days) s.push(`장기 미판매 ${car.days_listed}일`);
    if (drops.length) s.push(`가격 인하 ${drops.length}회(-${num(drops.reduce((a, b) => a + b, 0))}만원)`);
    if (photos < sg.few_photos) s.push(`사진 적음(${photos}장)`);
    if (car.detail && det.desc_len < sg.short_desc) s.push('설명 부실');
    if (det.seizing) s.push(`압류/저당 ${det.seizing}건`);
    car.signals = s;
  }
  return cars;
}

// ---------- 점수 (scorer.py) ----------
function priceScore(car) {
  if (car.discount === null) return 0.5;
  const d = car.bait ? 0 : car.discount, full = CFG.price.full, zero = -CFG.price.zero;
  return clamp((d - zero) / (full - zero));
}
function historyScore(car) {
  const c = CFG.history, rec = car.record, usage = ((car.inspection || {}).usage_change || []).join(' ');
  if (!rec) return [clamp(1 - c.no_record), []];
  let s = 1; const notes = [];
  const costs = rec.my_costs.length ? rec.my_costs : Array(rec.my_cnt).fill(rec.my_cost / Math.max(rec.my_cnt, 1));
  for (const cost of costs) s -= cost <= c.small ? c.per_small : cost >= c.big ? c.per_big : c.per_mid;
  s -= c.per_other * rec.other_cnt + c.per_owner * Math.max(rec.owner_changes - 1, 0) + c.per_plate * rec.plate_changes;
  if (rec.rent || usage.includes('렌트')) { s -= c.rent; notes.push('렌트 이력'); }
  if (rec.business || usage.includes('영업')) { s -= c.business; notes.push('영업용 이력'); }
  if (rec.government || usage.includes('관용')) { s -= c.government; notes.push('관용 이력'); }
  return [clamp(s), notes];
}
function conditionScore(car) {
  const c = CFG.condition, ins = car.inspection;
  let s = ins ? 1 : 1 - c.no_insp;
  for (const v of Object.values(car.damage)) {
    const two = v.rank === '2';
    if (v.status === 'exchange') s -= two ? c.r2_ex : c.r1_ex;
    else if (v.status === 'sheet') s -= two ? c.r2_sh : c.r1_sh;
  }
  if (ins) s -= c.leak * ins.leaks.length + c.issue * ins.issues.length + (ins.tuning ? c.tuning : 0);
  if (car.docs.diagnosis === 'ok') s += car.diag_plus ? c.diag_plus : c.diag;
  if ((car.detail || {}).ev_battery_pass) s += c.ev;
  return clamp(s);
}
function mileageScore(car) {
  const { std, low } = CFG.mileage, y = car.yearly_km, isLow = y < low;
  const s = y <= std ? 1 : clamp(1 - (y - std) / std);
  return [isLow ? Math.min(s, 0.8) : s, isLow];
}
function gradeOf(score, hard, bait) {
  const G = CFG.grades;
  if (hard) return G[G.length - 1];
  let i = G.findIndex(x => score >= x.min);
  if (bait) i = Math.max(i, G.findIndex(x => x.grade === CFG.bait_max));
  return G[i];
}
function accidentSummary(car) {
  const d = Object.values(car.damage);
  if (d.some(v => v.status === 'frame')) return ['골격 손상', 'frame'];
  const ex = d.filter(v => v.status === 'exchange').length, sh = d.filter(v => v.status === 'sheet').length;
  if (!ex && !sh) return car.inspection || car.diagnosis ? ['무사고', 'ok'] : ['미확인', 'unknown'];
  return [[ex && `교환 ${ex}곳`, sh && `판금 ${sh}곳`].filter(Boolean).join(' · '), 'outer'];
}
function explain(car) {
  const rec = car.record, ins = car.inspection, pros = [], cons = [], nego = [], d = car.discount;
  if (d !== null) {
    const t = `시세 ${num(car.market_price)}만원(${car.market_method}, n=${car.market_n}) 대비 ${Math.abs(d * 100).toFixed(0)}% ${d >= 0 ? '저렴' : '비쌈'}`;
    (d < -0.03 ? cons : pros).push(t);
    if (d < 0) nego.push(`시세보다 ${num(Math.round(-d * car.market_price))}만원 높음 → 시세 수준 협상`);
  }
  if (car.bait) cons.push('시세보다 20% 이상 저렴 — 미끼/허위매물 의심, 실차 존재·추가비용 확인');
  if (car.acc_kind === 'ok') pros.push('성능점검 무사고');
  else if (Object.keys(car.damage).length) {
    cons.push('사고부위: ' + Object.entries(car.damage).map(([k, v]) => `${PARTS[k] || k} ${STATUS_KO[v.status]}`).join(', '));
    if (car.acc_kind === 'outer') nego.push('외판 수리 이력을 근거로 가격 조정 요청');
  }
  if (rec) {
    if (rec.my_cnt === 0) pros.push('내차피해 보험처리 없음'); else cons.push(`내차피해 ${rec.my_cnt}건 · ${num(Math.round(rec.my_cost / 1e4))}만원`);
    if (rec.owner_changes <= 1) pros.push(`소유자 변경 ${rec.owner_changes}회`); else if (rec.owner_changes >= 3) cons.push(`소유자 변경 ${rec.owner_changes}회`);
    cons.push(...car.history_notes);
  } else cons.push('보험이력 비공개/미확인 — 카히스토리 직접 조회 필요');
  if (car.docs.diagnosis === 'ok') pros.push(car.diag_plus ? '엔카진단+ 통과' : '엔카진단 통과');
  if (!ins) cons.push('성능점검기록부 없음');
  else cons.push(...ins.leaks.map(x => `누유/누수 — ${x}`), ...ins.issues.slice(0, 3).map(x => `점검 이상 — ${x}`));
  if (car.mileage_low) cons.push(`연 ${num(car.yearly_km)}km — 지나치게 적은 주행, 계기판 교체·장기 방치 여부 확인`);
  else if (car.yearly_km <= 12000) pros.push(`연 ${num(car.yearly_km)}km 저주행`);
  else if (car.yearly_km > 25000) cons.push(`연 ${num(car.yearly_km)}km 과주행`);
  for (const s of car.signals) (s.startsWith('장기') || s.startsWith('가격 인하') ? nego : cons).push(s);
  return { pros: pros.slice(0, 4), cons: [...car.hard.map(r => `제외: ${r}`), ...cons].slice(0, 5), nego: nego.slice(0, 3) };
}
function score(cars) {
  const w = CFG.weights;
  for (const car of cars) {
    const p = priceScore(car), [h, notes] = historyScore(car), c = conditionScore(car), [m, low] = mileageScore(car);
    car.history_notes = notes; car.mileage_low = low;
    car.s_price = +(p * w.price).toFixed(1); car.s_history = +(h * w.history).toFixed(1);
    car.s_condition = +(c * w.condition).toFixed(1); car.s_mileage = +(m * w.mileage).toFixed(1);
    car.score = +(car.s_price + car.s_history + car.s_condition + car.s_mileage).toFixed(1);
    const gr = gradeOf(car.score, car.hard.length > 0, car.bait);
    car.grade = gr.grade; car.grade_label = gr.label; car.grade_color = gr.color;
    [car.acc_text, car.acc_kind] = accidentSummary(car);
    Object.assign(car, explain(car));
  }
  const order = Object.fromEntries(CFG.grades.map((x, i) => [x.grade, i]));
  return cars.sort((a, b) => order[a.grade] - order[b.grade] || b.score - a.score);
}

// ---------- 렌더링 ----------
const $ = s => document.querySelector(s);
const DOC_LABELS = { inspection: '성능점검', record: '보험이력', diagnosis: '엔카진단' };
const docState = (car, k) => ['ok', 'private'].includes(car.docs[k]) ? car.docs[k] : 'none';
const docIcon = s => ({ ok: '✅', private: '🔒' })[s] || '❌';
const fmtDisc = car => car.discount === null ? '-' : `${car.discount >= 0 ? '+' : ''}${(car.discount * 100).toFixed(0)}%`;

function carSvg(car) {
  const p = pid => {
    const d = car.damage[pid], fr = pid.startsWith('frame') || pid.startsWith('pillar');
    const tip = `${PARTS[pid]} · ${d ? STATUS_KO[d.status] : '정상'}${d && d.rank ? ` · ${d.rank}랭크` : ''}`;
    return `class="pt${fr ? ' fr' : ''} ${d ? d.status : ''}" data-tip="${H(tip)}"`;
  };
  const R = (x, y, w, h, rx, pid) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" ${p(pid)}/>`;
  const G = (pid, rects) => `<g ${p(pid)}>${rects.map(([x, y, w, h]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}"/>`).join('')}</g>`;
  return `<svg viewBox="0 0 220 450" role="img" aria-label="사고 부위 도면">
    ${R(40, 6, 140, 20, 10, 'bumper_f')}${R(62, 28, 96, 9, 2, 'radiator')}${R(52, 40, 116, 100, 6, 'hood')}
    ${R(24, 40, 26, 100, 8, 'fender_fl')}${R(170, 40, 26, 100, 8, 'fender_fr')}
    <rect x="56" y="143" width="108" height="16" rx="3" class="glass"/>${R(52, 162, 116, 144, 4, 'roof')}
    <rect x="56" y="309" width="108" height="14" rx="3" class="glass"/>
    ${R(24, 142, 26, 86, 3, 'door_fl')}${R(24, 230, 26, 84, 3, 'door_rl')}${R(170, 142, 26, 86, 3, 'door_fr')}${R(170, 230, 26, 84, 3, 'door_rr')}
    ${R(14, 142, 8, 172, 3, 'sill_l')}${R(198, 142, 8, 172, 3, 'sill_r')}
    ${R(24, 316, 26, 100, 8, 'quarter_l')}${R(170, 316, 26, 100, 8, 'quarter_r')}${R(52, 326, 116, 90, 6, 'trunk')}${R(40, 422, 140, 20, 10, 'bumper_r')}
    ${G('frame_front', [[64, 44, 7, 92], [149, 44, 7, 92], [64, 44, 92, 7]])}
    ${G('frame_center', [[106, 176, 8, 116], [70, 230, 80, 7]])}
    ${G('frame_rear', [[64, 330, 7, 82], [149, 330, 7, 82], [64, 405, 92, 7]])}
    ${G('pillar_l', [[48, 140, 8, 20], [48, 224, 8, 10], [48, 304, 8, 18]])}
    ${G('pillar_r', [[164, 140, 8, 20], [164, 224, 8, 10], [164, 304, 8, 18]])}
  </svg>`;
}

function cardHtml(car, idx) {
  const rec = car.record;
  const docs = Object.entries(DOC_LABELS).map(([k, l]) => { const s = docState(car, k); return `<span class="b ${s}">${docIcon(s)} ${l}</span>`; }).join('');
  const anyDoc = Object.keys(DOC_LABELS).some(k => docState(car, k) !== 'none');
  const list = (cls, title, arr) => arr.length ? `<div class="${cls}"><h4>${title}</h4><ul>${arr.map(t => `<li>${H(t)}</li>`).join('')}</ul></div>` : '';
  const ym = car.year_month;
  return `<article class="card" data-grade="${car.grade}" data-rank="${idx}" data-score="${car.score}" data-price="${car.price}" data-disc="${car.discount ?? -9}" data-km="${car.mileage}">
  <div class="strip" style="background:${car.grade_color}"></div>
  <div class="body">
    <div class="head">
      <div class="gbadge" style="background:${car.grade_color}">${car.grade}</div>
      <div class="hmain">
        <div class="title"><a href="${car.url}" target="_blank" rel="noopener">${H(`${car.model} ${car.badge} ${car.badge_detail}`)}</a>${car.bait ? ' ⚠️' : ''}</div>
        <div class="meta">${ym ? `${Math.floor(ym / 100)}.${String(ym % 100).padStart(2, '0')}` : car.year} · ${num(car.mileage)}km (연 ${num(car.yearly_km)}km) · ${H(car.fuel)} · ${H(car.region)}</div>
      </div>
      <div class="score"><b>${car.score}</b><small>${car.grade_label}</small></div>
    </div>
    <div class="row price"><b>${num(car.price)}만원</b>
      ${car.market_price ? `<span class="meta">시세 ${num(car.market_price)}만원</span><span class="disc ${car.discount >= 0 ? 'up' : 'down'}">${fmtDisc(car)}</span>` : ''}
      <span class="meta">가격 ${car.s_price} · 이력 ${car.s_history} · 상태 ${car.s_condition} · 주행 ${car.s_mileage}</span></div>
    <div class="row">${docs}${anyDoc ? '' : '<span class="warnbox">서류 미확인 매물</span>'}</div>
    <div class="row"><span class="b ${car.acc_kind}">${car.acc_text}</span>
      ${rec ? `<span class="meta">내차피해 ${rec.my_cnt}건${rec.my_cnt ? ` · ${num(Math.round(rec.my_cost / 1e4))}만원` : ''} · 타차 ${rec.other_cnt}건 · 소유자변경 ${rec.owner_changes}회</span>` : ''}
      ${car.signals.map(s => `<span class="b none">${H(s)}</span>`).join('')}${car.bait ? '<span class="b alert">⚠️ 미끼/허위 의심</span>' : ''}</div>
    <div class="main">
      <div class="diagram">${carSvg(car)}
        <div class="legend"><span><i style="background:var(--p-normal)"></i>정상</span><span><i style="background:#F97316"></i>판금</span><span><i style="background:#EF4444"></i>교환</span><span><i class="hatch"></i>골격</span></div>
      </div>
      <div class="notes">${list('pros', '추천 이유', car.pros)}${list('cons', '확인할 점', car.cons)}${list('nego', '협상 포인트', car.nego)}</div>
    </div>
  </div></article>`;
}

function renderResults(cars, cond, ncomps) {
  state.cars = cars;
  const counts = Object.fromEntries(CFG.grades.map(x => [x.grade, cars.filter(c => c.grade === x.grade).length]));
  const ex = {};
  for (const c of cars) if (c.grade === 'F') for (const r of (c.hard.length ? c.hard.map(h => h.split(':')[0]) : ['점수 50점 미만'])) ex[r] = (ex[r] || 0) + 1;
  const main = cars.filter(c => c.grade !== 'F'), f = cars.filter(c => c.grade === 'F');
  $('#results').innerHTML = `
    <div class="sub">${H(cond)} · 시세 표본 ${num(ncomps)}건 · 분석 ${cars.length}건 · ${new Date().toLocaleString('ko-KR')}</div>
    <div class="summary">${CFG.grades.map(x => `<span class="gchip"><i style="background:${x.color}"></i>${x.grade} ${counts[x.grade]}</span>`).join('')}</div>
    <div class="toolbar">
      <button class="on" data-f="all">전체</button>${CFG.grades.filter(x => x.grade !== 'F').map(x => `<button data-f="${x.grade}">${x.grade}</button>`).join('')}
      <select id="sort"><option value="rank">정렬: 등급 → 점수</option><option value="score">점수 높은 순</option><option value="price">가격 낮은 순</option><option value="disc">시세 대비 할인 큰 순</option><option value="km">주행거리 적은 순</option></select>
      <button id="toggleF">제외(F) 매물 보기 (${counts.F})</button>
      <button id="csv">CSV 저장</button>
    </div>
    <div class="grid" id="mainGrid">${main.map((c, i) => cardHtml(c, i)).join('') || '<p class="sub">조건에 맞는 추천 매물이 없습니다.</p>'}</div>
    <section class="excl hidden" id="excl"><h2>제외 매물 (F ${counts.F}건)</h2>
      <p class="sub">${Object.entries(ex).map(([k, v]) => `${H(k)} ${v}건`).join(' · ')}</p>
      <div class="grid">${f.map((c, i) => cardHtml(c, 1000 + i)).join('')}</div></section>`;
  document.querySelectorAll('[data-f]').forEach(b => b.onclick = () => {
    document.querySelectorAll('[data-f]').forEach(x => x.classList.toggle('on', x === b));
    document.querySelectorAll('#mainGrid .card').forEach(c => c.classList.toggle('hidden', b.dataset.f !== 'all' && c.dataset.grade !== b.dataset.f));
  });
  $('#toggleF').onclick = () => {
    const h = $('#excl').classList.toggle('hidden');
    $('#toggleF').textContent = `${h ? '제외(F) 매물 보기' : '제외(F) 매물 숨기기'} (${counts.F})`;
    if (!h) $('#excl').scrollIntoView({ behavior: 'smooth' });
  };
  const keys = { rank: c => +c.dataset.rank, score: c => -c.dataset.score, price: c => +c.dataset.price, disc: c => -c.dataset.disc, km: c => +c.dataset.km };
  $('#sort').onchange = e => { const k = keys[e.target.value]; document.querySelectorAll('#results .grid').forEach(gd => [...gd.querySelectorAll('.card')].sort((a, b) => k(a) - k(b)).forEach(c => gd.appendChild(c))); };
  $('#csv').onclick = downloadCsv;
  $('#results').scrollIntoView({ behavior: 'smooth' });
}

function downloadCsv() {
  const cols = ['grade', 'score', 's_price', 's_history', 's_condition', 's_mileage', 'id', 'model', 'badge', 'badge_detail', 'year_month',
    'mileage', 'yearly_km', 'price', 'market_price', 'discount_pct', 'market_method', 'market_n', 'flag_bait', 'flag_low_mileage', 'hard_filter',
    'accident', 'damaged_parts', 'my_claims', 'my_claim_won', 'other_claims', 'owner_changes', 'plate_changes', 'rent', 'business', 'government',
    'doc_inspection', 'doc_record', 'doc_diagnosis', 'diag_plus', 'days_listed', 'price_drops', 'signals', 'fuel', 'region', 'url'];
  const rows = state.cars.map(x => {
    const r = x.record || {};
    return {
      ...x, discount_pct: x.discount === null ? '' : (x.discount * 100).toFixed(1), flag_bait: x.bait, flag_low_mileage: x.mileage_low,
      hard_filter: x.hard.join('; '), accident: x.acc_text, damaged_parts: Object.entries(x.damage).map(([k, v]) => `${PARTS[k]}:${STATUS_KO[v.status]}`).join('; '),
      my_claims: r.my_cnt, my_claim_won: r.my_cost, other_claims: r.other_cnt, owner_changes: r.owner_changes, plate_changes: r.plate_changes,
      rent: r.rent, business: r.business, government: r.government, doc_inspection: docState(x, 'inspection'), doc_record: docState(x, 'record'),
      doc_diagnosis: docState(x, 'diagnosis'), signals: x.signals.join('; '),
    };
  });
  const cell = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = '﻿' + [cols.join(','), ...rows.map(r => cols.map(c => cell(r[c])).join(','))].join('\n');
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })), download: 'results.csv' });
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- 폼 / 실행 ----------
const state = { makers: [], cars: [], running: false };

function setStatus(msg, kind = '') { const el = $('#status'); el.textContent = msg; el.className = 'status ' + kind; }
function setProgress(i, n, t0) {
  const pct = n ? Math.round(i / n * 100) : 0, left = i ? Math.round((Date.now() - t0) / i * (n - i) / 1000) : null;
  $('#bar').style.width = pct + '%';
  $('#progText').textContent = `${i}/${n}${left !== null ? ` · 남은 시간 약 ${left >= 60 ? Math.round(left / 60) + '분' : left + '초'}` : ''}`;
}
function fillSelect(sel, items, label) {
  sel.innerHTML = `<option value="">${label}</option>` + items.map((x, i) => `<option value="${i}">${H(x.name)} (${num(x.count)})</option>`).join('');
  sel.disabled = !items.length;
}

async function onMaker() {
  const m = state.makers[$('#maker').value];
  fillSelect($('#group'), [], '모델 선택'); $('#models').innerHTML = '';
  if (!m) return;
  setStatus('모델 목록 불러오는 중…');
  try { state.groups = await loadGroups(m.ct, m.name); fillSelect($('#group'), state.groups, '모델 선택'); setStatus(''); }
  catch (e) { setStatus('모델 목록을 불러오지 못했습니다: ' + e.message, 'err'); }
}
async function onGroup() {
  const m = state.makers[$('#maker').value], gr = (state.groups || [])[$('#group').value];
  $('#models').innerHTML = '';
  if (!m || !gr) return;
  setStatus('세부모델 불러오는 중…');
  try {
    state.models = await loadModels(m.ct, m.name, gr.name);
    $('#models').innerHTML = state.models.map((x, i) => `<label class="chk"><input type="checkbox" value="${i}" checked> ${H(x.name)} <small>${num(x.count)}</small></label>`).join('');
    setStatus('');
  } catch (e) { setStatus('세부모델을 불러오지 못했습니다: ' + e.message, 'err'); }
}

function readForm() {
  const v = id => $('#' + id).value.trim(), n = id => v(id) === '' ? null : Number(v(id));
  const m = state.makers[v('maker')], gr = (state.groups || [])[v('group')];
  if (!m || !gr) throw new Error('제조사와 모델을 선택하세요.');
  const models = [...document.querySelectorAll('#models input:checked')].map(i => state.models[i.value].name);
  if (!models.length) throw new Error('세부모델을 하나 이상 선택하세요.');
  const all = models.length === state.models.length;
  const yr = [n('yearFrom') || 1990, n('yearTo') || NOW.getFullYear() + 1], pr = [n('priceFrom') || 0, n('priceTo') || 1e6];
  return {
    t: { ct: m.ct, maker: m.name, group: gr.name, models: all ? [] : models,
      tokens: v('trim').split(/\s+/).map(norm).filter(Boolean), exclude: v('exclude').split(',').map(norm).filter(Boolean) },
    year: yr, price: pr, maxKm: n('maxKm'), fuel: v('fuel'), region: v('region'), maxCand: n('maxCand') || 100,
    filters: { noOuter: $('#noOuter').checked, excludeRent: $('#exRent').checked, excludeBusiness: $('#exBiz').checked },
    label: `${m.name} ${gr.name}${all ? '' : ' (' + models.join(', ') + ')'} · ${yr[0]}~${yr[1]}년 · ${num(pr[0])}~${pr[1] >= 1e6 ? '' : num(pr[1])}만원`
      + (n('maxKm') ? ` · ${num(n('maxKm'))}km 이하` : '') + (v('fuel') ? ` · ${v('fuel')}` : '') + (v('region') ? ` · ${v('region')}` : ''),
  };
}
const fuelMatch = (want, fuel) => {
  if (!want) return true;
  const w = norm(want), f = norm(fuel);
  return w === '전기' ? f === '전기' : w === '하이브리드' ? f.includes('+전기') : f.includes(w);
};

async function run() {
  if (state.running) { net.cancelled = true; setStatus('중단하는 중…'); return; }
  let f;
  try { f = readForm(); } catch (e) { setStatus(e.message, 'err'); return; }
  state.running = true; net.cancelled = false; net.stats = { network: 0, cache: 0, errors: 0 };
  $('#run').textContent = '중단'; $('#prog').classList.remove('hidden'); setProgress(0, 0, Date.now());
  try {
    setStatus('시세 비교용 매물 목록 수집 중…');
    const comps = await search(f.t, f.year);
    if (!comps.length) { setStatus('조건에 맞는 매물이 없습니다.', 'err'); return; }
    await recordPrices(comps);
    const market = new MarketModel(comps);
    let cands = comps.filter(it => it.price >= f.price[0] && it.price <= f.price[1] && it.price !== PRICE_PLACEHOLDER
      && !NON_PRICE_SELL.has(it.sell_type) && (!f.maxKm || it.mileage <= f.maxKm) && fuelMatch(f.fuel, it.fuel)
      && (!f.region || norm(it.region).includes(norm(f.region))));
    if (!cands.length) { setStatus(`시세 표본 ${num(comps.length)}건 중 가격·주행·연료·지역 조건에 맞는 매물이 없습니다.`, 'err'); return; }
    if (cands.length > f.maxCand) {
      const disc = it => { const mp = market.estimate(it).market_price; return mp ? (mp - it.price) / mp : 0; };
      cands = cands.map(it => [disc(it), it]).sort((a, b) => b[0] - a[0]).slice(0, f.maxCand).map(x => x[1]);
    }
    setStatus(`시세 표본 ${num(comps.length)}건 · 상세 조회 ${cands.length}건 (매물당 최대 4회 요청, 1~2초 간격)`);
    const t0 = Date.now(), cars = [];
    for (let i = 0; i < cands.length; i++) { cars.push(await collectVehicle(cands[i])); setProgress(i + 1, cands.length, t0); }
    renderResults(score(analyze(cars, market, f.filters)), f.label, comps.length);
    setStatus(`완료 — 요청 ${net.stats.network} · 캐시 ${net.stats.cache} · 실패 ${net.stats.errors}`, 'ok');
  } catch (e) {
    setStatus(e instanceof Cancelled ? '중단했습니다. 받은 데이터는 브라우저에 저장되어 다시 실행하면 이어서 빠르게 진행됩니다.' : '오류: ' + e.message, 'err');
  } finally {
    state.running = false; $('#run').textContent = '분석 시작'; $('#prog').classList.add('hidden');
  }
}

function initTooltip() {
  const tip = $('#tip');
  document.addEventListener('mouseover', e => { const t = e.target.closest('[data-tip]'); if (t) { tip.textContent = t.dataset.tip; tip.style.display = 'block'; } });
  document.addEventListener('mousemove', e => { tip.style.left = e.clientX + 12 + 'px'; tip.style.top = e.clientY + 12 + 'px'; });
  document.addEventListener('mouseout', e => { if (e.target.closest('[data-tip]')) tip.style.display = 'none'; });
  document.addEventListener('click', e => {           // 터치 기기: 탭하면 툴팁
    const t = e.target.closest('[data-tip]');
    if (t) { tip.textContent = t.dataset.tip; tip.style.display = 'block'; tip.style.left = e.clientX + 12 + 'px'; tip.style.top = e.clientY + 12 + 'px'; }
    else tip.style.display = 'none';
  });
}

async function init() {
  initTooltip();
  $('#yearTo').placeholder = NOW.getFullYear();
  $('#maker').onchange = onMaker; $('#group').onchange = onGroup; $('#run').onclick = run;
  $('#allModels').onclick = () => { const boxes = document.querySelectorAll('#models input'); const on = [...boxes].some(b => !b.checked); boxes.forEach(b => b.checked = on); };
  $('#clearCache').onclick = async () => { await Store.clear(); setStatus('캐시를 비웠습니다.', 'ok'); };
  await Store.open();
  setStatus('제조사 목록 불러오는 중…');
  try {
    state.makers = await loadMakers();
    $('#maker').innerHTML = '<option value="">제조사 선택</option>'
      + ['Y', 'N'].map(ct => `<optgroup label="${ct === 'Y' ? '국산' : '수입'}">${state.makers.map((m, i) => m.ct === ct ? `<option value="${i}">${H(m.name)} (${num(m.count)})</option>` : '').join('')}</optgroup>`).join('');
    setStatus('');
  } catch (e) { setStatus('엔카 데이터를 불러오지 못했습니다. 잠시 후 새로고침해 주세요. (' + e.message + ')', 'err'); }
}
document.addEventListener('DOMContentLoaded', init);
