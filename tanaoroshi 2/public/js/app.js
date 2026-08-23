// ============================================================
// 棚卸しシステム フロントエンド (スマホ最優先SPA)
// ============================================================
const APP = document.getElementById('app');
const TOAST = document.getElementById('toast');

// ---- ユーティリティ ----
function showToast(msg, ms = 1600) {
  TOAST.textContent = msg;
  TOAST.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => TOAST.classList.remove('show'), ms);
}

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* no body */ }
  if (!res.ok) {
    const err = new Error((data && (data.message || data.error)) || res.statusText);
    err.data = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

function getOperator() { return localStorage.getItem('operator_name') || ''; }
function setOperator(name) { localStorage.setItem('operator_name', name || ''); }
function getSettingsCache() {
  try { return JSON.parse(localStorage.getItem('settings_cache') || '{}'); } catch (e) { return {}; }
}
function setSettingsCache(obj) { localStorage.setItem('settings_cache', JSON.stringify(obj)); }

function fmtMoney(n) { return '¥' + Math.round(n || 0).toLocaleString(); }
function fmtNum(n) { return (Math.round((n || 0) * 100) / 100).toLocaleString(); }
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- ルーター ----
const routes = {};
function route(pattern, handler) { routes[pattern] = handler; }

function parseHash() {
  const hash = location.hash.replace(/^#/, '') || '/';
  const parts = hash.split('/').filter(Boolean);
  return parts;
}

async function render() {
  const parts = parseHash();
  window.scrollTo(0, 0);
  try {
    if (parts.length === 0) return screenTop();
    switch (parts[0]) {
      case 'scan': return screenScan();
      case 'list': return screenList();
      case 'search': return screenSearch();
      case 'results': return parts[1] ? screenResultDetail(parts[1]) : screenResultsIndex();
      case 'history': return screenResultsIndex();
      case 'master':
        if (parts[1] === 'new') return screenMasterForm();
        if (parts[1] === 'edit') return screenMasterForm(parts[2]);
        if (parts[1] === 'import') return screenMasterImport();
        return screenMasterList();
      case 'settings': return screenSettings();
      case 'dashboard': return screenDashboard();
      default: return screenTop();
    }
  } catch (e) {
    console.error(e);
    APP.innerHTML = layout('エラー', `<div class="error-box">画面の表示に失敗しました: ${escapeHtml(e.message)}</div>`, true);
  }
}
window.addEventListener('hashchange', render);
window.addEventListener('DOMContentLoaded', render);

function goto(hash) { location.hash = hash; }

// ---- 共通レイアウト ----
function layout(title, bodyHtml, showBack = false, subtitle = '') {
  return `
    <div class="header">
      ${showBack ? `<div class="back" onclick="history.back()">‹</div>` : ''}
      <div>
        <h1>${escapeHtml(title)}</h1>
        ${subtitle ? `<div class="sub">${escapeHtml(subtitle)}</div>` : ''}
      </div>
    </div>
    <div class="content">${bodyHtml}</div>
  `;
}

async function sessionBannerHtml() {
  let s = null;
  try { s = await api('/sessions/current'); } catch (e) { /* ignore */ }
  if (!s) {
    return `<div class="session-banner none">棚卸しは開始されていません <a href="#/settings" class="link-btn">開始する</a></div>`;
  }
  const tag = s.status === 'in_progress' ? '進行中' : '一時保存中';
  return `<div class="session-banner"><span>${escapeHtml(s.title)}（${s.item_count}件 / ${fmtMoney(s.amount)}）</span><span class="status-tag">${tag}</span></div>`;
}

// ============================================================
// トップメニュー
// ============================================================
async function screenTop() {
  APP.innerHTML = layout('棚卸しシステム', `<div class="empty">読み込み中...</div>`);
  const banner = await sessionBannerHtml();
  APP.innerHTML = layout('棚卸しシステム', `
    ${banner}
    <div class="menu-grid">
      <button class="menu-btn primary" onclick="goto('#/scan')"><span class="icon">📷</span><span>バーコード読取</span></button>
      <div class="menu-row">
        <button class="menu-btn" onclick="goto('#/list')"><span class="icon">📋</span><span>棚卸一覧</span></button>
        <button class="menu-btn" onclick="goto('#/search')"><span class="icon">🔍</span><span>商品検索</span></button>
      </div>
      <div class="menu-row">
        <button class="menu-btn" onclick="goto('#/results')"><span class="icon">📊</span><span>棚卸結果</span></button>
        <button class="menu-btn" onclick="goto('#/master')"><span class="icon">📦</span><span>商品マスター</span></button>
      </div>
      <div class="menu-row">
        <button class="menu-btn" onclick="goto('#/settings')"><span class="icon">⚙</span><span>設定</span></button>
        <button class="menu-btn" onclick="goto('#/dashboard')"><span class="icon">📈</span><span>ダッシュボード</span></button>
      </div>
    </div>
  `);
}

// ============================================================
// バーコード読取画面（連続読取フロー）
// ============================================================
let qrScanner = null;
let scanState = { session: null, product: null, currentItem: null, scanning: false };

async function screenScan() {
  const session = await api('/sessions/current');
  if (!session) {
    APP.innerHTML = layout('バーコード読取', `
      <div class="warn-box">棚卸しが開始されていません。まず棚卸しを開始してください。</div>
      <div class="card">
        <div class="field"><label>棚卸しタイトル（空欄可）</label><input id="newTitle" placeholder="例: 2026年8月棚卸"></div>
        <button class="btn btn-primary" id="startBtn">棚卸しを開始する</button>
      </div>
    `, true);
    document.getElementById('startBtn').onclick = async () => {
      try {
        await api('/sessions', { method: 'POST', body: { title: document.getElementById('newTitle').value, created_by: getOperator() } });
        showToast('棚卸しを開始しました');
        render();
      } catch (e) { showToast(e.message); }
    };
    return;
  }
  scanState.session = session;
  APP.innerHTML = layout('バーコード読取', session.title, true, `${session.item_count}件 登録済み`);
  renderScanBody();
}

function renderScanBody() {
  const content = document.querySelector('.content');
  content.innerHTML = `
    <div id="scanArea">
      <div id="reader"></div>
      <div class="manual-input">
        <input id="manualJan" inputmode="numeric" placeholder="バーコードを手入力（カメラが使えない場合）">
        <button class="btn btn-outline btn-sm" id="manualBtn">検索</button>
      </div>
      <div class="info-box" style="margin-top:10px;">商品にカメラを向けてください。うまく読み取れない場合は下の欄に直接入力できます。</div>
    </div>
    <div id="resultArea"></div>
  `;
  document.getElementById('manualBtn').onclick = () => {
    const v = document.getElementById('manualJan').value.trim();
    if (v) handleBarcode(v);
  };
  document.getElementById('manualJan').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); document.getElementById('manualBtn').click(); }
  });
  startCamera();
}

function startCamera() {
  if (typeof Html5Qrcode === 'undefined') return;
  const readerEl = document.getElementById('reader');
  if (!readerEl) return;
  qrScanner = new Html5Qrcode('reader');
  const config = {
    fps: 10,
    qrbox: { width: 260, height: 140 },
    formatsToSupport: window.Html5QrcodeSupportedFormats ? [
      Html5QrcodeSupportedFormats.EAN_13, Html5QrcodeSupportedFormats.EAN_8,
      Html5QrcodeSupportedFormats.UPC_A, Html5QrcodeSupportedFormats.UPC_E,
      Html5QrcodeSupportedFormats.CODE_128, Html5QrcodeSupportedFormats.QR_CODE
    ] : undefined
  };
  qrScanner.start({ facingMode: 'environment' }, config,
    (decodedText) => { handleBarcode(decodedText); },
    () => {} // 読み取り失敗は無視(連続スキャン中の通常挙動)
  ).then(() => { scanState.scanning = true; }).catch((err) => {
    document.getElementById('scanArea').insertAdjacentHTML('beforeend',
      `<div class="warn-box">カメラを起動できませんでした。手入力欄をご利用ください。（${escapeHtml(String(err))}）</div>`);
  });
}

async function stopCamera() {
  if (qrScanner && scanState.scanning) {
    try { await qrScanner.stop(); qrScanner.clear(); } catch (e) { /* ignore */ }
    scanState.scanning = false;
  }
}

async function handleBarcode(jan) {
  await stopCamera();
  const resultArea = document.getElementById('resultArea');
  resultArea.innerHTML = `<div class="empty">検索中...</div>`;
  try {
    const data = await api(`/products/lookup?jan=${encodeURIComponent(jan)}&session_id=${scanState.session.id}`);
    scanState.product = data.product;
    scanState.currentItem = data.currentItem;
    renderProductCard(data.product, data.currentItem);
  } catch (e) {
    if (e.status === 404) {
      resultArea.innerHTML = `
        <div class="error-box">「${escapeHtml(jan)}」<br>商品マスターに登録されていません。</div>
        <div class="btn-group">
          <button class="btn btn-outline" id="rescanBtn">再読取</button>
          <button class="btn btn-accent" id="regNewBtn">この場で商品登録</button>
        </div>`;
      document.getElementById('rescanBtn').onclick = () => renderScanBody();
      document.getElementById('regNewBtn').onclick = () => { location.hash = '#/master/new'; sessionStorage.setItem('prefillJan', jan); };
    } else {
      resultArea.innerHTML = `<div class="error-box">${escapeHtml(e.message)}</div>
        <button class="btn btn-outline" id="rescanBtn">再読取</button>`;
      document.getElementById('rescanBtn').onclick = () => renderScanBody();
    }
  }
}

function renderProductCard(product, currentItem) {
  const resultArea = document.getElementById('resultArea');
  const targetWarn = product.is_inventory_target === 0
    ? `<div class="warn-box">⚠ この商品は「棚卸対象外」に設定されています。</div>` : '';
  resultArea.innerHTML = `
    <div class="card product-card">
      ${targetWarn}
      <div class="title">${escapeHtml(product.name)}</div>
      <div class="meta">商品コード: ${escapeHtml(product.product_code)} / 規格: ${escapeHtml(product.spec || '-')}</div>
      <div class="meta">部門: ${escapeHtml(product.department_name || '未設定')} / 単位: ${escapeHtml(product.unit)}</div>
      <div class="stat-row">
        <div class="stat-box"><div class="num">${fmtNum(product.stock_qty)}</div><div class="lbl">登録在庫数</div></div>
        <div class="stat-box"><div class="num">${fmtNum(currentItem ? currentItem.quantity : 0)}</div><div class="lbl">棚卸実数(現在)</div></div>
      </div>
    </div>
    <div class="card">
      <h2>棚卸数量を入力</h2>
      ${currentItem ? `<div class="info-box">この商品は既に ${fmtNum(currentItem.quantity)}${escapeHtml(product.unit)} 登録済みです。設定「${getSettingsCache().duplicate_mode === 'overwrite' ? '上書き' : '加算'}」に従って処理されます。</div>` : ''}
      <div class="field">
        <label>棚卸数量（今回読み取り分）</label>
        <div class="qty-input-wrap">
          <button class="qty-btn" id="qtyMinus" type="button">−</button>
          <input id="qtyInput" type="number" inputmode="decimal" min="0" step="1" value="1">
          <button class="qty-btn" id="qtyPlus" type="button">＋</button>
        </div>
      </div>
      <div class="field"><label>単位</label><input value="${escapeHtml(product.unit)}" disabled></div>
      <div class="field"><label>棚・保管場所</label><input id="locInput" value="${escapeHtml((currentItem && currentItem.location) || product.location || '')}"></div>
      <div class="field"><label>備考</label><textarea id="noteInput">${escapeHtml((currentItem && currentItem.note) || '')}</textarea></div>
      <div id="regMsg"></div>
      <div class="btn-group">
        <button class="btn btn-outline" id="cancelBtn">キャンセル</button>
        <button class="btn btn-primary" id="registerBtn">登録</button>
      </div>
    </div>
  `;
  document.getElementById('qtyMinus').onclick = () => bump(-1);
  document.getElementById('qtyPlus').onclick = () => bump(1);
  function bump(d) {
    const el = document.getElementById('qtyInput');
    const v = Math.max(0, (Number(el.value) || 0) + d);
    el.value = v;
  }
  document.getElementById('cancelBtn').onclick = () => renderScanBody();
  document.getElementById('registerBtn').onclick = () => doRegister({});
}

async function doRegister(extra) {
  const qtyVal = document.getElementById('qtyInput').value;
  const msgBox = document.getElementById('regMsg');
  msgBox.innerHTML = '';
  const quantity = Number(qtyVal);
  if (qtyVal === '' || Number.isNaN(quantity)) { msgBox.innerHTML = `<div class="error-box">数量は数字で入力してください</div>`; return; }
  if (quantity < 0) { msgBox.innerHTML = `<div class="error-box">数量にマイナスは入力できません</div>`; return; }

  const body = {
    jan_code: scanState.product.jan_code,
    quantity,
    location: document.getElementById('locInput').value,
    note: document.getElementById('noteInput').value,
    operator: getOperator(),
    ...extra
  };
  try {
    const res = await api(`/sessions/${scanState.session.id}/items`, { method: 'POST', body });
    showToast(`登録しました（${res.previousQty}→${res.item.quantity}${res.product.unit}）`);
    setTimeout(() => renderScanBody(), 500);
  } catch (e) {
    if (e.status === 409 && e.data && e.data.error === 'NON_TARGET_WARNING') {
      msgBox.innerHTML = `<div class="warn-box">${escapeHtml(e.data.message)}</div>
        <button class="btn btn-accent" id="forceRegBtn">対象外だが登録する</button>`;
      document.getElementById('forceRegBtn').onclick = () => doRegister({ ...extra, confirm_non_target: true });
    } else if (e.status === 409 && e.data && e.data.error === 'ANOMALY_WARNING') {
      msgBox.innerHTML = `<div class="warn-box">${escapeHtml(e.data.message)}</div>
        <button class="btn btn-accent" id="forceAnomalyBtn">この数量で登録する</button>`;
      document.getElementById('forceAnomalyBtn').onclick = () => doRegister({ ...extra, confirm_anomaly: true });
    } else {
      msgBox.innerHTML = `<div class="error-box">${escapeHtml(e.message)}</div>`;
    }
  }
}

// ============================================================
// 棚卸一覧
// ============================================================
async function screenList() {
  const session = await api('/sessions/current') || await latestSessionAny();
  APP.innerHTML = layout('棚卸一覧', session ? session.title : '棚卸しデータなし', true);
  const content = document.querySelector('.content');
  if (!session) { content.innerHTML = `<div class="empty">棚卸しデータがありません</div>`; return; }
  content.innerHTML = `
    <div class="search-bar">
      <input id="q" placeholder="商品名・バーコードで検索">
      <button class="btn btn-outline btn-sm" id="searchBtn">検索</button>
    </div>
    <div id="itemsList"><div class="empty">読み込み中...</div></div>
  `;
  const load = async () => {
    const q = document.getElementById('q').value.trim();
    const items = await api(`/sessions/${session.id}/items${q ? '?q=' + encodeURIComponent(q) : ''}`);
    const listEl = document.getElementById('itemsList');
    if (items.length === 0) { listEl.innerHTML = `<div class="empty">該当する明細がありません</div>`; return; }
    listEl.innerHTML = items.map(i => `
      <div class="list-item">
        <div class="top"><span class="name">${escapeHtml(i.product_name)}</span><span class="qty">${fmtNum(i.quantity)}${escapeHtml(i.unit || '')}</span></div>
        <div class="meta">JAN: ${escapeHtml(i.jan_code || '-')} / 部門: ${escapeHtml(i.department_name || '-')} / 場所: ${escapeHtml(i.location || '-')}</div>
        <div class="meta">最終更新: ${escapeHtml(i.updated_at)}</div>
        ${session.status !== 'finalized' ? `
        <div class="btn-group" style="margin-top:8px;">
          <button class="btn btn-outline btn-sm" onclick="editItemPrompt(${session.id}, ${i.id}, ${i.quantity}, '${escapeHtml(i.location || '').replace(/'/g, "\\'")}')">編集</button>
          <button class="btn btn-danger btn-sm" onclick="deleteItem(${session.id}, ${i.id})">削除</button>
        </div>` : ''}
      </div>
    `).join('');
  };
  document.getElementById('searchBtn').onclick = load;
  document.getElementById('q').addEventListener('input', () => { clearTimeout(window._listDeb); window._listDeb = setTimeout(load, 250); });
  load();
}

async function latestSessionAny() {
  const list = await api('/sessions');
  return list[0] || null;
}

window.editItemPrompt = async (sessionId, itemId, currentQty, currentLoc) => {
  const q = prompt('新しい棚卸数量を入力してください', currentQty);
  if (q === null) return;
  const qty = Number(q);
  if (Number.isNaN(qty) || qty < 0) { alert('正しい数量を入力してください'); return; }
  try {
    await api(`/sessions/${sessionId}/items/${itemId}`, { method: 'PUT', body: { quantity: qty, operator: getOperator() } });
    showToast('更新しました');
    render();
  } catch (e) { alert(e.message); }
};
window.deleteItem = async (sessionId, itemId) => {
  if (!confirm('この明細を削除しますか？')) return;
  try {
    await api(`/sessions/${sessionId}/items/${itemId}?operator=${encodeURIComponent(getOperator())}`, { method: 'DELETE' });
    showToast('削除しました');
    render();
  } catch (e) { alert(e.message); }
};

// ============================================================
// 商品検索
// ============================================================
async function screenSearch() {
  APP.innerHTML = layout('商品検索', '商品マスターを検索', true);
  const content = document.querySelector('.content');
  const depts = await api('/departments');
  content.innerHTML = `
    <div class="search-bar">
      <input id="q" placeholder="商品名・JAN・商品コード">
      <select id="dept" style="width:110px;"><option value="">全部門</option>${depts.map(d => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join('')}</select>
    </div>
    <div id="results"><div class="empty">検索キーワードを入力してください</div></div>
  `;
  const load = async () => {
    const q = document.getElementById('q').value.trim();
    const dept = document.getElementById('dept').value;
    if (!q && !dept) { document.getElementById('results').innerHTML = `<div class="empty">検索キーワードを入力してください</div>`; return; }
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (dept) params.set('department_id', dept);
    const rows = await api('/products?' + params.toString());
    const el = document.getElementById('results');
    if (rows.length === 0) { el.innerHTML = `<div class="empty">該当する商品がありません</div>`; return; }
    el.innerHTML = rows.map(p => `
      <div class="list-item">
        <div class="top"><span class="name">${escapeHtml(p.name)}</span><span class="qty">在庫 ${fmtNum(p.stock_qty)}${escapeHtml(p.unit)}</span></div>
        <div class="meta">コード:${escapeHtml(p.product_code)} / JAN:${escapeHtml(p.jan_code || '-')} / 部門:${escapeHtml(p.department_name || '-')}</div>
        <div class="meta">仕入:${fmtMoney(p.cost_price)} / 売価:${fmtMoney(p.sell_price)} / 場所:${escapeHtml(p.location || '-')} ${p.is_inventory_target ? '' : '<span class="highlight">(棚卸対象外)</span>'}</div>
        <button class="btn btn-outline btn-sm" style="margin-top:6px;" onclick="location.hash='#/master/edit/${p.id}'">編集</button>
      </div>
    `).join('');
  };
  document.getElementById('q').addEventListener('input', () => { clearTimeout(window._searchDeb); window._searchDeb = setTimeout(load, 250); });
  document.getElementById('dept').addEventListener('change', load);
}

// ============================================================
// 棚卸結果 / 履歴一覧
// ============================================================
async function screenResultsIndex() {
  APP.innerHTML = layout('棚卸結果・履歴', '過去の棚卸し一覧', true);
  const content = document.querySelector('.content');
  const sessions = await api('/sessions');
  if (sessions.length === 0) { content.innerHTML = `<div class="empty">棚卸しデータがありません</div>`; return; }
  content.innerHTML = sessions.map(s => `
    <div class="list-item" onclick="location.hash='#/results/${s.id}'" style="cursor:pointer;">
      <div class="top"><span class="name">${escapeHtml(s.title)}</span><span class="badge ${s.status === 'finalized' ? 'done' : (s.status === 'temp_saved' ? 'saved' : 'progress')}">${s.status === 'finalized' ? '確定済' : (s.status === 'temp_saved' ? '一時保存' : '進行中')}</span></div>
      <div class="meta">対象日: ${escapeHtml(s.target_date || '-')} / 商品点数: ${s.item_count}点 / 金額: ${fmtMoney(s.amount)}</div>
      ${s.diff ? `<div class="meta">前回比: ${s.diff.amount_diff >= 0 ? '+' : ''}${fmtMoney(s.diff.amount_diff)}</div>` : ''}
      ${s.revision_count > 0 ? `<div class="meta highlight">修正履歴あり(${s.revision_count}件)</div>` : ''}
    </div>
  `).join('');
}

async function screenResultDetail(id) {
  APP.innerHTML = layout('棚卸結果', '読み込み中...', true);
  const data = await api(`/sessions/${id}/results`);
  const s = data.session;
  const content = document.querySelector('.content');
  content.innerHTML = `
    <div class="card">
      <h2>${escapeHtml(s.title)} <span class="badge ${s.status === 'finalized' ? 'done' : (s.status === 'temp_saved' ? 'saved' : 'progress')}">${s.status === 'finalized' ? '確定済' : (s.status === 'temp_saved' ? '一時保存' : '進行中')}</span></h2>
      <div class="stat-row">
        <div class="stat-box"><div class="num">${fmtMoney(data.totalAmount)}</div><div class="lbl">棚卸金額合計</div></div>
        <div class="stat-box"><div class="num">${data.itemCount}</div><div class="lbl">商品点数</div></div>
      </div>
      ${data.hasPrevious ? `
      <div class="stat-row">
        <div class="stat-box"><div class="num">${fmtMoney(data.totalPrevAmount)}</div><div class="lbl">前回棚卸金額</div></div>
        <div class="stat-box"><div class="num" style="color:${data.totalDiffAmount >= 0 ? 'var(--primary-dark)' : 'var(--danger)'}">${data.totalDiffAmount >= 0 ? '+' : ''}${fmtMoney(data.totalDiffAmount)}</div><div class="lbl">増減金額</div></div>
      </div>` : `<div class="info-box">比較対象となる前回の確定棚卸しがありません</div>`}
      <div class="btn-group" style="margin-top:10px;">
        <a class="btn btn-outline" href="/api/sessions/${id}/export.csv" target="_blank">CSV出力</a>
        <a class="btn btn-outline" href="/api/sessions/${id}/export.xlsx" target="_blank">Excel出力</a>
      </div>
    </div>

    <div class="card">
      <h2>部門別集計</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>部門</th><th>商品点数</th><th>金額</th></tr></thead>
        <tbody>${data.departmentTotals.map(d => `<tr><td>${escapeHtml(d.department)}</td><td>${d.item_count}</td><td>${fmtMoney(d.amount)}</td></tr>`).join('')}</tbody>
      </table></div>
    </div>

    <div class="card">
      <h2>商品別明細（前回比較）</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>商品名</th><th>部門</th><th>数量</th><th>金額</th><th>前回数量</th><th>増減</th></tr></thead>
        <tbody>${data.productResults.map(r => `
          <tr class="${r.highlight ? 'highlight' : ''}">
            <td>${escapeHtml(r.name)}</td>
            <td>${escapeHtml(r.department_name || '-')}</td>
            <td>${fmtNum(r.quantity)}${escapeHtml(r.unit || '')}</td>
            <td>${fmtMoney(r.amount)}</td>
            <td>${r.prevQty != null ? fmtNum(r.prevQty) : '-'}</td>
            <td>${r.diffQty != null ? (r.diffQty >= 0 ? '+' : '') + fmtNum(r.diffQty) : '-'}${r.highlight ? ' ⚠' : ''}</td>
          </tr>`).join('')}</tbody>
      </table></div>
    </div>

    <div class="card">
      <h2>棚卸しの操作</h2>
      ${s.status !== 'finalized' ? `
        <div class="btn-group">
          ${s.status === 'in_progress' ? `<button class="btn btn-outline" id="saveBtn">一時保存</button>` : `<button class="btn btn-outline" id="resumeBtn">作業再開</button>`}
          <button class="btn btn-primary" id="finalizeBtn">棚卸し確定</button>
        </div>
      ` : `<div class="info-box">この棚卸しは確定済みです。修正が必要な場合は明細を選び「棚卸し修正」を行ってください（履歴が残ります）。</div>
        <div id="reviseArea">${data.productResults.map(r => `
          <div class="list-item">
            <div class="top"><span class="name">${escapeHtml(r.name)}</span><span class="qty">${fmtNum(r.quantity)}${escapeHtml(r.unit || '')}</span></div>
            <button class="btn btn-outline btn-sm" style="margin-top:6px;" onclick="reviseItem(${id}, ${r.item_id}, ${r.quantity})">棚卸し修正</button>
          </div>`).join('')}
        </div>`}
    </div>
  `;
  if (s.status !== 'finalized') {
    const saveBtn = document.getElementById('saveBtn');
    if (saveBtn) saveBtn.onclick = async () => { await api(`/sessions/${id}/save`, { method: 'POST', body: { operator: getOperator() } }); showToast('一時保存しました'); render(); };
    const resumeBtn = document.getElementById('resumeBtn');
    if (resumeBtn) resumeBtn.onclick = async () => { await api(`/sessions/${id}/resume`, { method: 'POST', body: { operator: getOperator() } }); showToast('作業を再開しました'); render(); };
    document.getElementById('finalizeBtn').onclick = async () => {
      if (!confirm('棚卸しを確定します。確定後は原則データを直接変更できません。よろしいですか？')) return;
      try { await api(`/sessions/${id}/finalize`, { method: 'POST', body: { operator: getOperator() } }); showToast('棚卸しを確定しました'); render(); }
      catch (e) { alert(e.message); }
    };
  }
}

window.reviseItem = async (sessionId, itemId, currentQty) => {
  const q = prompt('修正後の棚卸数量を入力してください', currentQty);
  if (q === null) return;
  const qty = Number(q);
  if (Number.isNaN(qty) || qty < 0) { alert('正しい数量を入力してください'); return; }
  const reason = prompt('修正理由を入力してください（必須）');
  if (!reason) { alert('修正理由の入力が必要です'); return; }
  try {
    await api(`/sessions/${sessionId}/items/${itemId}/revise`, { method: 'POST', body: { new_quantity: qty, reason, operator: getOperator() } });
    showToast('棚卸し修正を記録しました');
    render();
  } catch (e) { alert(e.message); }
};

// ============================================================
// 商品マスター
// ============================================================
async function screenMasterList() {
  APP.innerHTML = layout('商品マスター', '商品の登録・編集', true);
  const content = document.querySelector('.content');
  content.innerHTML = `
    <div class="btn-group" style="margin-bottom:12px;">
      <button class="btn btn-primary" onclick="location.hash='#/master/new'">＋ 新規登録</button>
      <button class="btn btn-outline" onclick="location.hash='#/master/import'">一括登録</button>
    </div>
    <div class="search-bar"><input id="q" placeholder="商品名・JAN・商品コードで検索"></div>
    <div id="results"><div class="empty">読み込み中...</div></div>
  `;
  const load = async () => {
    const q = document.getElementById('q').value.trim();
    const rows = await api('/products' + (q ? '?q=' + encodeURIComponent(q) : ''));
    const el = document.getElementById('results');
    if (rows.length === 0) { el.innerHTML = `<div class="empty">商品がありません</div>`; return; }
    el.innerHTML = rows.map(p => `
      <div class="list-item" style="cursor:pointer;" onclick="location.hash='#/master/edit/${p.id}'">
        <div class="top"><span class="name">${escapeHtml(p.name)}</span><span class="qty">${fmtMoney(p.cost_price)}</span></div>
        <div class="meta">コード:${escapeHtml(p.product_code)} / JAN:${escapeHtml(p.jan_code || '-')} / 部門:${escapeHtml(p.department_name || '-')} ${p.is_inventory_target ? '' : '<span class="highlight">対象外</span>'}</div>
      </div>
    `).join('');
  };
  document.getElementById('q').addEventListener('input', () => { clearTimeout(window._masterDeb); window._masterDeb = setTimeout(load, 250); });
  load();
}

async function screenMasterForm(id) {
  const depts = await api('/departments');
  let p = { product_code: '', jan_code: sessionStorage.getItem('prefillJan') || '', name: '', spec: '', department_id: '', unit: '個', cost_price: 0, sell_price: 0, location: '', is_inventory_target: 1, note: '', stock_qty: 0 };
  if (id) p = await api(`/products/${id}`);
  sessionStorage.removeItem('prefillJan');
  APP.innerHTML = layout(id ? '商品編集' : '商品新規登録', p.name || '', true);
  const content = document.querySelector('.content');
  content.innerHTML = `
    <div class="card">
      <div class="row2">
        <div class="field"><label>商品コード*</label><input id="f_code" value="${escapeHtml(p.product_code)}"></div>
        <div class="field"><label>JANコード</label><input id="f_jan" value="${escapeHtml(p.jan_code || '')}"></div>
      </div>
      <div class="field"><label>商品名*</label><input id="f_name" value="${escapeHtml(p.name)}"></div>
      <div class="row2">
        <div class="field"><label>規格・容量</label><input id="f_spec" value="${escapeHtml(p.spec || '')}"></div>
        <div class="field"><label>単位</label><input id="f_unit" value="${escapeHtml(p.unit || '個')}"></div>
      </div>
      <div class="field"><label>部門</label>
        <select id="f_dept">${depts.map(d => `<option value="${d.id}" ${d.id === p.department_id ? 'selected' : ''}>${escapeHtml(d.name)}</option>`).join('')}</select>
      </div>
      <div class="row2">
        <div class="field"><label>仕入単価</label><input id="f_cost" type="number" min="0" value="${p.cost_price}"></div>
        <div class="field"><label>売価</label><input id="f_sell" type="number" min="0" value="${p.sell_price}"></div>
      </div>
      <div class="row2">
        <div class="field"><label>保管場所</label><input id="f_loc" value="${escapeHtml(p.location || '')}"></div>
        <div class="field"><label>登録在庫数</label><input id="f_stock" type="number" min="0" value="${p.stock_qty}"></div>
      </div>
      <div class="field"><label><input type="checkbox" id="f_target" ${p.is_inventory_target ? 'checked' : ''} style="width:auto;"> 棚卸対象にする</label></div>
      <div class="field"><label>備考</label><textarea id="f_note">${escapeHtml(p.note || '')}</textarea></div>
      <div id="formMsg"></div>
      <div class="btn-group">
        ${id ? `<button class="btn btn-danger" id="delBtn">削除</button>` : '<div></div>'}
        <button class="btn btn-primary" id="saveBtn">保存</button>
      </div>
    </div>
  `;
  document.getElementById('saveBtn').onclick = async () => {
    const body = {
      product_code: document.getElementById('f_code').value.trim(),
      jan_code: document.getElementById('f_jan').value.trim(),
      name: document.getElementById('f_name').value.trim(),
      spec: document.getElementById('f_spec').value.trim(),
      unit: document.getElementById('f_unit').value.trim() || '個',
      department_id: Number(document.getElementById('f_dept').value),
      cost_price: Number(document.getElementById('f_cost').value) || 0,
      sell_price: Number(document.getElementById('f_sell').value) || 0,
      location: document.getElementById('f_loc').value.trim(),
      stock_qty: Number(document.getElementById('f_stock').value) || 0,
      is_inventory_target: document.getElementById('f_target').checked,
      note: document.getElementById('f_note').value.trim(),
      operator: getOperator()
    };
    if (!body.product_code || !body.name) { document.getElementById('formMsg').innerHTML = `<div class="error-box">商品コードと商品名は必須です</div>`; return; }
    try {
      if (id) await api(`/products/${id}`, { method: 'PUT', body });
      else await api('/products', { method: 'POST', body });
      showToast('保存しました');
      location.hash = '#/master';
    } catch (e) { document.getElementById('formMsg').innerHTML = `<div class="error-box">${escapeHtml(e.message)}</div>`; }
  };
  if (id) {
    document.getElementById('delBtn').onclick = async () => {
      if (!confirm('この商品を削除しますか？')) return;
      await api(`/products/${id}?operator=${encodeURIComponent(getOperator())}`, { method: 'DELETE' });
      showToast('削除しました');
      location.hash = '#/master';
    };
  }
}

async function screenMasterImport() {
  APP.innerHTML = layout('商品一括登録', 'CSV / Excelファイルから登録', true);
  const content = document.querySelector('.content');
  content.innerHTML = `
    <div class="card">
      <div class="info-box">列: 商品コード, JANコード, 商品名, 規格, 部門, 単位, 仕入単価, 売価, 保管場所, 棚卸対象(対象/対象外), 備考, 登録在庫数<br>
      <a href="/api/products/template.csv" class="link-btn">テンプレートCSVをダウンロード</a></div>
      <div class="field"><input type="file" id="fileInput" accept=".csv,.xlsx,.xls"></div>
      <button class="btn btn-primary" id="uploadBtn">取り込む</button>
      <div id="importResult"></div>
    </div>
  `;
  document.getElementById('uploadBtn').onclick = async () => {
    const fileEl = document.getElementById('fileInput');
    if (!fileEl.files.length) { showToast('ファイルを選択してください'); return; }
    const fd = new FormData();
    fd.append('file', fileEl.files[0]);
    fd.append('operator', getOperator());
    const res = await fetch('/api/products/import', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) { document.getElementById('importResult').innerHTML = `<div class="error-box">${escapeHtml(data.error || '取込に失敗しました')}</div>`; return; }
    document.getElementById('importResult').innerHTML = `
      <div class="info-box">成功: ${data.success}件 / エラー: ${data.errorCount}件（全${data.total}件中）</div>
      ${data.errors.length ? `<div class="error-box">${data.errors.map(e => `${e.row}行目: ${escapeHtml(e.error)}`).join('<br>')}</div>` : ''}
    `;
    showToast('取込が完了しました');
  };
}

// ============================================================
// 設定
// ============================================================
async function screenSettings() {
  const settings = await api('/settings');
  setSettingsCache(settings);
  const sessions = await api('/sessions');
  const current = sessions.find(s => s.status !== 'finalized');
  APP.innerHTML = layout('設定', '', true);
  const content = document.querySelector('.content');
  content.innerHTML = `
    <div class="card">
      <h2>作業者名</h2>
      <div class="field"><input id="opName" value="${escapeHtml(getOperator())}" placeholder="例: 山田"></div>
      <button class="btn btn-outline btn-sm" id="opSaveBtn">保存</button>
    </div>

    <div class="card">
      <h2>重複読取時の処理（既定）</h2>
      <div class="field">
        <select id="dupMode">
          <option value="add" ${settings.duplicate_mode === 'add' ? 'selected' : ''}>前回数量に加算する</option>
          <option value="overwrite" ${settings.duplicate_mode === 'overwrite' ? 'selected' : ''}>前回数量を上書きする</option>
        </select>
      </div>
      <div class="field"><label>異常値警告の倍率（登録在庫数の何倍で警告するか）</label>
        <input id="warnMult" type="number" min="1" value="${settings.qty_warning_multiplier}"></div>
      <button class="btn btn-primary" id="settingsSaveBtn">設定を保存</button>
    </div>

    <div class="card">
      <h2>棚卸しの進行管理</h2>
      ${current ? `
        <div class="info-box">現在: ${escapeHtml(current.title)}（${current.status === 'in_progress' ? '進行中' : '一時保存中'}）</div>
        <div class="btn-group">
          <button class="btn btn-outline" onclick="location.hash='#/results/${current.id}'">この棚卸しを開く</button>
        </div>
      ` : `
        <div class="field"><label>新しい棚卸しタイトル</label><input id="newTitle" placeholder="例: 2026年9月棚卸"></div>
        <button class="btn btn-primary" id="startBtn">棚卸しを開始</button>
      `}
    </div>

    <div class="card">
      <h2>操作履歴</h2>
      <div id="logs"><div class="empty">読み込み中...</div></div>
    </div>
  `;
  document.getElementById('opSaveBtn').onclick = () => { setOperator(document.getElementById('opName').value); showToast('保存しました'); };
  document.getElementById('settingsSaveBtn').onclick = async () => {
    await api('/settings', { method: 'PUT', body: { duplicate_mode: document.getElementById('dupMode').value, qty_warning_multiplier: document.getElementById('warnMult').value, operator: getOperator() } });
    showToast('設定を保存しました');
    render();
  };
  const startBtn = document.getElementById('startBtn');
  if (startBtn) startBtn.onclick = async () => {
    try {
      const r = await api('/sessions', { method: 'POST', body: { title: document.getElementById('newTitle').value, created_by: getOperator() } });
      showToast('棚卸しを開始しました');
      location.hash = `#/results/${r.id}`;
    } catch (e) { alert(e.message); }
  };
  const logs = await api('/logs');
  document.getElementById('logs').innerHTML = logs.length ? logs.slice(0, 30).map(l => `
    <div class="meta" style="padding:4px 0;border-bottom:1px solid var(--border);">${escapeHtml(l.created_at)} ${escapeHtml(l.user || '')} - ${escapeHtml(l.action)} ${escapeHtml(l.target || '')} ${escapeHtml(l.detail || '')}</div>
  `).join('') : `<div class="empty">履歴なし</div>`;
}

// ============================================================
// ダッシュボード
// ============================================================
async function screenDashboard() {
  APP.innerHTML = layout('ダッシュボード', '棚卸し進捗状況', true);
  const content = document.querySelector('.content');
  const session = await api('/sessions/current') || await latestSessionAny();
  if (!session) { content.innerHTML = `<div class="empty">棚卸しデータがありません</div>`; return; }
  const data = await api(`/sessions/${session.id}/dashboard`);
  const pct = Math.round(data.progressRate * 100);
  content.innerHTML = `
    <div class="card">
      <h2>${escapeHtml(data.session.title)}</h2>
      <div class="progress-bar"><div class="fill" style="width:${pct}%;"></div></div>
      <div class="meta" style="margin-top:6px;">進捗率 ${pct}%（棚卸済み ${data.countedCount} / 対象 ${data.targetCount}）</div>
      <div class="stat-row">
        <div class="stat-box"><div class="num">${data.countedCount}</div><div class="lbl">棚卸済み商品数</div></div>
        <div class="stat-box"><div class="num">${data.notCountedCount}</div><div class="lbl">未棚卸商品数</div></div>
      </div>
      <div class="stat-row">
        <div class="stat-box"><div class="num">${fmtMoney(data.currentAmount)}</div><div class="lbl">現在の棚卸金額</div></div>
        <div class="stat-box"><div class="num" style="color:${data.diffAmount == null ? 'inherit' : (data.diffAmount >= 0 ? 'var(--primary-dark)' : 'var(--danger)')}">${data.diffAmount == null ? '-' : ((data.diffAmount >= 0 ? '+' : '') + fmtMoney(data.diffAmount))}</div><div class="lbl">前回との差額</div></div>
      </div>
    </div>
    <div class="card">
      <h2>部門別棚卸金額</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>部門</th><th>点数</th><th>金額</th></tr></thead>
        <tbody>${data.departmentAmounts.map(d => `<tr><td>${escapeHtml(d.department || '未設定')}</td><td>${d.item_count}</td><td>${fmtMoney(d.amount)}</td></tr>`).join('')}</tbody>
      </table></div>
    </div>
    <div class="card">
      <h2>未棚卸商品一覧（${data.notCountedList.length}件）</h2>
      ${data.notCountedList.length === 0 ? `<div class="info-box">すべての対象商品を棚卸しました！</div>` :
        data.notCountedList.map(p => `
        <div class="list-item">
          <div class="top"><span class="name">${escapeHtml(p.name)}</span></div>
          <div class="meta">コード:${escapeHtml(p.product_code)} / JAN:${escapeHtml(p.jan_code || '-')} / 部門:${escapeHtml(p.department_name || '-')} / 場所:${escapeHtml(p.location || '-')}</div>
        </div>`).join('')}
    </div>
  `;
}
