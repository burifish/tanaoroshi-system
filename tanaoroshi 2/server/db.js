// db.js
// PostgreSQL(Neon等のクラウドDB)をデータストアとして利用する。
// 接続先は環境変数 DATABASE_URL で指定する(Neon/Render等のダッシュボードで発行される接続文字列)。
// ローカル開発時は .env や環境変数で DATABASE_URL=postgres://user:pass@localhost:5432/tanaoroshi のように指定する。
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.warn('[警告] 環境変数 DATABASE_URL が設定されていません。DBに接続できません。');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Neon等のホスティングDBはSSL接続が必須。ローカルのPostgreSQLに接続する場合は
  // DATABASE_URL に "?sslmode=disable" を付与すればこの設定は無視される。
  ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false }
});

pool.on('error', (err) => {
  console.error('予期しないDBプールエラー:', err);
});

// ------------------------------------------------------------------
// better-sqlite3ライクな簡易ヘルパー
// 既存のSQL文で使っていた "?" 位置プレースホルダ、または "@name" 名前付き
// プレースホルダを PostgreSQL の "$1, $2..." 形式に変換して実行する。
// ------------------------------------------------------------------
function compile(sql, params) {
  if (params === undefined) return { text: sql, values: [] };
  if (Array.isArray(params)) {
    let i = 0;
    const text = sql.replace(/\?/g, () => '$' + (++i));
    return { text, values: params };
  }
  // オブジェクト params (@name形式)
  const values = [];
  const seen = {};
  const text = sql.replace(/@(\w+)/g, (m, name) => {
    if (!(name in seen)) {
      values.push(params[name]);
      seen[name] = values.length;
    }
    return '$' + seen[name];
  });
  return { text, values };
}

function makeExecutor(queryFn) {
  return {
    async all(sql, params) {
      const { text, values } = compile(sql, params);
      const res = await queryFn(text, values);
      return res.rows;
    },
    async get(sql, params) {
      const { text, values } = compile(sql, params);
      const res = await queryFn(text, values);
      return res.rows[0];
    },
    async run(sql, params) {
      const { text, values } = compile(sql, params);
      const res = await queryFn(text, values);
      return {
        changes: res.rowCount,
        lastInsertRowid: res.rows && res.rows[0] ? res.rows[0].id : undefined
      };
    }
  };
}

const db = makeExecutor((text, values) => pool.query(text, values));

// トランザクション実行ヘルパー。コールバックには db.all/get/run と同じ形の
// トランザクション専用エグゼキュータが渡される。
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tx = makeExecutor((text, values) => client.query(text, values));
    const result = await fn(tx);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (e2) { /* ignore */ }
    throw e;
  } finally {
    client.release();
  }
}
db.withTransaction = withTransaction;

// ------------------------------------------------------------------
// スキーマ初期化
// ------------------------------------------------------------------
async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS departments (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      product_code TEXT NOT NULL UNIQUE,
      jan_code TEXT UNIQUE,
      name TEXT NOT NULL,
      spec TEXT,
      department_id INTEGER REFERENCES departments(id),
      unit TEXT NOT NULL DEFAULT '個',
      cost_price NUMERIC NOT NULL DEFAULT 0,
      sell_price NUMERIC NOT NULL DEFAULT 0,
      location TEXT,
      is_inventory_target INTEGER NOT NULL DEFAULT 1,
      note TEXT,
      stock_qty NUMERIC NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_products_jan ON products(jan_code);
    CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);

    CREATE TABLE IF NOT EXISTS inventory_sessions (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'in_progress',
      target_date TEXT,
      started_at TIMESTAMP NOT NULL DEFAULT NOW(),
      saved_at TIMESTAMP,
      finalized_at TIMESTAMP,
      revision_count INTEGER NOT NULL DEFAULT 0,
      based_on_session_id INTEGER REFERENCES inventory_sessions(id),
      created_by TEXT,
      note TEXT
    );

    CREATE TABLE IF NOT EXISTS inventory_items (
      id SERIAL PRIMARY KEY,
      session_id INTEGER NOT NULL REFERENCES inventory_sessions(id),
      product_id INTEGER NOT NULL REFERENCES products(id),
      jan_code TEXT,
      quantity NUMERIC NOT NULL DEFAULT 0,
      unit TEXT,
      location TEXT,
      note TEXT,
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_by TEXT,
      UNIQUE(session_id, product_id)
    );
    CREATE INDEX IF NOT EXISTS idx_items_session ON inventory_items(session_id);

    CREATE TABLE IF NOT EXISTS inventory_scan_logs (
      id SERIAL PRIMARY KEY,
      session_id INTEGER NOT NULL,
      item_id INTEGER,
      product_id INTEGER,
      jan_code TEXT,
      qty_entered NUMERIC,
      mode TEXT,
      result_qty NUMERIC,
      operator TEXT,
      scanned_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS inventory_item_revisions (
      id SERIAL PRIMARY KEY,
      item_id INTEGER NOT NULL,
      session_id INTEGER NOT NULL,
      old_quantity NUMERIC,
      new_quantity NUMERIC,
      reason TEXT,
      operator TEXT,
      revised_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS operation_logs (
      id SERIAL PRIMARY KEY,
      "user" TEXT,
      action TEXT,
      target TEXT,
      detail TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  const defaultSettings = {
    duplicate_mode: 'add',
    qty_warning_multiplier: '5',
    company_name: '棚卸しシステム'
  };
  for (const [k, v] of Object.entries(defaultSettings)) {
    await pool.query('INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT(key) DO NOTHING', [k, v]);
  }
}

module.exports = db;
module.exports.pool = pool;
module.exports.initSchema = initSchema;
