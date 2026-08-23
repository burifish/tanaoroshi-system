const express = require('express');
const db = require('../db');
const { logOperation } = require('../logger');

const router = express.Router();

async function getSetting(key, fallback) {
  const row = await db.get('SELECT value FROM settings WHERE key=?', [key]);
  return row ? row.value : fallback;
}

async function sessionSummary(session) {
  const totals = await db.get(`
    SELECT COALESCE(SUM(i.quantity * p.cost_price),0) AS amount,
           COUNT(*) AS item_count,
           COALESCE(SUM(i.quantity),0) AS qty_total
    FROM inventory_items i JOIN products p ON p.id = i.product_id
    WHERE i.session_id = ?`, [session.id]);
  return {
    ...session,
    amount: Number(totals.amount),
    item_count: Number(totals.item_count),
    qty_total: Number(totals.qty_total)
  };
}

// ---- セッション一覧(履歴) ----
router.get('/sessions', async (req, res) => {
  try {
    const sessions = await db.all('SELECT * FROM inventory_sessions ORDER BY started_at DESC, id DESC');
    const enriched = [];
    for (const s of sessions) {
      const summary = await sessionSummary(s);
      let diff = null;
      if (s.based_on_session_id) {
        const prevSession = await db.get('SELECT * FROM inventory_sessions WHERE id=?', [s.based_on_session_id]);
        if (prevSession) {
          const prev = await sessionSummary(prevSession);
          diff = { amount_diff: summary.amount - prev.amount, item_diff: summary.item_count - prev.item_count };
        }
      }
      enriched.push({ ...summary, diff });
    }
    res.json(enriched);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 現在進行中(未確定)のセッションを取得（アプリのトップ/読取画面で使用）
router.get('/sessions/current', async (req, res) => {
  try {
    const s = await db.get(`SELECT * FROM inventory_sessions WHERE status IN ('in_progress','temp_saved') ORDER BY started_at DESC LIMIT 1`);
    if (!s) return res.json(null);
    res.json(await sessionSummary(s));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- 棚卸し開始 ----
router.post('/sessions', async (req, res) => {
  try {
    const { title, target_date, created_by, note } = req.body;
    const active = await db.get(`SELECT id FROM inventory_sessions WHERE status IN ('in_progress','temp_saved')`);
    if (active) {
      return res.status(409).json({ error: '既に進行中の棚卸しがあります。先にその棚卸しを確定または一時保存してください。', activeSessionId: active.id });
    }
    const baseline = await db.get(`SELECT id FROM inventory_sessions WHERE status='finalized' ORDER BY finalized_at DESC LIMIT 1`);
    const finalTitle = title && title.trim() ? title.trim() : `${new Date().getFullYear()}年${new Date().getMonth() + 1}月棚卸`;
    const info = await db.run(`
      INSERT INTO inventory_sessions (title, status, target_date, created_by, note, based_on_session_id)
      VALUES (?, 'in_progress', ?, ?, ?, ?) RETURNING id
    `, [finalTitle, target_date || new Date().toISOString().slice(0, 10), created_by || '', note || '', baseline ? baseline.id : null]);
    logOperation(created_by, '棚卸し開始', finalTitle, '');
    res.json({ id: info.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/sessions/:id', async (req, res) => {
  try {
    const s = await db.get('SELECT * FROM inventory_sessions WHERE id=?', [req.params.id]);
    if (!s) return res.status(404).json({ error: 'セッションが見つかりません' });
    res.json(await sessionSummary(s));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- 一時保存 ----
router.post('/sessions/:id/save', async (req, res) => {
  try {
    const s = await db.get('SELECT * FROM inventory_sessions WHERE id=?', [req.params.id]);
    if (!s) return res.status(404).json({ error: 'セッションが見つかりません' });
    if (s.status === 'finalized') return res.status(400).json({ error: '確定済みの棚卸しは一時保存できません' });
    await db.run(`UPDATE inventory_sessions SET status='temp_saved', saved_at=NOW() WHERE id=?`, [s.id]);
    logOperation(req.body.operator, '一時保存', s.title, '');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 作業再開（一時保存 -> 進行中）
router.post('/sessions/:id/resume', async (req, res) => {
  try {
    const s = await db.get('SELECT * FROM inventory_sessions WHERE id=?', [req.params.id]);
    if (!s) return res.status(404).json({ error: 'セッションが見つかりません' });
    if (s.status !== 'temp_saved') return res.status(400).json({ error: '一時保存中の棚卸しのみ再開できます' });
    await db.run(`UPDATE inventory_sessions SET status='in_progress' WHERE id=?`, [s.id]);
    logOperation(req.body.operator, '棚卸し再開', s.title, '');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- 確定 ----
router.post('/sessions/:id/finalize', async (req, res) => {
  try {
    const s = await db.get('SELECT * FROM inventory_sessions WHERE id=?', [req.params.id]);
    if (!s) return res.status(404).json({ error: 'セッションが見つかりません' });
    if (s.status === 'finalized') return res.status(400).json({ error: '既に確定済みです' });
    const countRow = await db.get('SELECT COUNT(*) c FROM inventory_items WHERE session_id=?', [s.id]);
    const itemCount = Number(countRow.c);
    if (itemCount === 0) return res.status(400).json({ error: '棚卸データが1件もありません。確定できません。' });
    await db.run(`UPDATE inventory_sessions SET status='finalized', finalized_at=NOW() WHERE id=?`, [s.id]);
    logOperation(req.body.operator, '棚卸し確定', s.title, `${itemCount}件`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- 設定 ----
router.get('/settings', async (req, res) => {
  try {
    const rows = await db.all('SELECT * FROM settings');
    const obj = {};
    rows.forEach(r => obj[r.key] = r.value);
    res.json(obj);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/settings', async (req, res) => {
  try {
    const { operator, ...settingFields } = req.body || {};
    for (const [k, v] of Object.entries(settingFields)) {
      await db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [k, String(v)]);
    }
    logOperation(operator, '設定変更', '', JSON.stringify(settingFields));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/logs', async (req, res) => {
  try {
    const rows = await db.all('SELECT * FROM operation_logs ORDER BY id DESC LIMIT 200');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ 棚卸明細(アイテム) ============

router.get('/sessions/:id/items', async (req, res) => {
  try {
    const { q } = req.query;
    let sql = `
      SELECT i.*, p.name AS product_name, p.product_code, p.spec, p.unit AS master_unit,
             p.department_id, d.name AS department_name, p.cost_price, p.sell_price, p.stock_qty
      FROM inventory_items i
      JOIN products p ON p.id = i.product_id
      LEFT JOIN departments d ON d.id = p.department_id
      WHERE i.session_id = ?`;
    const params = [req.params.id];
    if (q) {
      sql += ` AND (p.name ILIKE ? OR i.jan_code ILIKE ?)`;
      params.push(`%${q}%`, `%${q}%`);
    }
    sql += ' ORDER BY i.updated_at DESC';
    const rows = await db.all(sql, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// バーコード登録（読取→数量登録の中心API）
router.post('/sessions/:id/items', async (req, res) => {
  try {
    const sessionId = Number(req.params.id);
    const session = await db.get('SELECT * FROM inventory_sessions WHERE id=?', [sessionId]);
    if (!session) return res.status(404).json({ error: 'セッションが見つかりません' });
    if (session.status === 'finalized') {
      return res.status(400).json({ error: 'この棚卸しは確定済みです。修正する場合は「棚卸し修正」を行ってください。' });
    }

    const { jan_code, location, note, operator } = req.body;
    let { quantity, mode, confirm_non_target, confirm_anomaly, cost_price } = req.body;

    if (!jan_code) return res.status(400).json({ error: 'バーコードが必要です' });

    // ---- 誤入力防止: 数値チェック ----
    quantity = Number(quantity);
    if (quantity === '' || quantity === null || Number.isNaN(quantity)) {
      return res.status(400).json({ error: 'INVALID_NUMBER', message: '数量は数字で入力してください' });
    }
    if (quantity < 0) {
      return res.status(400).json({ error: 'NEGATIVE_NOT_ALLOWED', message: '数量にマイナスは入力できません' });
    }

    // ---- 原価(仕入単価)はバーコード読取画面からその場で入力・更新できる(任意項目) ----
    let updateCostPrice = false;
    if (cost_price !== undefined && cost_price !== null && cost_price !== '') {
      cost_price = Number(cost_price);
      if (Number.isNaN(cost_price) || cost_price < 0) {
        return res.status(400).json({ error: 'INVALID_COST_PRICE', message: '原価は0以上の数字で入力してください' });
      }
      updateCostPrice = true;
    }

    const product = await db.get('SELECT * FROM products WHERE jan_code = ?', [String(jan_code).trim()]);
    if (!product) {
      return res.status(404).json({ error: 'NOT_FOUND', message: '商品マスターに登録されていません' });
    }

    if (product.is_inventory_target === 0 && confirm_non_target !== true && confirm_non_target !== 'true') {
      return res.status(409).json({
        error: 'NON_TARGET_WARNING',
        message: 'この商品は棚卸対象外に設定されています。登録しますか？',
        product
      });
    }

    const effectiveMode = mode || await getSetting('duplicate_mode', 'add');
    const existing = await db.get('SELECT * FROM inventory_items WHERE session_id=? AND product_id=?', [sessionId, product.id]);
    const previousQty = existing ? Number(existing.quantity) : 0;
    const resultQty = existing && effectiveMode === 'add' ? previousQty + quantity : quantity;

    // ---- 異常値チェック(登録在庫数の指定倍率を超える場合、確認を要求) ----
    const multiplier = Number(await getSetting('qty_warning_multiplier', '5')) || 5;
    const threshold = Math.max(Number(product.stock_qty) * multiplier, 20); // 在庫0でも極端に多い数量は警告
    if (resultQty > threshold && confirm_anomaly !== true && confirm_anomaly !== 'true') {
      return res.status(409).json({
        error: 'ANOMALY_WARNING',
        message: `登録在庫数(${product.stock_qty}${product.unit})に対して数量が非常に多いです(${resultQty}${product.unit})。よろしいですか？`,
        resultQty
      });
    }

    await db.withTransaction(async (tx) => {
      if (existing) {
        await tx.run(`
          UPDATE inventory_items SET quantity=?, unit=?, location=COALESCE(?, location), note=COALESCE(?, note),
          jan_code=?, updated_at=NOW(), updated_by=? WHERE id=?
        `, [resultQty, product.unit, location, note, product.jan_code, operator || '', existing.id]);
      } else {
        await tx.run(`
          INSERT INTO inventory_items (session_id, product_id, jan_code, quantity, unit, location, note, updated_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [sessionId, product.id, product.jan_code, resultQty, product.unit, location || product.location, note || '', operator || '']);
      }
      await tx.run(`
        INSERT INTO inventory_scan_logs (session_id, item_id, product_id, jan_code, qty_entered, mode, result_qty, operator)
        VALUES (?, (SELECT id FROM inventory_items WHERE session_id=? AND product_id=?), ?, ?, ?, ?, ?, ?)
      `, [sessionId, sessionId, product.id, product.id, product.jan_code, quantity, effectiveMode, resultQty, operator || '']);

      if (updateCostPrice && Number(product.cost_price) !== cost_price) {
        await tx.run(`UPDATE products SET cost_price=?, updated_at=NOW() WHERE id=?`, [cost_price, product.id]);
      }
    });

    logOperation(operator, '棚卸登録', product.name, `${effectiveMode === 'add' ? '加算' : '上書き'} ${previousQty}->${resultQty}${product.unit}`);
    if (updateCostPrice && Number(product.cost_price) !== cost_price) {
      logOperation(operator, '原価更新(読取画面)', product.name, `${product.cost_price}->${cost_price}`);
      product.cost_price = cost_price;
    }

    const item = await db.get('SELECT * FROM inventory_items WHERE session_id=? AND product_id=?', [sessionId, product.id]);
    res.json({ item, product, previousQty, mode: effectiveMode, duplicate: !!existing });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 明細の手動編集(未確定時のみ)
router.put('/sessions/:id/items/:itemId', async (req, res) => {
  try {
    const session = await db.get('SELECT * FROM inventory_sessions WHERE id=?', [req.params.id]);
    if (!session) return res.status(404).json({ error: 'セッションが見つかりません' });
    if (session.status === 'finalized') return res.status(400).json({ error: '確定済みのため編集できません。棚卸し修正を利用してください。' });
    const item = await db.get('SELECT * FROM inventory_items WHERE id=? AND session_id=?', [req.params.itemId, req.params.id]);
    if (!item) return res.status(404).json({ error: '明細が見つかりません' });

    let { quantity, location, note, operator } = req.body;
    if (quantity !== undefined) {
      quantity = Number(quantity);
      if (Number.isNaN(quantity)) return res.status(400).json({ error: '数量は数字で入力してください' });
      if (quantity < 0) return res.status(400).json({ error: '数量にマイナスは入力できません' });
    }
    await db.run(`
      UPDATE inventory_items SET
        quantity = COALESCE(?, quantity),
        location = COALESCE(?, location),
        note = COALESCE(?, note),
        updated_at = NOW(),
        updated_by = ?
      WHERE id = ?
    `, [quantity ?? null, location ?? null, note ?? null, operator || '', item.id]);
    logOperation(operator, '明細手動編集', item.jan_code, `qty:${item.quantity}->${quantity ?? item.quantity}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/sessions/:id/items/:itemId', async (req, res) => {
  try {
    const session = await db.get('SELECT * FROM inventory_sessions WHERE id=?', [req.params.id]);
    if (!session) return res.status(404).json({ error: 'セッションが見つかりません' });
    if (session.status === 'finalized') return res.status(400).json({ error: '確定済みのため削除できません' });
    const item = await db.get('SELECT * FROM inventory_items WHERE id=? AND session_id=?', [req.params.itemId, req.params.id]);
    if (!item) return res.status(404).json({ error: '明細が見つかりません' });
    await db.run('DELETE FROM inventory_items WHERE id=?', [item.id]);
    logOperation(req.query.operator, '明細削除', item.jan_code, '');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 棚卸し修正（確定後の訂正、履歴を残す）
router.post('/sessions/:id/items/:itemId/revise', async (req, res) => {
  try {
    const session = await db.get('SELECT * FROM inventory_sessions WHERE id=?', [req.params.id]);
    if (!session) return res.status(404).json({ error: 'セッションが見つかりません' });
    if (session.status !== 'finalized') {
      return res.status(400).json({ error: '確定済みの棚卸しのみ「棚卸し修正」が可能です。未確定の場合は通常の編集を利用してください。' });
    }
    const item = await db.get('SELECT * FROM inventory_items WHERE id=? AND session_id=?', [req.params.itemId, req.params.id]);
    if (!item) return res.status(404).json({ error: '明細が見つかりません' });

    const { new_quantity, reason, operator } = req.body;
    const newQty = Number(new_quantity);
    if (Number.isNaN(newQty) || newQty < 0) return res.status(400).json({ error: '正しい数量を入力してください' });
    if (!reason || !reason.trim()) return res.status(400).json({ error: '修正理由の入力が必要です' });

    await db.withTransaction(async (tx) => {
      await tx.run(`
        INSERT INTO inventory_item_revisions (item_id, session_id, old_quantity, new_quantity, reason, operator)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [item.id, session.id, item.quantity, newQty, reason.trim(), operator || '']);
      await tx.run(`UPDATE inventory_items SET quantity=?, updated_at=NOW(), updated_by=? WHERE id=?`,
        [newQty, operator || '', item.id]);
      await tx.run(`UPDATE inventory_sessions SET revision_count = revision_count + 1 WHERE id=?`, [session.id]);
    });
    logOperation(operator, '棚卸し修正', item.jan_code, `${item.quantity}->${newQty} 理由:${reason}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/sessions/:id/items/:itemId/revisions', async (req, res) => {
  try {
    const rows = await db.all('SELECT * FROM inventory_item_revisions WHERE item_id=? ORDER BY id DESC', [req.params.itemId]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ 集計・比較 ============

async function buildComparisonMap(prevSessionId) {
  if (!prevSessionId) return new Map();
  const rows = await db.all(`SELECT product_id, quantity FROM inventory_items WHERE session_id = ?`, [prevSessionId]);
  const map = new Map();
  rows.forEach(r => map.set(r.product_id, Number(r.quantity)));
  return map;
}

router.get('/sessions/:id/results', async (req, res) => {
  try {
    const session = await db.get('SELECT * FROM inventory_sessions WHERE id=?', [req.params.id]);
    if (!session) return res.status(404).json({ error: 'セッションが見つかりません' });

    const items = await db.all(`
      SELECT i.*, p.product_code, p.jan_code AS product_jan, p.name AS product_name, p.spec, p.unit AS master_unit,
             p.cost_price, p.sell_price, p.department_id, d.name AS department_name, d.sort_order
      FROM inventory_items i
      JOIN products p ON p.id = i.product_id
      LEFT JOIN departments d ON d.id = p.department_id
      WHERE i.session_id = ?
      ORDER BY d.sort_order, p.product_code
    `, [session.id]);

    const prevMap = await buildComparisonMap(session.based_on_session_id);
    const DIFF_HIGHLIGHT_RATIO = 0.3; // 前回比±30%以上、または増減数量が大きい場合に強調

    const productResults = items.map(i => {
      const qty = Number(i.quantity);
      const cost = Number(i.cost_price);
      const amount = qty * cost;
      const prevQty = prevMap.has(i.product_id) ? prevMap.get(i.product_id) : null;
      const prevAmount = prevQty != null ? prevQty * cost : null;
      const diffQty = prevQty != null ? qty - prevQty : null;
      const diffAmount = prevAmount != null ? amount - prevAmount : null;
      let highlight = false;
      if (prevQty != null) {
        if (prevQty === 0 && qty > 0) highlight = true;
        else if (prevQty > 0 && Math.abs(diffQty) / prevQty >= DIFF_HIGHLIGHT_RATIO) highlight = true;
      }
      return {
        item_id: i.id, product_id: i.product_id, product_code: i.product_code, jan_code: i.jan_code || i.product_jan,
        name: i.product_name, spec: i.spec, department_name: i.department_name, unit: i.master_unit,
        cost_price: cost, quantity: qty, amount, location: i.location, note: i.note,
        updated_at: i.updated_at, prevQty, prevAmount, diffQty, diffAmount, highlight
      };
    });

    const departmentTotals = {};
    productResults.forEach(r => {
      const key = r.department_name || '未設定';
      if (!departmentTotals[key]) departmentTotals[key] = { department: key, amount: 0, item_count: 0, qty: 0 };
      departmentTotals[key].amount += r.amount;
      departmentTotals[key].item_count += 1;
      departmentTotals[key].qty += r.quantity;
    });

    const totalAmount = productResults.reduce((s, r) => s + r.amount, 0);
    const totalPrevAmount = productResults.reduce((s, r) => s + (r.prevAmount || 0), 0);
    const itemCount = productResults.length;

    res.json({
      session,
      productResults,
      departmentTotals: Object.values(departmentTotals),
      totalAmount,
      totalPrevAmount,
      totalDiffAmount: totalAmount - totalPrevAmount,
      itemCount,
      hasPrevious: !!session.based_on_session_id
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/sessions/:id/dashboard', async (req, res) => {
  try {
    const session = await db.get('SELECT * FROM inventory_sessions WHERE id=?', [req.params.id]);
    if (!session) return res.status(404).json({ error: 'セッションが見つかりません' });

    const targetProducts = await db.all(`
      SELECT p.*, d.name AS department_name FROM products p
      LEFT JOIN departments d ON d.id = p.department_id
      WHERE p.is_inventory_target = 1
    `);

    const countedRows = await db.all('SELECT product_id, quantity FROM inventory_items WHERE session_id=?', [session.id]);
    const countedIds = new Set(countedRows.map(r => r.product_id));

    const notCounted = targetProducts.filter(p => !countedIds.has(p.id));

    const amountRow = await db.get(`
      SELECT COALESCE(SUM(i.quantity * p.cost_price),0) AS amount
      FROM inventory_items i JOIN products p ON p.id=i.product_id WHERE i.session_id=?
    `, [session.id]);

    const deptAmounts = await db.all(`
      SELECT d.name AS department, COALESCE(SUM(i.quantity * p.cost_price),0) AS amount, COUNT(*) AS item_count
      FROM inventory_items i JOIN products p ON p.id = i.product_id
      LEFT JOIN departments d ON d.id = p.department_id
      WHERE i.session_id = ? GROUP BY d.id, d.name
    `, [session.id]);

    let prevAmount = null;
    if (session.based_on_session_id) {
      const prevRow = await db.get(`
        SELECT COALESCE(SUM(i.quantity * p.cost_price),0) AS amount
        FROM inventory_items i JOIN products p ON p.id=i.product_id WHERE i.session_id=?
      `, [session.based_on_session_id]);
      prevAmount = Number(prevRow.amount);
    }

    const currentAmount = Number(amountRow.amount);
    res.json({
      session,
      targetCount: targetProducts.length,
      countedCount: countedIds.size,
      notCountedCount: notCounted.length,
      progressRate: targetProducts.length ? countedIds.size / targetProducts.length : 0,
      currentAmount,
      departmentAmounts: deptAmounts.map(d => ({ ...d, amount: Number(d.amount), item_count: Number(d.item_count) })),
      prevAmount,
      diffAmount: prevAmount != null ? currentAmount - prevAmount : null,
      notCountedList: notCounted
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
