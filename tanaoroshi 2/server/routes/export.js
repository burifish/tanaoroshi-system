const express = require('express');
const XLSX = require('xlsx');
const db = require('../db');
const { logOperation } = require('../logger');
const { excelSafeNumericText } = require('../csvUtil');

const router = express.Router();

async function buildExportRows(sessionId) {
  const session = await db.get('SELECT * FROM inventory_sessions WHERE id=?', [sessionId]);
  if (!session) return null;

  const items = await db.all(`
    SELECT i.*, p.product_code, p.jan_code AS product_jan, p.name AS product_name, p.spec, p.unit AS master_unit,
           p.cost_price, d.name AS department_name, d.sort_order
    FROM inventory_items i
    JOIN products p ON p.id = i.product_id
    LEFT JOIN departments d ON d.id = p.department_id
    WHERE i.session_id = ?
    ORDER BY d.sort_order, p.product_code
  `, [sessionId]);

  let prevMap = new Map();
  if (session.based_on_session_id) {
    const prevRows = await db.all('SELECT product_id, quantity FROM inventory_items WHERE session_id=?', [session.based_on_session_id]);
    prevRows.forEach(r => prevMap.set(r.product_id, Number(r.quantity)));
  }

  const rows = items.map(i => {
    const qty = Number(i.quantity);
    const cost = Number(i.cost_price);
    const prevQty = prevMap.has(i.product_id) ? prevMap.get(i.product_id) : '';
    const diffQty = prevMap.has(i.product_id) ? (qty - prevMap.get(i.product_id)) : '';
    return {
      '棚卸日': session.target_date,
      '部門': i.department_name || '',
      '商品コード': i.product_code,
      'JANコード': i.jan_code || i.product_jan || '',
      '商品名': i.product_name,
      '規格': i.spec || '',
      '単位': i.master_unit || '',
      '仕入単価': cost,
      '棚卸数量': qty,
      '棚卸金額': Math.round(qty * cost),
      '前回数量': prevQty,
      '増減数量': diffQty,
      '備考': i.note || ''
    };
  });
  return { session, rows };
}

router.get('/sessions/:id/export.csv', async (req, res) => {
  try {
    const data = await buildExportRows(req.params.id);
    if (!data) return res.status(404).json({ error: 'セッションが見つかりません' });
    const headers = ['棚卸日', '部門', '商品コード', 'JANコード', '商品名', '規格', '単位', '仕入単価', '棚卸数量', '棚卸金額', '前回数量', '増減数量', '備考'];
    // 商品コード・JANコードはExcelで開くと指数表記(4.9E+12等)に自動変換され、
    // 保存し直すと桁が失われるため、Excelがテキストとして認識する ="..." 形式で書き出す
    const excelSafeCols = new Set(['商品コード', 'JANコード']);
    const escape = (v) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [headers.join(',')];
    data.rows.forEach(r => lines.push(headers.map(h => escape(excelSafeCols.has(h) ? excelSafeNumericText(r[h]) : r[h])).join(',')));
    const csv = '﻿' + lines.join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="tanaoroshi_${req.params.id}.csv"`);
    logOperation(req.query.operator, 'CSV出力', data.session.title, '');
    res.send(csv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/sessions/:id/export.xlsx', async (req, res) => {
  try {
    const data = await buildExportRows(req.params.id);
    if (!data) return res.status(404).json({ error: 'セッションが見つかりません' });
    const ws = XLSX.utils.json_to_sheet(data.rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '棚卸結果');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="tanaoroshi_${req.params.id}.xlsx"`);
    logOperation(req.query.operator, 'Excel出力', data.session.title, '');
    res.send(buf);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
