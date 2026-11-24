/* 東美発注 v1 — iPadオフライン発注アプリ */
'use strict';
const APP_VERSION = '1.5.0';
const DB_NAME = 'tobi-hacchu2';
const DEPTS = ['画材', '額縁・木枠・キャンバス・金具'];
const ROWS_PER_SHEET = 30;
const PAGE_SIZE = 60;

/* ---------- 小物 ---------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const yen = n => (n == null || isNaN(n)) ? '' : Math.round(n).toLocaleString('ja-JP');
const toNum = v => { if (v === '' || v == null) return null; const n = Number(String(v).replace(/[,¥\s]/g, '')); return isNaN(n) ? null : n; };
const kata = s => s.replace(/[ぁ-ゖ]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60));
const norm = s => kata(String(s ?? '').normalize('NFKC').toLowerCase());
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const jpDate = iso => { const [y, m, d] = iso.slice(0, 10).split('-'); return `${y}年${+m}月${+d}日`; };
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function toast(msg, ms = 2200) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('on'), ms); }
function normJan(s) {
  let d = String(s ?? '').replace(/\D/g, '');
  if (d.length === 12 || d.length === 11) d = d.padStart(13, '0');
  return d;
}

/* ---------- IndexedDB ---------- */
let db;
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('products', { keyPath: 'id', autoIncrement: true });
      d.createObjectStore('suppliers', { keyPath: 'name' });
      d.createObjectStore('kv', { keyPath: 'k' });
      d.createObjectStore('carts', { keyPath: 'supplier' });
      const o = d.createObjectStore('orders', { keyPath: 'id', autoIncrement: true });
      o.createIndex('no', 'no');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function tx(stores, mode = 'readonly') { return db.transaction(stores, mode); }
function reqP(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
function done(t) { return new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); }); }
const getAll = s => reqP(tx(s).objectStore(s).getAll());
const put = (s, v) => { const t = tx(s, 'readwrite'); const r = t.objectStore(s).put(v); return done(t).then(() => r.result); };
const del = (s, k) => { const t = tx(s, 'readwrite'); t.objectStore(s).delete(k); return done(t); };
async function kvGet(k, def) { const v = await reqP(tx('kv').objectStore('kv').get(k)); return v ? v.v : def; }
const kvSet = (k, v) => put('kv', { k, v });

/* ---------- 状態 ---------- */
const S = {
  dept: DEPTS[0], page: 'order', supplier: null,
  products: [], byId: new Map(), bySup: new Map(), byJan: new Map(),
  suppliers: [], supMap: new Map(), brandRates: [], shop: {}, staff: [],
  carts: new Map(), // supplier -> Map(pid -> {qty, note})
  cartComm: new Map(), // supplier -> 追加コメント
  orders: [],
  oFiltered: [], oShown: 0, mFiltered: [], mShown: 0,
};
const LOT_DEFAULT_NOTE = '取り寄せ単位';

function indexProduct(p) {
  p._key = norm([p.code, p.name, p.jan, p.maker].join(' '));
  S.byId.set(p.id, p);
  if (!S.bySup.has(p.supplier)) S.bySup.set(p.supplier, []);
  S.bySup.get(p.supplier).push(p);
  if (p.jan) { if (!S.byJan.has(p.jan)) S.byJan.set(p.jan, []); S.byJan.get(p.jan).push(p); }
}
function rebuildIndex() {
  S.byId.clear(); S.bySup.clear(); S.byJan.clear();
  for (const p of S.products) indexProduct(p);
}
function unindexProduct(p) {
  S.byId.delete(p.id);
  const a = S.bySup.get(p.supplier); if (a) { const i = a.indexOf(p); if (i >= 0) a.splice(i, 1); }
  if (p.jan) { const b = S.byJan.get(p.jan); if (b) { const i = b.indexOf(p); if (i >= 0) b.splice(i, 1); if (!b.length) S.byJan.delete(p.jan); } }
  const i = S.products.indexOf(p); if (i >= 0) S.products.splice(i, 1);
}
function stripP(p) { const o = { ...p }; delete o._key; return o; }
async function saveProduct(p) {
  const isNew = p.id == null;
  if (!isNew) { const old = S.byId.get(p.id); if (old) unindexProduct(old); }
  p.updatedAt = Date.now();
  const id = await put('products', stripP(p));
  p.id = id; S.products.push(p); indexProduct(p);
  return p;
}
async function deleteProduct(p) { await del('products', p.id); unindexProduct(p); for (const c of S.carts.values()) c.delete(p.id); }

/* ---------- 掛率・金額 ---------- */
function rateOf(p) {
  if (p.rate != null) return p.rate;
  const br = S.brandRates.find(b => b.supplier === p.supplier && b.maker === p.maker);
  if (br) return br.rate;
  const s = S.supMap.get(p.supplier);
  return s && s.baseRate != null ? s.baseRate : null;
}
function cartOf(sup) { if (!S.carts.has(sup)) S.carts.set(sup, new Map()); return S.carts.get(sup); }
function cartTotals(sup) {
  const c = cartOf(sup); let cnt = 0, jo = 0, ge = 0, geUnknown = false, lines = 0;
  for (const [pid, it] of c) {
    const p = S.byId.get(pid); if (!p || !it.qty) continue;
    lines++; cnt += it.qty; jo += (p.jodai || 0) * it.qty;
    const r = rateOf(p); if (r == null || p.jodai == null) geUnknown = true; else ge += p.jodai * r * it.qty;
  }
  return { cnt, jo, ge, geUnknown, lines };
}
async function saveCartNow(sup) {
  const c = cartOf(sup);
  const items = [...c].filter(([, v]) => v.qty > 0 || v.note).map(([pid, v]) => ({ pid, qty: v.qty, note: v.note || '' }));
  const comm = S.cartComm.get(sup) || '';
  if (items.length || comm) await put('carts', { supplier: sup, items, comm, updatedAt: Date.now() }); else await del('carts', sup);
}
const saveCart = debounce(saveCartNow, 250);
function commFor(sup) { const extra = (S.cartComm.get(sup) || '').trim(); return [S.shop.commText || '', extra].filter(Boolean).join('\n'); }
function renderCommBtn() { const b = $('#btn-comm'); if (b) b.textContent = (S.cartComm.get(S.supplier) || '').trim() ? '通信欄 ✎' : '通信欄'; }
function openCommEditor() {
  modal(`<h3>通信欄　${esc(S.supplier)}</h3>
    <div class="field"><label>いつもの文（設定で変更できます）</label><div style="padding:8px 10px;background:#f4f5f7;border-radius:8px;white-space:pre-wrap">${esc(S.shop.commText || '（なし）')}</div></div>
    <div class="field" style="margin-top:10px"><label>この発注だけの追加コメント</label><textarea id="cm-extra" style="min-height:90px" placeholder="例：至急でお願いします／○日までに納品希望 など">${esc(S.cartComm.get(S.supplier) || '')}</textarea></div>
    <div class="acts"><button data-x="0">キャンセル</button><button class="primary" data-x="1">保存</button></div>`, el => {
    $('[data-x="0"]', el).onclick = closeModal;
    $('[data-x="1"]', el).onclick = () => { S.cartComm.set(S.supplier, $('#cm-extra', el).value); saveCartNow(S.supplier); closeModal(); renderCommBtn(); toast('通信欄を保存しました'); };
  });
}

/* ---------- 初期化 ---------- */
async function boot() {
  db = await openDB();
  const seeded = await kvGet('seeded', null);
  if (!seeded) await seedData();
  $('#loading-msg').textContent = 'データを読み込み中…';
  const [prods, sups, carts, orders] = await Promise.all([getAll('products'), getAll('suppliers'), getAll('carts'), getAll('orders')]);
  S.products = prods; rebuildIndex();
  S.suppliers = sups.sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
  S.supMap = new Map(S.suppliers.map(s => [s.name, s]));
  S.brandRates = await kvGet('brandRates', []);
  S.shop = await kvGet('shop', {});
  S.staff = await kvGet('staff', []);
  for (const c of carts) { S.carts.set(c.supplier, new Map(c.items.map(i => [i.pid, { qty: i.qty, note: i.note }]))); if (c.comm) S.cartComm.set(c.supplier, c.comm); }
  S.orders = orders.sort((a, b) => b.id - a.id);
  S.dept = await kvGet('lastDept', DEPTS[0]);
  bindUI();
  renderDept();
  selectSupplier(await kvGet('lastSup:' + S.dept, null));
  renderStaffSelect();
  $('#loading').style.display = 'none';
  setTimeout(() => checkBackupReminder().catch(() => { }), 800);
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => { });
}
async function seedData() {
  $('#loading-msg').textContent = '初回データを準備しています（約4万7千件・少しお待ちください）…';
  const [pj, sj] = await Promise.all([fetch('data/products.json').then(r => r.json()), fetch('data/seed.json').then(r => r.json())]);
  const t = tx(['products', 'suppliers', 'kv'], 'readwrite');
  const ps = t.objectStore('products');
  const cols = pj.cols;
  for (const row of pj.rows) {
    const o = {}; cols.forEach((c, i) => { o[c] = row[i]; });
    o.jan = o.jan || ''; o.code = o.code || ''; o.status = o.status || ''; o.check = o.check || ''; o.maker = o.maker || '';
    o.rate = null; o.manual = false;
    ps.add(o);
  }
  const ss = t.objectStore('suppliers');
  for (const s of sj.suppliers) ss.put(s);
  const kv = t.objectStore('kv');
  kv.put({ k: 'brandRates', v: sj.brandRates });
  kv.put({ k: 'shop', v: sj.shop });
  kv.put({ k: 'staff', v: sj.staff || [] });
  kv.put({ k: 'masterVersion', v: pj.version });
  kv.put({ k: 'seeded', v: new Date().toISOString() });
  await done(t);
}

/* ---------- 部門・仕入先 ---------- */
function deptSuppliers(d = S.dept) { return S.suppliers.filter(s => s.dept === d && s.active !== false); }
function renderDept() {
  $('#dept').innerHTML = DEPTS.map(d => `<button data-d="${esc(d)}" class="${d === S.dept ? 'on' : ''}">${esc(d)}</button>`).join('');
}
function renderChips() {
  const list = deptSuppliers();
  $('#supchips').innerHTML = list.map(s => {
    const t = cartTotals(s.name); const n = (S.bySup.get(s.name) || []).length;
    return `<button class="chip ${s.name === S.supplier ? 'on' : ''}" data-s="${esc(s.name)}">${esc(s.name)}${n ? '' : ' <small style="color:#8a919c">(手入力)</small>'}${t.lines ? `<span class="cnt">${t.lines}</span>` : ''}</button>`;
  }).join('') || '<span class="chk">この部門の仕入先がありません（設定で追加できます）</span>';
}
function selectSupplier(name) {
  const list = deptSuppliers();
  if (!list.find(s => s.name === name)) {
    const withCart = list.find(s => cartTotals(s.name).lines);
    name = (withCart || list[0] || {}).name || null;
  }
  S.supplier = name;
  kvSet('lastSup:' + S.dept, name);
  renderChips(); renderSupInfo(); filterOrderList(); renderFooter(); renderCommBtn();
}
function renderSupInfo() {
  const s = S.supMap.get(S.supplier);
  const el = $('#supinfo');
  if (!s) { el.innerHTML = ''; return; }
  const meta = [];
  if (s.cutoff) meta.push(`締切 <b>${esc(s.cutoff)}</b>`);
  if (s.arrival) meta.push(`到着 <b>${esc(s.arrival)}</b>`);
  if (s.backorder) meta.push(`注残 <b>${esc(s.backorder)}</b>`);
  if (s.serviceDay) meta.push(`サービスデイ <b>${esc(s.serviceDay)}</b>`);
  meta.push(`FAX <b>${esc(s.fax || '未登録')}</b>`);
  if (s.code) meta.push(`取引先コード <b>${esc(s.code)}</b>`);
  meta.push(`掛率 <b>${s.baseRate != null ? s.baseRate : (s.rateNote || '未設定')}</b>`);
  el.innerHTML = `<div class="supmeta">${meta.map(m => `<span>${m}</span>`).join('')}</div><div class="fs" id="fs"></div>`;
  renderFreeShip();
}
function renderFreeShip() {
  const s = S.supMap.get(S.supplier); const el = $('#fs'); if (!s || !el) return;
  const t = cartTotals(s.name);
  const basis = s.basis || 'その他';
  if ((basis === '上代' || basis === '下代') && s.freeLine) {
    const isGe = basis === '下代';
    const cur = isGe ? t.ge : t.jo;
    const pct = Math.min(100, cur / s.freeLine * 100);
    const rest = s.freeLine - cur;
    let msg;
    if (isGe && t.geUnknown && t.lines) msg = `<div class="fsmsg warn">掛率が分からない商品があります（設定または商品マスタで掛率を入れてください）</div>`;
    else if (rest <= 0) msg = `<div class="fsmsg ok">送料無料ラインに達しました</div>`;
    else msg = `<div class="fsmsg warn">あと ¥${yen(rest)} で送料無料${isGe ? '（下代は掛率からの目安）' : ''}</div>`;
    el.innerHTML = `<div class="fsrow"><span>送料無料ライン（${basis}基準）</span><span><b>¥${yen(cur)}</b> / ¥${yen(s.freeLine)}</span></div>
      <div class="bar"><div class="${rest <= 0 ? 'done' : ''}" style="width:${pct}%"></div></div>${msg}`;
  } else {
    el.innerHTML = `<div class="fsmsg sub">送料：${esc(basis === 'なし(必ず送料)' ? '必ず送料がかかります。' : '')}${esc(s.shippingNote || '条件未登録')}</div>`;
  }
}

/* ---------- 発注リスト ---------- */
function searchProducts(pool, q) {
  const toks = norm(q).split(/\s+/).filter(Boolean);
  if (!toks.length) return pool;
  return pool.filter(p => toks.every(t => p._key.includes(t)));
}
function filterOrderList() {
  const q = $('#q').value.trim();
  const all = $('#q-all').checked;
  const onlyCart = $('#q-cart').checked;
  let pool;
  if (onlyCart) {
    const c = cartOf(S.supplier); pool = [...c.keys()].map(id => S.byId.get(id)).filter(Boolean);
  } else if (all && q) {
    pool = S.products;
  } else {
    pool = S.bySup.get(S.supplier) || [];
  }
  let list = q ? searchProducts(pool, q) : pool;
  // 発注中の商品を上に
  if (!onlyCart && !q) {
    const c = cartOf(S.supplier);
    if (c.size) { const top = list.filter(p => c.get(p.id)?.qty); const rest = list.filter(p => !c.get(p.id)?.qty); list = top.concat(rest); }
  }
  S.oFiltered = list; S.oShown = 0;
  $('#olist').innerHTML = '';
  $('#olist-wrap').scrollTop = 0;
  appendOrderRows();
}
function lotLabel(p) { return p.lot > 1 ? `<span class="badge b-lot">${p.lot}${esc(p.unit || '個')}単位</span>` : ''; }
function rowHTML(p) {
  const it = cartOf(p.supplier).get(p.id) || { qty: 0, note: '' };
  const showSup = p.supplier !== S.supplier;
  const warn = p.check ? `<span class="badge b-warn" title="${esc(p.check)}">要確認</span>` : '';
  const lotWarn = it.qty && p.lot > 1 && it.qty % p.lot ? `<div class="lotwarn">※${p.lot}${esc(p.unit || '個')}単位の商品です（${it.qty}は端数です）</div>` : '';
  return `<div class="row ${it.qty ? 'has' : ''}" data-id="${p.id}">
    <div class="code">${esc(p.code)}</div>
    <div class="nm">${esc(p.name)}${lotLabel(p)}${warn}${showSup ? `<span class="badge b-sup">${esc(p.supplier)}</span>` : ''}
      <small>${esc([p.maker !== p.supplier ? p.maker : '', p.jan, p.status].filter(Boolean).join('　'))}</small></div>
    <div class="pr">${p.jodai != null ? '¥' + yen(p.jodai) : '<small>上代なし</small>'}</div>
    <div class="qty"><button data-a="minus">−</button><input type="number" inputmode="numeric" min="0" value="${it.qty || ''}" data-a="qty" placeholder="0"><button data-a="plus">＋</button></div>
    ${it.qty ? `<div class="noteline"><label>備考</label><input data-a="note" value="${esc(it.note)}" placeholder="客注 日付・お名前など"></div>` : ''}
    ${lotWarn}
  </div>`;
}
function appendOrderRows() {
  const slice = S.oFiltered.slice(S.oShown, S.oShown + PAGE_SIZE);
  $('#olist').insertAdjacentHTML('beforeend', slice.map(rowHTML).join(''));
  S.oShown += slice.length;
  const n = S.oFiltered.length;
  $('#omore').textContent = n === 0 ? (S.supplier && !(S.bySup.get(S.supplier) || []).length ? 'この仕入先は商品マスタがありません。「＋商品を登録」で追加できます。' : '該当する商品がありません') :
    (S.oShown < n ? `${S.oShown} / ${n} 件表示中（下にスクロールで続きを表示）` : `${n} 件`);
}
function refreshRow(p) {
  const el = $(`#olist .row[data-id="${p.id}"]`);
  if (!el || !el.isConnected) return;
  const tmp = document.createElement('div'); tmp.innerHTML = rowHTML(p);
  requestAnimationFrame(() => { if (el.isConnected) el.replaceWith(tmp.firstElementChild); });
}
function setQty(p, qty, opts = {}) {
  qty = Math.max(0, Math.round(qty || 0));
  const c = cartOf(p.supplier);
  const it = c.get(p.id) || { qty: 0, note: '' };
  it.qty = qty;
  if (!qty && !it.note) c.delete(p.id); else c.set(p.id, it);
  saveCart(p.supplier);
  if (!opts.noRow) refreshRow(p);
  renderFooter(); renderFreeShip(); renderChipCount(p.supplier);
}
function renderChipCount(sup) {
  const b = $(`#supchips .chip[data-s="${CSS.escape(sup)}"]`);
  if (!b) { return; }
  const t = cartTotals(sup); let c = $('.cnt', b);
  if (t.lines) { if (!c) { b.insertAdjacentHTML('beforeend', '<span class="cnt"></span>'); c = $('.cnt', b); } c.textContent = t.lines; } else if (c) c.remove();
}
function renderFooter() {
  const t = cartTotals(S.supplier);
  $('#f-cnt').textContent = `${t.lines}品目 ${t.cnt}点`;
  $('#f-jo').textContent = `上代計 ¥${yen(t.jo)}`;
  $('#f-ge').textContent = t.lines ? (t.geUnknown ? '下代目安：掛率未設定の商品あり' : `下代目安 ¥${yen(t.ge)}`) : '';
}
function renderStaffSelect() {
  const cur = $('#staff-sel').value || sessionStorage.getItem('staff') || '';
  const act = S.staff.filter(s => s.active !== false);
  $('#staff-sel').innerHTML = `<option value="">担当者を選択</option>` + act.map(s => `<option ${s.name === cur ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
}

/* ---------- 発注書 ---------- */
function cartLines(sup) {
  const c = cartOf(sup);
  return [...c].filter(([, v]) => v.qty > 0).map(([pid, v]) => {
    const p = S.byId.get(pid); if (!p) return null;
    return { pid, code: p.code, name: p.name, jan: p.jan, qty: v.qty, unit: p.unit || '個', jodai: p.jodai, rate: rateOf(p), note: v.note || '', lot: p.lot || null };
  }).filter(Boolean);
}
function fitCls(t, w) { const n = [...String(t || '')].reduce((a, c) => a + (c.charCodeAt(0) > 0xff ? 1 : 0.55), 0); return n <= w ? '' : n <= w * 1.3 ? 'fs1' : 'fs2'; }
function sheetHTML(o) {
  const s = S.supMap.get(o.supplier) || { name: o.supplier };
  const shop = o.shop || S.shop;
  const lines = o.items;
  const pages = Math.max(1, Math.ceil(lines.length / ROWS_PER_SHEET));
  const totalQty = lines.reduce((a, l) => a + l.qty, 0);
  const totalJo = lines.reduce((a, l) => a + (l.jodai || 0) * l.qty, 0);
  let html = '';
  for (let pg = 0; pg < pages; pg++) {
    const part = lines.slice(pg * ROWS_PER_SHEET, (pg + 1) * ROWS_PER_SHEET);
    const last = pg === pages - 1;
    const rows = part.map((l, i) => `<tr><td class="c">${pg * ROWS_PER_SHEET + i + 1}</td><td>${esc(l.code)}</td><td class="${fitCls(l.name, 30)}">${esc(l.name)}</td><td class="c">${l.qty}</td><td class="c">${esc(l.unit)}</td><td class="r">${l.jodai != null ? yen(l.jodai) : ''}</td><td class="r">${l.jodai != null ? yen(l.jodai * l.qty) : ''}</td><td class="${fitCls(l.note, 11)}">${esc(l.note)}</td></tr>`).join('');
    html += `<div class="sheet">
      <div class="sh-top"><div class="sh-title">発注書</div><div class="sh-no">No. ${esc(o.no || '（未確定）')}<br>発注日 ${jpDate(o.date || today())}</div></div>
      <div class="sh-mid">
        <div class="sh-to"><div class="nm">${esc(s.name)} 御中</div>
          ${s.fax ? `<div>FAX ${esc(s.fax)}</div>` : ''}${s.code ? `<div>取引先コード ${esc(s.code)}</div>` : ''}</div>
        <div class="sh-from"><div class="nm">${esc(shop.name || '')}</div>
          ${shop.zip ? '〒' + esc(shop.zip) + ' ' : ''}${esc(shop.address || '')}<br>
          ${shop.tel === shop.fax ? `TEL・FAX ${esc(shop.tel || '')}` : `TEL ${esc(shop.tel || '')}　FAX ${esc(shop.fax || '')}`}<br>
          ${shop.email ? esc(shop.email) + '<br>' : ''}担当：${esc(o.staff || '')}</div>
      </div>
      <div class="sh-lead">下記のとおり発注いたします。</div>
      <table class="sh"><colgroup><col style="width:8mm"><col style="width:27mm"><col><col style="width:11mm"><col style="width:10mm"><col style="width:16mm"><col style="width:19mm"><col style="width:33mm"></colgroup>
        <tr><th class="c">No</th><th>品番</th><th>商品名</th><th class="c">数量</th><th class="c">単位</th><th class="r">上代</th><th class="r">金額</th><th>備考</th></tr>
        ${rows}
        ${last ? `<tr class="tot"><td colspan="3" class="r">合計（上代・税抜）</td><td class="c">${totalQty}</td><td></td><td></td><td class="r">${yen(totalJo)}</td><td></td></tr>` : ''}
      </table>
      ${last ? `<div class="sh-comm"><div class="lb">通信欄</div>${esc(o.comm ?? '')}</div>` : ''}
      <div class="sh-page">${pg + 1} / ${pages}</div>
    </div>`;
  }
  return html;
}
let pvOrder = null;
let pvPdf = null; // {order, file}
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const USE_PDF = IS_IOS || new URLSearchParams(location.search).has('pdf');
function loadScript(src) { return new Promise((res, rej) => { if (document.querySelector(`script[src="${src}"]`)) return res(); const sc = document.createElement('script'); sc.src = src; sc.onload = res; sc.onerror = () => rej(new Error(src + ' を読み込めませんでした')); document.head.appendChild(sc); }); }
function pdfName(o) { return `発注書_${o.supplier}_${o.no || '未確定'}.pdf`.replace(/[\\/:*?"<>|]/g, '_'); }
async function buildPDF(o) {
  await loadScript('html2canvas.min.js'); await loadScript('jspdf.umd.min.js');
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;left:-10000px;top:0;width:210mm;background:#fff';
  box.innerHTML = sheetHTML(o); document.body.appendChild(box);
  try {
    const pdf = new jspdf.jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
    const sheets = $$('.sheet', box);
    for (let i = 0; i < sheets.length; i++) {
      const cv = await html2canvas(sheets[i], { scale: 2.5, backgroundColor: '#ffffff', logging: false });
      if (i) pdf.addPage();
      pdf.addImage(cv.toDataURL('image/jpeg', 0.9), 'JPEG', 0, 0, 210, 297);
    }
    return new File([pdf.output('blob')], pdfName(o), { type: 'application/pdf' });
  } finally { box.remove(); }
}
async function sharePDF() {
  const o = pvOrder; if (!o) return;
  const btn = $('#pv-print');
  if (!pvPdf || pvPdf.order !== o) {
    btn.disabled = true; btn.textContent = 'PDFを作成中…';
    try { pvPdf = { order: o, file: await buildPDF(o) }; }
    catch (e) { toast('PDFを作れませんでした：' + (e.message || e), 4000); btn.disabled = false; btn.textContent = 'PDF・印刷'; return; }
    btn.disabled = false; btn.textContent = 'PDFを共有（印刷・メール）';
  }
  const f = pvPdf.file;
  if (navigator.canShare && navigator.canShare({ files: [f] })) {
    try { await navigator.share({ files: [f], title: f.name }); }
    catch (e) { if (e.name === 'NotAllowedError') toast('PDFができました。もう一度ボタンを押してください', 3500); }
  } else {
    const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }
}
function openPrintView(o) {
  pvOrder = o; pvPdf = null;
  $('#pv-print').textContent = USE_PDF ? 'PDF・印刷' : '印刷・PDF'; $('#pv-print').disabled = false;
  $('#sheets').innerHTML = sheetHTML(o);
  $('#pv-title').textContent = `発注書　${o.supplier}　${o.no || '（未確定・確認用）'}　${o.items.length}品目`;
  $('#printview').classList.add('on');
  fitSheets();
}
function fitSheets() {
  const w = $('#sheets').clientWidth - 32; const mm = 3.78; const sheetW = 210 * mm;
  const sc = Math.min(1, w / sheetW);
  $$('#sheets .sheet').forEach(el => { el.style.transform = `scale(${sc})`; el.style.marginBottom = `${-(297 * mm) * (1 - sc) + 16}px`; });
}
function mailOrder(o) {
  const s = S.supMap.get(o.supplier) || {};
  if (!s.email) { toast('メールアドレスが未登録です'); return; }
  const shop = o.shop || S.shop;
  const lines = o.items.map((l, i) => `${i + 1}. ${l.code}　${l.name}　${l.qty}${l.unit}${l.note ? '　（' + l.note + '）' : ''}`);
  const body = `${s.name} 御中\n\nいつもお世話になっております。${shop.name}です。\n下記のとおり発注いたします。\n\n発注番号：${o.no || ''}\n発注日：${jpDate(o.date || today())}${s.code ? '\n取引先コード：' + s.code : ''}\n\n${lines.join('\n')}\n\n合計 ${o.items.reduce((a, l) => a + l.qty, 0)}点\n\n${o.comm || ''}\n\n${shop.name}\n〒${shop.zip || ''} ${shop.address || ''}\nTEL ${shop.tel || ''} / FAX ${shop.fax || ''}\n担当：${o.staff || ''}`;
  location.href = `mailto:${encodeURIComponent(s.email)}?subject=${encodeURIComponent(`発注書（${shop.name}）No.${o.no || ''}`)}&body=${encodeURIComponent(body)}`;
}
async function nextOrderNo() {
  const d = today().replace(/-/g, '');
  const seq = await kvGet('orderSeq', { d: '', n: 0 });
  const n = seq.d === d ? seq.n + 1 : 1;
  await kvSet('orderSeq', { d, n });
  return `H-${d}-${String(n).padStart(3, '0')}`;
}

/* ---------- モーダル ---------- */
function modal(html, onBind) {
  $('#modal-body').innerHTML = html; $('#modal').classList.add('on');
  if (onBind) onBind($('#modal-body'));
}
function closeModal() { $('#modal').classList.remove('on'); $('#modal-body').innerHTML = ''; }
function confirmBox(msg, okLabel = 'OK') {
  return new Promise(res => {
    modal(`<h3>確認</h3><div style="white-space:pre-wrap">${esc(msg)}</div><div class="acts"><button data-x="0">キャンセル</button><button class="primary" data-x="1">${esc(okLabel)}</button></div>`,
      el => $$('button[data-x]', el).forEach(b => b.onclick = () => { closeModal(); res(b.dataset.x === '1'); }));
  });
}

/* ---------- 発注確定 ---------- */
async function confirmOrder() {
  const sup = S.supplier; const lines = cartLines(sup);
  if (!lines.length) { toast('数量が入っている商品がありません'); return; }
  const staff = $('#staff-sel').value;
  if (!staff) { toast(S.staff.length ? '担当者を選んでください' : '設定で担当者を登録してください'); $('#staff-sel').focus(); return; }
  const lotOdd = lines.filter(l => l.lot > 1 && l.qty % l.lot);
  const t = cartTotals(sup);
  modal(`<h3>発注確定　${esc(sup)}</h3>
    <div>${lines.length}品目・${t.cnt}点　上代計 ¥${yen(t.jo)}　担当：${esc(staff)}</div>
    ${lotOdd.length ? `<div class="err" style="margin-top:8px">取り寄せ単位の端数があります：<br>${lotOdd.map(l => `・${esc(l.name)}（${l.lot}単位 / ${l.qty}）`).join('<br>')}</div>` : ''}
    <div class="field" style="margin-top:12px"><label>通信欄（いつもの文）</label><div style="padding:8px 10px;background:#f4f5f7;border-radius:8px;white-space:pre-wrap">${esc(S.shop.commText || '（なし）')}</div></div>
    <div class="field" style="margin-top:8px"><label>この発注だけの追加コメント</label><textarea id="c-extra" placeholder="例：至急でお願いします／○日までに納品希望 など">${esc(S.cartComm.get(sup) || '')}</textarea></div>
    <div class="acts"><button data-x="0">戻る</button><button class="primary" data-x="1">確定して発注書を作る</button></div>`, el => {
    $('[data-x="0"]', el).onclick = closeModal;
    $('[data-x="1"]', el).onclick = async () => {
      const o = { no: await nextOrderNo(), date: today(), createdAt: new Date().toISOString(), supplier: sup, dept: S.supMap.get(sup)?.dept || S.dept, staff, items: lines, comm: [S.shop.commText || '', $('#c-extra', el).value.trim()].filter(Boolean).join('\n'), shop: { ...S.shop }, totalJodai: t.jo, totalQty: t.cnt };
      o.id = await put('orders', o);
      S.orders.unshift(o);
      S.carts.set(sup, new Map()); S.cartComm.delete(sup); await del('carts', sup); renderCommBtn();
      closeModal(); filterOrderList(); renderFooter(); renderFreeShip(); renderChips();
      openPrintView(o);
      toast(`発注を確定しました（${o.no}）`);
    };
  });
}

/* ---------- バーコード ---------- */
let scanCtl = null;
async function openScanner() {
  modal(`<h3>バーコード読取</h3><video id="scanv" playsinline muted></video>
    <div id="scanmsg" style="margin-top:8px;font-size:14px">商品のバーコードをカメラに向けてください</div>
    <div class="acts"><button data-x="close" class="primary">閉じる</button></div>`, el => { $('[data-x="close"]', el).onclick = stopScanner; });
  const video = $('#scanv');
  let last = '', lastAt = 0;
  const onCode = code => {
    const now = Date.now(); if (code === last && now - lastAt < 2000) return; last = code; lastAt = now;
    handleScan(code, true);
  };
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false });
    video.srcObject = stream; await video.play();
    scanCtl = { stream, stop: false };
    if ('BarcodeDetector' in window) {
      const det = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'] });
      const loop = async () => { if (!scanCtl || scanCtl.stop) return; try { const r = await det.detect(video); if (r[0]) onCode(r[0].rawValue); } catch (e) { } setTimeout(loop, 250); };
      loop();
    } else if (window.ZXing) {
      const hints = new Map(); const F = ZXing.BarcodeFormat;
      hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128]);
      const reader = new ZXing.BrowserMultiFormatReader(hints, 300);
      scanCtl.reader = reader;
      reader.decodeFromStream(stream, video, (res) => { if (res && scanCtl && !scanCtl.stop) onCode(res.getText()); });
    } else { $('#scanmsg').textContent = 'この端末ではバーコード読取が使えません'; }
  } catch (e) {
    $('#scanmsg').innerHTML = `<span class="err">カメラを起動できませんでした（${esc(e.name || e.message)}）。Safariのカメラ許可を確認してください。</span>`;
  }
}
function stopScanner() {
  let lastP = null;
  if (scanCtl) { lastP = scanCtl.lastP; scanCtl.stop = true; try { scanCtl.reader?.reset(); } catch (e) { } scanCtl.stream?.getTracks().forEach(t => t.stop()); scanCtl = null; }
  closeModal();
  if (lastP) jumpTo(lastP); else if (S.page === 'order') { renderChips(); filterOrderList(); renderFooter(); renderFreeShip(); }
}
function handleScan(raw, fromCamera) {
  const jan = normJan(raw);
  const hits = (S.byJan.get(jan) || []).concat(jan !== raw ? (S.byJan.get(raw) || []) : []);
  const uniq = [...new Set(hits)];
  if (uniq.length === 1) { addFromScan(uniq[0], fromCamera); return; }
  if (fromCamera) stopScanner();
  if (uniq.length > 1) {
    modal(`<h3>同じJANの商品が${uniq.length}件あります</h3><div>発注する商品を選んでください（JAN ${esc(jan)}）</div>
      <div style="margin-top:10px">${uniq.map(p => `<button style="display:block;width:100%;text-align:left;margin-bottom:6px" data-id="${p.id}">${esc(p.supplier)}｜${esc(p.code)}　${esc(p.name)}　¥${yen(p.jodai)}</button>`).join('')}</div>
      <div class="acts"><button data-x="0">キャンセル</button></div>`, el => {
      $('[data-x="0"]', el).onclick = closeModal;
      $$('button[data-id]', el).forEach(b => b.onclick = () => { closeModal(); addFromScan(S.byId.get(+b.dataset.id), false); });
    });
  } else {
    openProductForm({ jan, supplier: S.supplier }, true);
    toast('登録されていないJANです。新しい商品として登録できます', 3000);
  }
}
function addFromScan(p, fromCamera) {
  const it = cartOf(p.supplier).get(p.id);
  const step = p.lot > 1 ? p.lot : 1;
  setQty(p, (it?.qty || 0) + step, { noRow: true });
  if (navigator.vibrate) navigator.vibrate(60);
  const msg = `${p.supplier}：${p.name}　＋${step}（計${cartOf(p.supplier).get(p.id).qty}）`;
  if (fromCamera && $('#scanmsg')) $('#scanmsg').textContent = msg; else toast(msg);
  if (p.supplier !== S.supplier || S.supMap.get(p.supplier)?.dept !== S.dept) {
    if (!fromCamera) jumpTo(p); else scanCtl && (scanCtl.lastP = p);
  } else if (!fromCamera) filterOrderList();
}
function jumpTo(p) {
  const s = S.supMap.get(p.supplier);
  if (s && s.dept !== S.dept) { S.dept = s.dept; kvSet('lastDept', S.dept); renderDept(); }
  $('#q').value = ''; $('#q-all').checked = false;
  selectSupplier(p.supplier);
}

/* ---------- 商品フォーム ---------- */
function supplierOptions(sel) {
  return S.suppliers.map(s => `<option ${s.name === sel ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
}
function openProductForm(p, fromOrder) {
  const isNew = p.id == null;
  p = { dept: '', supplier: S.supplier, maker: '', jan: '', code: '', name: '', unit: '個', lot: null, jodai: null, gedai: null, rate: null, status: '', check: '', manual: true, ...p };
  modal(`<h3>${isNew ? '商品を登録' : '商品を編集'}</h3>
    <div class="grid2">
      <div class="field"><label>仕入先</label><select id="pf-sup">${supplierOptions(p.supplier)}</select></div>
      <div class="field"><label>メーカー・ブランド</label><input id="pf-maker" value="${esc(p.maker)}"></div>
      <div class="field"><label>JAN</label><input id="pf-jan" inputmode="numeric" value="${esc(p.jan)}"></div>
      <div class="field"><label>品番</label><input id="pf-code" value="${esc(p.code)}"></div>
      <div class="field" style="grid-column:1/-1"><label>商品名（必須）</label><input id="pf-name" value="${esc(p.name)}"></div>
      <div class="field"><label>上代（税抜）</label><input id="pf-jodai" inputmode="decimal" value="${p.jodai ?? ''}"></div>
      <div class="field"><label>単位</label><input id="pf-unit" value="${esc(p.unit)}" list="units"><datalist id="units"><option>個<option>本<option>冊<option>枚<option>箱<option>袋<option>セット<option>ダース<option>巻<option>組<option>パック</datalist></div>
      <div class="field"><label>取り寄せ単位（空欄＝1個から）</label><input id="pf-lot" inputmode="numeric" value="${p.lot ?? ''}"></div>
      <div class="field"><label>この商品の掛率（空欄＝仕入先の掛率）</label><input id="pf-rate" inputmode="decimal" value="${p.rate ?? ''}" placeholder="${esc(String(rateOf({ ...p, rate: null }) ?? '未設定'))}"></div>
      <div class="field" style="grid-column:1/-1"><label>状態・メモ</label><input id="pf-status" value="${esc(p.status)}"></div>
    </div>
    ${p.check ? `<div class="err" style="margin-top:8px">要確認：${esc(p.check)} <button class="small" id="pf-clearcheck">確認済みにする</button></div>` : ''}
    <div id="pf-err" class="err"></div>
    <div class="acts">${!isNew ? '<button class="danger" id="pf-del">削除</button><span class="spacer"></span>' : ''}<button id="pf-cancel">キャンセル</button><button class="primary" id="pf-save">保存</button></div>`, el => {
    $('#pf-cancel', el).onclick = closeModal;
    if ($('#pf-clearcheck', el)) $('#pf-clearcheck', el).onclick = () => { p.check = ''; $('#pf-clearcheck', el).parentElement.remove(); };
    if ($('#pf-del', el)) $('#pf-del', el).onclick = async () => {
      if (!(await confirmBox(`「${p.name}」を削除しますか？`, '削除'))) return;
      await deleteProduct(S.byId.get(p.id)); toast('削除しました'); afterProductChange();
    };
    $('#pf-save', el).onclick = async () => {
      const np = { ...p };
      np.supplier = $('#pf-sup', el).value; np.maker = $('#pf-maker', el).value.trim();
      np.jan = normJan($('#pf-jan', el).value) || ''; np.code = $('#pf-code', el).value.trim(); np.name = $('#pf-name', el).value.trim();
      np.jodai = toNum($('#pf-jodai', el).value); np.unit = $('#pf-unit', el).value.trim() || '個';
      const lot = toNum($('#pf-lot', el).value); np.lot = lot > 1 ? Math.round(lot) : null;
      const r = toNum($('#pf-rate', el).value); np.rate = r != null && r > 0 && r < 1.5 ? r : null;
      np.status = $('#pf-status', el).value.trim();
      np.dept = S.supMap.get(np.supplier)?.dept || np.dept || S.dept;
      if (!np.name) { $('#pf-err', el).textContent = '商品名を入れてください'; return; }
      if (np.jan && (S.byJan.get(np.jan) || []).some(x => x.id !== np.id)) {
        const others = S.byJan.get(np.jan).filter(x => x.id !== np.id);
        if (!(await confirmBox(`同じJANの商品がすでにあります：\n${others.map(o => `${o.supplier}｜${o.name}`).join('\n')}\n\nこのまま保存しますか？`, '保存する'))) return;
      }
      const saved = await saveProduct(np);
      closeModal(); toast('保存しました'); afterProductChange();
      if (fromOrder && isNew) { jumpTo(saved); setQty(saved, saved.lot > 1 ? saved.lot : 1); }
    };
  });
}
function afterProductChange() {
  if (S.page === 'order') { renderChips(); filterOrderList(); renderFooter(); renderFreeShip(); }
  if (S.page === 'master') filterMaster();
}

/* ---------- 履歴 ---------- */
function renderHistory() {
  const hs = $('#h-sup'), hst = $('#h-staff');
  const curS = hs.value, curT = hst.value;
  const sups = [...new Set(S.orders.map(o => o.supplier))];
  const stf = [...new Set(S.orders.map(o => o.staff))];
  hs.innerHTML = '<option value="">全仕入先</option>' + sups.map(s => `<option ${s === curS ? 'selected' : ''}>${esc(s)}</option>`).join('');
  hst.innerHTML = '<option value="">全担当者</option>' + stf.map(s => `<option ${s === curT ? 'selected' : ''}>${esc(s)}</option>`).join('');
  const m = $('#h-month').value;
  const list = S.orders.filter(o => (!curS || o.supplier === curS) && (!curT || o.staff === curT) && (!m || o.date.startsWith(m)));
  $('#h-cnt').textContent = `${list.length}件`;
  $('#hlist').innerHTML = list.length ? `<table class="t"><tr><th>発注番号</th><th>発注日</th><th>仕入先</th><th>担当</th><th class="num">品目</th><th class="num">上代計</th><th></th></tr>` +
    list.map(o => `<tr data-id="${o.id}"><td>${esc(o.no)}</td><td>${esc(o.date)}</td><td>${esc(o.supplier)}</td><td>${esc(o.staff)}</td><td class="num">${o.items.length}</td><td class="num">¥${yen(o.totalJodai)}</td>
      <td style="white-space:nowrap"><button class="small" data-a="view">発注書</button> <button class="small" data-a="re">再発注</button> <button class="small danger" data-a="del">削除</button></td></tr>`).join('') + '</table>'
    : '<div class="empty">発注履歴はまだありません</div>';
}

/* ---------- 商品マスタ ---------- */
function renderMasterSupSel() {
  const cur = $('#m-sup').value;
  $('#m-sup').innerHTML = `<option value="">全仕入先（${S.products.length.toLocaleString()}件）</option>` + S.suppliers.map(s => `<option value="${esc(s.name)}" ${s.name === cur ? 'selected' : ''}>${esc(s.name)}（${(S.bySup.get(s.name) || []).length.toLocaleString()}）</option>`).join('');
}
function filterMaster() {
  const sup = $('#m-sup').value; const q = $('#m-q').value.trim(); const onlyCheck = $('#m-check').checked;
  let pool = sup ? (S.bySup.get(sup) || []) : S.products;
  if (onlyCheck) pool = pool.filter(p => p.check);
  S.mFiltered = q ? searchProducts(pool, q) : pool; S.mShown = 0;
  $('#mtable').innerHTML = `<tr><th>仕入先</th><th>品番</th><th>商品名</th><th>JAN</th><th class="num">上代</th><th>単位</th><th class="num">取寄単位</th><th class="num">掛率</th></tr>`;
  $('#mlist-wrap').scrollTop = 0;
  appendMasterRows();
}
function appendMasterRows() {
  const slice = S.mFiltered.slice(S.mShown, S.mShown + PAGE_SIZE);
  $('#mtable').insertAdjacentHTML('beforeend', slice.map(p => `<tr data-id="${p.id}"><td>${esc(p.supplier)}</td><td>${esc(p.code)}</td><td>${esc(p.name)}${p.check ? ' <span class="badge b-warn">要確認</span>' : ''}${p.manual ? ' <span class="badge b-sup">手入力</span>' : ''}</td><td>${esc(p.jan)}</td><td class="num">${yen(p.jodai)}</td><td>${esc(p.unit)}</td><td class="num">${p.lot || ''}</td><td class="num">${p.rate ?? ''}</td></tr>`).join(''));
  S.mShown += slice.length;
  $('#mmore').textContent = S.mFiltered.length ? (S.mShown < S.mFiltered.length ? `${S.mShown} / ${S.mFiltered.length} 件表示中（下にスクロールで続き）` : `${S.mFiltered.length} 件`) : '該当なし';
}

/* ---------- CSV ---------- */
function parseCSV(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.some(x => x !== ''));
}
async function readFileText(file) {
  const buf = await file.arrayBuffer();
  let t = new TextDecoder('utf-8').decode(buf);
  if (t.includes('�')) { try { t = new TextDecoder('shift_jis').decode(buf); } catch (e) { } }
  return t.replace(/^﻿/, '');
}
const CSV_COLS = [['部門', 'dept'], ['仕入先', 'supplier'], ['メーカー', 'maker'], ['JAN', 'jan'], ['品番', 'code'], ['商品名', 'name'], ['単位', 'unit'], ['取り寄せ単位', 'lot'], ['上代', 'jodai'], ['下代', 'gedai'], ['掛率', 'rate'], ['状態', 'status'], ['要確認', 'check']];
function csvCell(v) { v = String(v ?? ''); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
function exportCSV() {
  const sup = $('#m-sup').value;
  const list = sup ? (S.bySup.get(sup) || []) : S.products;
  const lines = [CSV_COLS.map(c => c[0]).join(',')].concat(list.map(p => CSV_COLS.map(([, k]) => csvCell(p[k])).join(',')));
  shareOrDownload(new File(['\uFEFF' + lines.join('\r\n')], `商品マスタ_${sup || '全仕入先'}_${today()}.csv`, { type: 'text/csv' })).then(ok => { if (ok === null) toast('もう一度「CSV出力」を押してください'); }).catch(e => toast('出力できませんでした：' + e.message));
}
function downloadText(name, text, type) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
async function importCSV(file) {
  const rows = parseCSV(await readFileText(file));
  if (rows.length < 2) { toast('CSVにデータがありません'); return; }
  const head = rows[0].map(h => h.trim());
  const idx = {}; for (const [jp, k] of CSV_COLS) { const i = head.indexOf(jp); if (i >= 0) idx[k] = i; }
  if (idx.name == null) { toast('「商品名」の列が見つかりません'); return; }
  const hasSup = idx.supplier != null;
  modal(`<h3>CSV読込</h3><div>${rows.length - 1}行のデータがあります。</div>
    ${hasSup ? '<div style="margin-top:6px">CSVの「仕入先」列を使います。</div>' : `<div class="field" style="margin-top:8px"><label>取り込む仕入先</label><select id="ci-sup">${supplierOptions(S.supplier)}</select></div>`}
    <div style="margin-top:8px;font-size:13px;color:#5c6470">同じ仕入先の中で、JAN（なければ品番）が一致する商品は上書き、それ以外は追加します。<br>列：${head.map(esc).join('、')}</div>
    <div class="acts"><button data-x="0">キャンセル</button><button class="primary" data-x="1">取り込む</button></div>`, el => {
    $('[data-x="0"]', el).onclick = closeModal;
    $('[data-x="1"]', el).onclick = async () => {
      const fixedSup = hasSup ? null : $('#ci-sup', el).value;
      $('#modal-body').innerHTML = '<h3>取り込み中…</h3>';
      const res = await mergeRows(rows.slice(1), idx, fixedSup);
      modal(`<h3>取り込み完了</h3><div>追加 ${res.added}件／更新 ${res.updated}件／スキップ ${res.skipped}件</div>
        ${res.unknownSup.size ? `<div class="err" style="margin-top:6px">設定に無い仕入先：${[...res.unknownSup].map(esc).join('、')}（仕入先を設定に追加してください）</div>` : ''}
        ${res.cross.length ? `<div style="margin-top:8px">ほかの仕入先と同じJANの商品が${res.cross.length}件あります（バーコードを読むと候補から選ぶ形になります）：<div style="max-height:200px;overflow:auto;font-size:13px">${res.cross.slice(0, 200).map(c => esc(c)).join('<br>')}</div></div>` : ''}
        <div class="acts"><button class="primary" data-x="1">閉じる</button></div>`, e2 => $('[data-x="1"]', e2).onclick = () => { closeModal(); renderMasterSupSel(); filterMaster(); renderChips(); });
    };
  });
}
async function mergeRows(rows, idx, fixedSup) {
  const res = { added: 0, updated: 0, skipped: 0, cross: [], unknownSup: new Set() };
  const g = (r, k) => idx[k] != null ? String(r[idx[k]] ?? '').trim() : undefined;
  const work = new Map(); // key -> {np, old}
  const used = new Set();
  for (const r of rows) {
    const sup = fixedSup || g(r, 'supplier');
    const name = g(r, 'name');
    if (!sup || !name) { res.skipped++; continue; }
    if (!S.supMap.has(sup)) { res.unknownSup.add(sup); res.skipped++; continue; }
    const jan = normJan(g(r, 'jan') || ''); const code = g(r, 'code') || '';
    const key = sup + '\u0001' + jan + '\u0001' + (code || (jan ? '' : name));
    let w = work.get(key);
    if (!w) {
      const pool = S.bySup.get(sup) || [];
      let old = null;
      if (jan) { const c = pool.filter(x => x.jan === jan); old = c.length === 1 ? c[0] : (c.find(x => code && x.code === code) || null); }
      else if (code) old = pool.find(x => x.code === code && !x.jan) || pool.find(x => x.code === code) || null;
      else old = pool.find(x => x.name === name && !x.jan && !x.code) || null;
      if (old && used.has(old)) old = null;
      if (old) used.add(old);
      w = { old, np: old ? { ...old } : { supplier: sup, dept: S.supMap.get(sup).dept, maker: '', jan: '', code: '', unit: '個', lot: null, jodai: null, gedai: null, rate: null, status: '', check: '', manual: false } };
      work.set(key, w);
    }
    const np = w.np;
    np.name = name; if (jan) np.jan = jan; if (code) np.code = code;
    const set = (k, f) => { const v = g(r, k); if (v !== undefined && v !== '') np[k] = f ? f(v) : v; };
    set('maker'); set('unit', v => (v === 'ケ' || v === 'ヶ') ? '個' : v); set('status'); set('check');
    set('jodai', toNum); set('gedai', toNum); set('rate', toNum); set('lot', v => { const n = toNum(v); return n > 1 ? Math.round(n) : null; });
    np.updatedAt = Date.now();
  }
  const t = tx(['products'], 'readwrite'); const st = t.objectStore('products');
  const reqs = [];
  for (const w of work.values()) {
    const o = stripP(w.np); if (!w.old) delete o.id;
    reqs.push([st.put(o), w]);
    if (w.old) res.updated++; else res.added++;
  }
  await done(t);
  for (const [req, w] of reqs) {
    if (w.old) unindexProduct(w.old);
    w.np.id = req.result; S.products.push(w.np); indexProduct(w.np);
  }
  for (const [, w] of reqs) { const np = w.np; if (np.jan) { const o = (S.byJan.get(np.jan) || []).filter(x => x.supplier !== np.supplier); if (o.length) res.cross.push(`${np.jan}　${np.supplier}｜${np.name}　⇔　${o.map(x => x.supplier).join('・')}`); } }
  return res;
}

/* ---------- 設定 ---------- */
function renderSettings() {
  const sh = S.shop;
  $('#settings').innerHTML = `
  <div class="card"><h3>店舗情報（発注書に載ります）</h3><div class="grid2">
    ${[['name', '店名'], ['zip', '郵便番号'], ['address', '住所'], ['tel', '電話番号'], ['fax', 'FAX番号'], ['email', 'メールアドレス']].map(([k, l]) => `<div class="field"><label>${l}</label><input data-shop="${k}" value="${esc(sh[k] || '')}"></div>`).join('')}
    <div class="field" style="grid-column:1/-1"><label>通信欄（初期文）</label><textarea data-shop="commText">${esc(sh.commText || '')}</textarea></div></div>
    <div class="acts" style="display:flex;justify-content:flex-end;margin-top:10px"><button class="primary" id="s-shop-save">保存</button></div></div>
  <div class="card"><h3>担当者</h3>
    <table class="t">${S.staff.map((s, i) => `<tr><td>${esc(s.name)}${s.active === false ? ' <span class="badge b-sup">非表示</span>' : ''}</td><td style="text-align:right;white-space:nowrap">
      <button class="small" data-st="up" data-i="${i}">↑</button> <button class="small" data-st="down" data-i="${i}">↓</button>
      <button class="small" data-st="toggle" data-i="${i}">${s.active === false ? '表示する' : '非表示にする'}</button> <button class="small danger" data-st="del" data-i="${i}">削除</button></td></tr>`).join('') || '<tr><td class="chk">まだ登録されていません</td></tr>'}</table>
    <div style="display:flex;gap:8px;margin-top:10px"><input id="s-staff-new" placeholder="名前" style="flex:1"><button id="s-staff-add">追加</button></div>
    <div class="chk" style="margin-top:6px">辞めた人は「非表示」にすると、過去の履歴を残したまま選択肢から外れます。</div></div>
  <div class="card"><h3>仕入先</h3>
    <table class="t"><tr><th>仕入先</th><th>部門</th><th>FAX</th><th>メール</th><th>送料無料</th><th class="num">掛率</th><th></th></tr>
    ${S.suppliers.map(s => `<tr><td>${esc(s.name)}${s.active === false ? ' <span class="badge b-sup">非表示</span>' : ''}</td><td>${s.dept === DEPTS[0] ? '画材' : '額縁等'}</td><td>${esc(s.fax || '')}</td><td>${esc(s.email || '')}</td>
      <td>${s.freeLine ? esc(s.basis) + ' ¥' + yen(s.freeLine) : esc(s.basis || '')}</td><td class="num">${s.baseRate ?? esc(s.rateNote || '')}</td><td><button class="small" data-sup="${esc(s.name)}">編集</button></td></tr>`).join('')}</table>
    <div style="margin-top:10px"><button id="s-sup-add">＋仕入先を追加</button></div></div>
  <div class="card"><h3>ブランド別の掛率</h3>
    <table class="t"><tr><th>仕入先</th><th>メーカー（ブランド）</th><th class="num">掛率</th><th></th></tr>
    ${S.brandRates.map((b, i) => `<tr><td>${esc(b.supplier)}</td><td>${esc(b.maker)}</td><td class="num">${b.rate}</td><td><button class="small danger" data-br="${i}">削除</button></td></tr>`).join('')}</table>
    <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap"><select id="s-br-sup">${supplierOptions('丸善')}</select><input id="s-br-maker" placeholder="メーカー名（マスタのメーカー名と同じ）"><input id="s-br-rate" placeholder="掛率 0.6" inputmode="decimal" style="width:90px"><button id="s-br-add">追加</button></div>
    <div class="chk" style="margin-top:6px">下代の目安は「商品ごとの掛率 → ブランド別の掛率 → 仕入先の基本掛率」の順に使います。</div></div>
  <div class="card"><h3>バックアップ</h3>
    <div class="chk" style="margin-bottom:8px">データはこのiPadの中だけに保存されています。月に1回くらい、バックアップをファイルに保存しておくと安心です。前回から30日たつと、アプリを開いたときにお知らせします。</div>
    <button id="s-backup">バックアップを保存</button> <button id="s-restore">バックアップから戻す</button><input type="file" id="s-restore-file" accept=".json,application/json" hidden>
    <div class="chk" style="margin-top:6px" id="s-info"></div></div>
  <div class="card"><h3>初期化</h3><button class="danger" id="s-reset">すべてのデータを消して最初からやり直す</button>
    <div class="chk" style="margin-top:6px">アプリ ${APP_VERSION}</div></div>`;
  Promise.all([kvGet('masterVersion', ''), kvGet('lastBackup', null)]).then(([v, lb]) => { $('#s-info').textContent = `前回のバックアップ：${lb ? lb.slice(0, 10) : 'まだありません'}　／　商品 ${S.products.length.toLocaleString()}件・発注履歴 ${S.orders.length}件・初期マスタ ${v}`; });
}
function openSupplierForm(s) {
  const isNew = !s;
  s = { name: '', dept: S.dept, order: S.suppliers.length, baseRate: null, rateNote: '', freeLine: null, basis: '下代', cutoff: '', backorder: '', serviceDay: '', arrival: '', shippingNote: '', tel: '', fax: '', email: '', code: '', sendMethod: 'FAX', payment: '', memo: '', active: true, ...(s || {}) };
  const f = (k, l, extra = '') => `<div class="field"><label>${l}</label><input data-k="${k}" value="${esc(s[k] ?? '')}" ${extra}></div>`;
  modal(`<h3>${isNew ? '仕入先を追加' : '仕入先を編集　' + esc(s.name)}</h3><div class="grid2">
    ${isNew ? f('name', '仕入先名（必須）') : ''}
    <div class="field"><label>部門</label><select data-k="dept">${DEPTS.map(d => `<option ${d === s.dept ? 'selected' : ''}>${d}</option>`).join('')}</select></div>
    ${f('fax', 'FAX番号', 'inputmode="tel"')}${f('email', 'メールアドレス', 'inputmode="email"')}${f('code', '取引先コード')}${f('tel', '電話番号', 'inputmode="tel"')}
    ${f('baseRate', '基本掛率（例 0.6）', 'inputmode="decimal"')}
    <div class="field"><label>送料無料ラインの基準</label><select data-k="basis">${['上代', '下代', 'なし(必ず送料)', 'その他'].map(b => `<option ${b === s.basis ? 'selected' : ''}>${b}</option>`).join('')}</select></div>
    ${f('freeLine', '送料無料ライン（円）', 'inputmode="numeric"')}${f('cutoff', '当日発送の締切')}${f('arrival', '到着')}${f('backorder', '注残')}${f('serviceDay', 'サービスデイ')}
    <div class="field" style="grid-column:1/-1"><label>送料・注意</label><textarea data-k="shippingNote">${esc(s.shippingNote || '')}</textarea></div>
    ${f('memo', 'メモ')}
    <div class="field"><label>表示</label><select data-k="active"><option value="1" ${s.active !== false ? 'selected' : ''}>表示する</option><option value="0" ${s.active === false ? 'selected' : ''}>非表示にする</option></select></div>
  </div><div id="sf-err" class="err"></div>
  <div class="acts"><button id="sf-cancel">キャンセル</button><button class="primary" id="sf-save">保存</button></div>`, el => {
    $('#sf-cancel', el).onclick = closeModal;
    $('#sf-save', el).onclick = async () => {
      const n = { ...s };
      $$('[data-k]', el).forEach(i => { n[i.dataset.k] = i.value.trim(); });
      n.baseRate = toNum(n.baseRate); n.freeLine = toNum(n.freeLine); n.active = n.active !== '0';
      if (isNew) { if (!n.name) { $('#sf-err', el).textContent = '仕入先名を入れてください'; return; } if (S.supMap.has(n.name)) { $('#sf-err', el).textContent = '同じ名前の仕入先があります'; return; } }
      await put('suppliers', n);
      if (isNew) S.suppliers.push(n); else S.suppliers[S.suppliers.findIndex(x => x.name === n.name)] = n;
      S.supMap.set(n.name, n);
      closeModal(); renderSettings(); toast('保存しました');
    };
  });
}
const BACKUP_DAYS = 30;
async function buildBackupFile() {
  const data = { app: 'tobi-hacchu', version: APP_VERSION, at: new Date().toISOString() };
  for (const s of ['products', 'suppliers', 'kv', 'carts', 'orders']) data[s] = await getAll(s);
  return new File([JSON.stringify(data)], `東美発注_バックアップ_${today()}.json`, { type: 'application/json' });
}
// iPadでは共有画面（「ファイルに保存」など）、それ以外はダウンロード。成功したら true
async function shareOrDownload(file) {
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: file.name }); return true; }
    catch (e) { if (e.name === 'AbortError') return false; if (e.name !== 'NotAllowedError') throw e; return null; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  return true;
}
async function backupFlow(fromReminder) {
  modal('<h3>バックアップ</h3><div>バックアップを作っています…</div>');
  let file;
  try { file = await buildBackupFile(); } catch (e) { modal(`<h3>バックアップ</h3><div class="err">作成できませんでした：${esc(e.message || e)}</div><div class="acts"><button data-x="0">閉じる</button></div>`, el => $('[data-x="0"]', el).onclick = closeModal); return; }
  const mb = (file.size / 1024 / 1024).toFixed(1);
  modal(`<h3>バックアップ</h3>
    <div>バックアップファイルができました（${mb}MB）。</div>
    <div style="margin-top:8px;font-size:14px;color:#5c6470">「保存する」を押すと共有画面が開きます。「<b>ファイルに保存</b>」を選んで、iCloud Drive などに保存してください。</div>
    <div class="acts"><button data-x="0">${fromReminder ? 'あとで' : 'キャンセル'}</button><button class="primary" data-x="1">保存する</button></div>`, el => {
    $('[data-x="0"]', el).onclick = () => { closeModal(); if (fromReminder) snoozeBackup(); };
    $('[data-x="1"]', el).onclick = async () => {
      const ok = await shareOrDownload(file);
      if (ok) { await kvSet('lastBackup', new Date().toISOString()); await kvSet('backupSnooze', null); closeModal(); toast('バックアップを保存しました'); if (S.page === 'settings') renderSettings(); }
      else if (ok === null) toast('もう一度「保存する」を押してください');
    };
  });
}
async function snoozeBackup() { await kvSet('backupSnooze', new Date(Date.now() + 3 * 86400000).toISOString()); toast('3日後にもう一度お知らせします'); }
async function checkBackupReminder() {
  const last = await kvGet('lastBackup', null);
  const base = last || await kvGet('seeded', null);
  if (!base) return;
  const snooze = await kvGet('backupSnooze', null);
  if (snooze && new Date(snooze) > new Date()) return;
  const days = Math.floor((Date.now() - new Date(base)) / 86400000);
  if (days < BACKUP_DAYS) return;
  modal(`<h3>バックアップのお知らせ</h3>
    <div>${last ? `前回のバックアップから <b>${days}日</b> たちました。` : `使い始めてから <b>${days}日</b> たちましたが、まだバックアップがありません。`}</div>
    <div style="margin-top:8px;font-size:14px;color:#5c6470">データはこのiPadの中だけに保存されています。故障や削除に備えて、ファイルに保存しておきましょう。</div>
    <div class="acts"><button data-x="0">あとで（3日後）</button><button class="primary" data-x="1">今すぐバックアップ</button></div>`, el => {
    $('[data-x="0"]', el).onclick = () => { closeModal(); snoozeBackup(); };
    $('[data-x="1"]', el).onclick = () => backupFlow(true);
  });
}
async function restore(file) {
  let data; try { data = JSON.parse(await readFileText(file)); } catch (e) { toast('ファイルを読めませんでした'); return; }
  if (data.app !== 'tobi-hacchu') { toast('東美発注のバックアップファイルではありません'); return; }
  if (!(await confirmBox(`${data.at?.slice(0, 10)} のバックアップに戻します。今のデータは上書きされます。よろしいですか？`, '戻す'))) return;
  const stores = ['products', 'suppliers', 'kv', 'carts', 'orders'];
  const t = tx(stores, 'readwrite');
  for (const s of stores) { const st = t.objectStore(s); st.clear(); for (const v of data[s] || []) st.put(v); }
  await done(t); location.reload();
}

/* ---------- UI結線 ---------- */
function bindUI() {
  $('#pages').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    S.page = b.dataset.p;
    $$('#pages button').forEach(x => x.classList.toggle('on', x === b));
    $$('.page').forEach(p => p.classList.toggle('on', p.id === 'p-' + S.page));
    if (S.page === 'order') { renderChips(); renderSupInfo(); filterOrderList(); renderFooter(); renderStaffSelect(); }
    if (S.page === 'history') renderHistory();
    if (S.page === 'master') { renderMasterSupSel(); filterMaster(); }
    if (S.page === 'settings') renderSettings();
  };
  $('#dept').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    S.dept = b.dataset.d; kvSet('lastDept', S.dept); renderDept();
    kvGet('lastSup:' + S.dept, null).then(selectSupplier);
    if (S.page !== 'order') $('#pages button[data-p="order"]').click();
  };
  $('#supchips').onclick = e => { const b = e.target.closest('.chip'); if (b) { $('#q').value = ''; selectSupplier(b.dataset.s); } };
  const fo = debounce(filterOrderList, 200);
  $('#q').addEventListener('input', fo);
  $('#q').addEventListener('keydown', e => {
    if (e.key === 'Enter') { const v = $('#q').value.trim(); if (/^\d{8,14}$/.test(v)) { e.preventDefault(); $('#q').value = ''; handleScan(v, false); filterOrderList(); } }
  });
  $('#q-all').onchange = filterOrderList; $('#q-cart').onchange = filterOrderList;
  $('#btn-scan').onclick = openScanner;
  $('#btn-newprod').onclick = () => openProductForm({ supplier: S.supplier }, true);
  const ow = $('#olist-wrap');
  ow.addEventListener('scroll', () => { if (ow.scrollTop + ow.clientHeight > ow.scrollHeight - 400 && S.oShown < S.oFiltered.length) appendOrderRows(); });
  $('#olist').addEventListener('click', e => {
    const b = e.target.closest('button[data-a]'); if (!b) { const nm = e.target.closest('.nm'); if (nm && e.detail === 2) { } return; }
    const p = S.byId.get(+b.closest('.row').dataset.id);
    const it = cartOf(p.supplier).get(p.id); const q = it?.qty || 0; const step = p.lot > 1 ? p.lot : 1;
    if (b.dataset.a === 'plus') setQty(p, q + step);
    if (b.dataset.a === 'minus') setQty(p, q - step < 0 ? 0 : (q % step ? q - (q % step) : q - step));
  });
  $('#olist').addEventListener('change', e => {
    const i = e.target; const row = i.closest('.row'); if (!row) return;
    const p = S.byId.get(+row.dataset.id);
    if (i.dataset.a === 'qty') setQty(p, toNum(i.value) || 0);
    if (i.dataset.a === 'note') { const c = cartOf(p.supplier); const it = c.get(p.id); if (it) { it.note = i.value; saveCart(p.supplier); } }
  });
  $('#olist').addEventListener('dblclick', e => { const row = e.target.closest('.row'); if (row && e.target.closest('.nm')) openProductForm(S.byId.get(+row.dataset.id)); });
  $('#staff-sel').onchange = () => sessionStorage.setItem('staff', $('#staff-sel').value);
  $('#btn-draft').onclick = async () => { const c = cartOf(S.supplier); await put('carts', { supplier: S.supplier, items: [...c].map(([pid, v]) => ({ pid, ...v })), comm: S.cartComm.get(S.supplier) || '', updatedAt: Date.now() }); toast('下書きを保存しました（このiPadに残ります）'); };
  $('#btn-clear').onclick = async () => { if (!cartTotals(S.supplier).lines) return; if (await confirmBox(`${S.supplier} の数量をすべて0に戻しますか？`, 'クリア')) { S.carts.set(S.supplier, new Map()); S.cartComm.delete(S.supplier); await del('carts', S.supplier); renderCommBtn(); filterOrderList(); renderFooter(); renderFreeShip(); renderChips(); } };
  $('#btn-preview').onclick = () => { const lines = cartLines(S.supplier); if (!lines.length) { toast('数量が入っている商品がありません'); return; } openPrintView({ supplier: S.supplier, items: lines, staff: $('#staff-sel').value, comm: commFor(S.supplier), date: today() }); };
  $('#btn-confirm').onclick = confirmOrder;
  $('#btn-comm').onclick = openCommEditor;
  $('#pv-close').onclick = () => $('#printview').classList.remove('on');
  $('#pv-print').onclick = () => USE_PDF ? sharePDF() : window.print();
  window.addEventListener('resize', () => { if ($('#printview').classList.contains('on')) fitSheets(); });
  $('#modal').addEventListener('click', e => { if (e.target.id === 'modal' && !scanCtl) closeModal(); });
  // 履歴
  ['#h-sup', '#h-staff', '#h-month'].forEach(s => $(s).onchange = renderHistory);
  $('#hlist').onclick = async e => {
    const b = e.target.closest('button[data-a]'); if (!b) return;
    const o = S.orders.find(x => x.id === +b.closest('tr').dataset.id);
    if (b.dataset.a === 'view') openPrintView(o);
    if (b.dataset.a === 're') {
      let miss = 0; for (const l of o.items) { const p = S.byId.get(l.pid); if (!p) { miss++; continue; } const c = cartOf(p.supplier); const it = c.get(p.id) || { qty: 0, note: '' }; it.qty += l.qty; c.set(p.id, it); }
      saveCart(o.supplier); const s = S.supMap.get(o.supplier); if (s) { S.dept = s.dept; renderDept(); }
      $('#pages button[data-p="order"]').click(); selectSupplier(o.supplier);
      toast(`${o.no} の内容を発注中に追加しました${miss ? `（${miss}件はマスタに無いため追加できませんでした）` : ''}`, 3500);
    }
    if (b.dataset.a === 'del') { if (await confirmBox(`${o.no} の履歴を削除しますか？`, '削除')) { await del('orders', o.id); S.orders = S.orders.filter(x => x !== o); renderHistory(); } }
  };
  // マスタ
  $('#m-sup').onchange = filterMaster; $('#m-check').onchange = filterMaster;
  $('#m-q').addEventListener('input', debounce(filterMaster, 200));
  const mw = $('#mlist-wrap');
  mw.addEventListener('scroll', () => { if (mw.scrollTop + mw.clientHeight > mw.scrollHeight - 400 && S.mShown < S.mFiltered.length) appendMasterRows(); });
  $('#mtable').onclick = e => { const tr = e.target.closest('tr[data-id]'); if (tr) openProductForm(S.byId.get(+tr.dataset.id)); };
  $('#m-add').onclick = () => openProductForm({ supplier: $('#m-sup').value || S.supplier });
  $('#m-export').onclick = exportCSV;
  $('#m-import').onclick = () => $('#m-file').click();
  $('#m-file').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) importCSV(f); };
  // 設定
  $('#settings').addEventListener('click', async e => {
    const t = e.target;
    if (t.id === 's-shop-save') { $$('[data-shop]').forEach(i => S.shop[i.dataset.shop] = i.value.trim()); await kvSet('shop', S.shop); toast('保存しました'); }
    if (t.id === 's-staff-add') { const n = $('#s-staff-new').value.trim(); if (!n) return; if (S.staff.some(s => s.name === n)) { toast('同じ名前がいます'); return; } S.staff.push({ name: n, active: true }); await kvSet('staff', S.staff); renderSettings(); renderStaffSelect(); }
    if (t.dataset.st) {
      const i = +t.dataset.i; const a = S.staff;
      if (t.dataset.st === 'up' && i > 0) [a[i - 1], a[i]] = [a[i], a[i - 1]];
      if (t.dataset.st === 'down' && i < a.length - 1) [a[i + 1], a[i]] = [a[i], a[i + 1]];
      if (t.dataset.st === 'toggle') a[i].active = a[i].active === false;
      if (t.dataset.st === 'del') { if (!(await confirmBox(`${a[i].name} を削除しますか？（過去の履歴の名前は残ります）`, '削除'))) return; a.splice(i, 1); }
      await kvSet('staff', a); renderSettings(); renderStaffSelect();
    }
    if (t.dataset.sup) openSupplierForm(S.supMap.get(t.dataset.sup));
    if (t.id === 's-sup-add') openSupplierForm(null);
    if (t.dataset.br != null) { S.brandRates.splice(+t.dataset.br, 1); await kvSet('brandRates', S.brandRates); renderSettings(); }
    if (t.id === 's-br-add') { const r = toNum($('#s-br-rate').value); const mk = $('#s-br-maker').value.trim(); if (!mk || !r) { toast('メーカー名と掛率を入れてください'); return; } S.brandRates.push({ supplier: $('#s-br-sup').value, maker: mk, rate: r }); await kvSet('brandRates', S.brandRates); renderSettings(); }
    if (t.id === 's-backup') backupFlow(false);
    if (t.id === 's-restore') $('#s-restore-file').click();
    if (t.id === 's-reset') { if (await confirmBox('商品マスタ・発注履歴・設定をすべて消して、最初の状態に戻します。元に戻せません。よろしいですか？', 'すべて消す')) { db.close(); indexedDB.deleteDatabase(DB_NAME); setTimeout(() => location.reload(), 500); } }
  });
  $('#settings').addEventListener('change', e => { if (e.target.id === 's-restore-file') { const f = e.target.files[0]; e.target.value = ''; if (f) restore(f); } });
}

boot().catch(e => { console.error(e); $('#loading-msg').innerHTML = `<span class="err">起動できませんでした：${esc(e.message || e)}</span>`; });
