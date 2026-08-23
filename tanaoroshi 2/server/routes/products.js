const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const db = require('../db');
const { logOperation } = require('../logger');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// 部門一覧
router.get('/departments', async (req, res) => {
  try {
    const rows = await db.all('SELECT * FROM departments ORDER BY sort_order');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 商品検索一覧
router.get('/products', async (req, res) => {
  try {
    const { q, department_id, target_only } = req.query;
    let sql = `SELECT p.*, d.name AS department_name FROM products p
               LEFT JOIN departments d ON d.id = p.department_id WHERE 1=1`;
    const params = [];
    if (q) {
      sql += ` AND (p.name ILIKE ? OR p.jan_code ILIKE ? OR p.product_code ILIKE ?)`;
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (department_id) {
      sql += ` AND p.department_id = ?`;
      params.push(department_id);
    }
    if (target_only === '1') {
      sql += ` AND p.is_inventory_target = 1`;
    }
    sql += ` ORDER BY p.product_code`;
    const rows = await db.all(sql, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// バーコードで商品検索 + 現在セッションの棚卸状況
router.get('/products/lookup', async (req, res) => {
  try {
    const { jan, session_id } = req.query;
    if (!jan) return res.status(400).json({ error: 'janが必要です' });
    const product = await db.get(`
      SELECT p.*, d.name AS department_name FROM products p
      LEFT JOIN departments d ON d.id = p.department_id
      WHERE p.jan_code = ?`, [jan.trim()]);

    if (!product) {
      return res.status(404).json({ error: 'NOT_FOUND', message: '商品マスターに登録されていません' });
    }

    let currentItem = null;
    if (session_id) {
      currentItem = await db.get(
        'SELECT * FROM inventory_items WHERE session_id = ? AND product_id = ?', [session_id, product.id]
      );
    }

    res.json({ product, currentItem });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 商品マスターの取込用サンプルCSVテンプレート出力
// 注意: "/products/:id" より前に定義すること(そうしないと "template.csv" が商品IDとして
// 誤って解釈され、この特定パスまで到達できなくなる)
router.get('/products/template.csv', (req, res) => {
  const headers = ['商品コード', 'JANコード', '商品名', '規格', '部門', '単位', '仕入単価', '売価', '保管場所', '棚卸対象', '備考', '登録在庫数'];
  const sample = ['P0100', '4900000000000', 'サンプル商品', '1個', '直売所', '個', '100', '150', '倉庫A-1', '対象', '', '10'];
  const csv = '﻿' + [headers.join(','), sample.join(',')].join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="product_import_template.csv"');
  res.send(csv);
});

router.get('/products/:id', async (req, res) => {
  try {
    const row = await db.get(`SELECT p.*, d.name AS department_name FROM products p
      LEFT JOIN departments d ON d.id = p.department_id WHERE p.id = ?`, [req.params.id]);
    if (!row) return res.status(404).json({ error: '商品が見つかりません' });
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function upsertDepartmentByName(name) {
  if (!name) return null;
  let dept = await db.get('SELECT id FROM departments WHERE name = ?', [name]);
  if (!dept) {
    const info = await db.run('INSERT INTO departments (name, sort_order) VALUES (?, 999) RETURNING id', [name]);
    return info.lastInsertRowid;
  }
  return dept.id;
}

// 商品新規登録
router.post('/products', async (req, res) => {
  const b = req.body;
  if (!b.product_code || !b.name) {
    return res.status(400).json({ error: '商品コードと商品名は必須です' });
  }
  try {
    const department_id = b.department_id || await upsertDepartmentByName(b.department_name);
    const info = await db.run(`
      INSERT INTO products (product_code, jan_code, name, spec, department_id, unit, cost_price, sell_price, location, is_inventory_target, note, stock_qty)
      VALUES (@product_code, @jan_code, @name, @spec, @department_id, @unit, @cost_price, @sell_price, @location, @is_inventory_target, @note, @stock_qty)
      RETURNING id
    `, {
      product_code: b.product_code,
      jan_code: b.jan_code || null,
      name: b.name,
      spec: b.spec || '',
      department_id: department_id || null,
      unit: b.unit || '個',
      cost_price: Number(b.cost_price) || 0,
      sell_price: Number(b.sell_price) || 0,
      location: b.location || '',
      is_inventory_target: b.is_inventory_target === false || b.is_inventory_target === 0 ? 0 : 1,
      note: b.note || '',
      stock_qty: Number(b.stock_qty) || 0
    });
    logOperation(b.operator, '商品登録', b.product_code, b.name);
    res.json({ id: info.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 商品更新
router.put('/products/:id', async (req, res) => {
  const b = req.body;
  try {
    const existing = await db.get('SELECT * FROM products WHERE id=?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: '商品が見つかりません' });
    const department_id = b.department_id || (b.department_name ? await upsertDepartmentByName(b.department_name) : null) || existing.department_id;
    await db.run(`
      UPDATE products SET
        product_code=@product_code, jan_code=@jan_code, name=@name, spec=@spec,
        department_id=@department_id, unit=@unit, cost_price=@cost_price, sell_price=@sell_price,
        location=@location, is_inventory_target=@is_inventory_target, note=@note, stock_qty=@stock_qty,
        updated_at=NOW()
      WHERE id=@id
    `, {
      id: req.params.id,
      product_code: b.product_code ?? existing.product_code,
      jan_code: b.jan_code ?? existing.jan_code,
      name: b.name ?? existing.name,
      spec: b.spec ?? existing.spec,
      department_id,
      unit: b.unit ?? existing.unit,
      cost_price: b.cost_price != null ? Number(b.cost_price) : existing.cost_price,
      sell_price: b.sell_price != null ? Number(b.sell_price) : existing.sell_price,
      location: b.location ?? existing.location,
      is_inventory_target: b.is_inventory_target != null ? (b.is_inventory_target ? 1 : 0) : existing.is_inventory_target,
      note: b.note ?? existing.note,
      stock_qty: b.stock_qty != null ? Number(b.stock_qty) : existing.stock_qty
    });
    logOperation(b.operator, '商品更新', existing.product_code, b.name || existing.name);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/products/:id', async (req, res) => {
  try {
    const existing = await db.get('SELECT * FROM products WHERE id=?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: '商品が見つかりません' });
    await db.run('DELETE FROM products WHERE id=?', [req.params.id]);
    logOperation(req.query.operator, '商品削除', existing.product_code, existing.name);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// CSV/Excel 一括登録
// 期待列: 商品コード, JANコード, 商品名, 規格, 部門, 単位, 仕入単価, 売価, 保管場所, 棚卸対象, 備考, 登録在庫数
router.post('/products/import', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'ファイルがアップロードされていません' });
  let rows;
  try {
    const isCsv = /\.csv$/i.test(req.file.originalname || '') || req.file.mimetype === 'text/csv';
    let wb;
    if (isCsv) {
      // CSVはUTF-8前提でテキストとして読み込む(BOM付き/なし両対応、SheetJSのバイナリ判定によるcodepage誤検出を回避)
      let text = req.file.buffer.toString('utf8');
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
      wb = XLSX.read(text, { type: 'string' });
    } else {
      wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    }
    const sheet = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  } catch (e) {
    return res.status(400).json({ error: 'ファイルの読み込みに失敗しました: ' + e.message });
  }

  const colMap = {
    '商品コード': 'product_code', 'JANコード': 'jan_code', 'JAN': 'jan_code',
    '商品名': 'name', '規格': 'spec', '部門': 'department_name', '単位': 'unit',
    '仕入単価': 'cost_price', '売価': 'sell_price', '保管場所': 'location',
    '棚卸対象': 'target_flag', '備考': 'note', '登録在庫数': 'stock_qty'
  };

  let success = 0;
  const errors = [];

  // 注意: 行ごとに個別のトランザクションで処理する(全体を1つの大きなトランザクションに
  // まとめると、PostgreSQLでは1行でもエラーになった時点でトランザクション全体が
  // "aborted" 状態になり、以降の正常な行まで巻き添えでエラーになってしまうため)
  for (let idx = 0; idx < rows.length; idx++) {
    const raw = rows[idx];
    const rec = {};
    for (const [jp, en] of Object.entries(colMap)) {
      if (raw[jp] !== undefined) rec[en] = raw[jp];
    }
    if (!rec.product_code || !rec.name) {
      errors.push({ row: idx + 2, error: '商品コードまたは商品名が空です' });
      continue;
    }
    const targetFlag = String(rec.target_flag ?? '対象').trim();
    const is_target = (targetFlag === '対象外' || targetFlag === '0' || targetFlag.toLowerCase() === 'false') ? 0 : 1;
    try {
      await db.withTransaction(async (tx) => {
        let department_id = null;
        const deptName = String(rec.department_name || '').trim();
        if (deptName) {
          let dept = await tx.get('SELECT id FROM departments WHERE name = ?', [deptName]);
          if (!dept) {
            const info = await tx.run('INSERT INTO departments (name, sort_order) VALUES (?, 999) RETURNING id', [deptName]);
            department_id = info.lastInsertRowid;
          } else {
            department_id = dept.id;
          }
        }
        await tx.run(`
          INSERT INTO products (product_code, jan_code, name, spec, department_id, unit, cost_price, sell_price, location, is_inventory_target, note, stock_qty)
          VALUES (@product_code, @jan_code, @name, @spec, @department_id, @unit, @cost_price, @sell_price, @location, @is_inventory_target, @note, @stock_qty)
          ON CONFLICT(product_code) DO UPDATE SET
            jan_code=excluded.jan_code, name=excluded.name, spec=excluded.spec,
            department_id=excluded.department_id, unit=excluded.unit, cost_price=excluded.cost_price,
            sell_price=excluded.sell_price, location=excluded.location,
            is_inventory_target=excluded.is_inventory_target, note=excluded.note, stock_qty=excluded.stock_qty,
            updated_at=NOW()
        `, {
          product_code: String(rec.product_code).trim(),
          jan_code: rec.jan_code ? String(rec.jan_code).trim() : null,
          name: String(rec.name).trim(),
          spec: rec.spec || '',
          department_id: department_id || null,
          unit: rec.unit || '個',
          cost_price: Number(rec.cost_price) || 0,
          sell_price: Number(rec.sell_price) || 0,
          location: rec.location || '',
          is_inventory_target: is_target,
          note: rec.note || '',
          stock_qty: Number(rec.stock_qty) || 0
        });
      });
      success++;
    } catch (e) {
      errors.push({ row: idx + 2, error: e.message });
    }
  }

  logOperation(req.body.operator, '商品一括登録', req.file.originalname, `成功${success}件/エラー${errors.length}件`);
  res.json({ success, errorCount: errors.length, errors, total: rows.length });
});

module.exports = router;
