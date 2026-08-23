// seed.js - 部門とサンプル商品マスターの初期投入
const db = require('./db');

const departments = ['直売所', 'レストラン', '企画', '高平', '水産部', 'Green'];

const sampleProducts = [
  // product_code, jan_code, name, spec, dept, unit, cost, sell, location, target, note, stock_qty
  ['P0001', '4901234567894', 'コシヒカリ 5kg', '5kg袋', '直売所', '袋', 2200, 2980, '倉庫A-1', 1, '', 40],
  ['P0002', '4901234567895', '朝採れトマト', '1パック', '直売所', 'パック', 150, 250, '冷蔵棚1', 1, '', 60],
  ['P0003', '4901234567896', '地元産みそ 1kg', '1kg', '直売所', '個', 480, 780, '倉庫A-2', 1, '', 25],
  ['P0004', '4901234567897', 'ハンバーグ定食セット材料', '1食分', 'レストラン', '食分', 320, 980, '厨房冷凍庫', 1, '', 15],
  ['P0005', '4901234567898', '国産牛カルビ', '300g', 'レストラン', 'パック', 950, 1580, '厨房冷蔵庫', 1, '', 12],
  ['P0006', '4901234567899', 'デミグラスソース', '1L', 'レストラン', '本', 600, 0, '厨房', 1, '', 8],
  ['P0007', '4901234567900', '企画用ノベルティタオル', '1枚', '企画', '枚', 180, 0, '企画倉庫', 1, '', 200],
  ['P0008', '4901234567901', 'イベント用のぼり旗', '1本', '企画', '本', 900, 0, '企画倉庫', 1, '', 10],
  ['P0009', '4901234567902', '高平産そば粉', '1kg', '高平', '袋', 700, 1200, '高平倉庫', 1, '', 30],
  ['P0010', '4901234567903', '高平産はちみつ', '250g', '高平', '瓶', 850, 1400, '高平倉庫', 1, '', 18],
  ['P0011', '4901234567904', '真鯛（活〆）', '1尾', '水産部', '尾', 1200, 2200, '水産冷蔵庫', 1, '', 9],
  ['P0012', '4901234567905', '天然ぶり', '1kg', '水産部', 'kg', 1600, 2600, '水産冷凍庫', 1, '', 22],
  ['P0013', '4901234567906', 'アオリイカ', '1kg', '水産部', 'kg', 1400, 2400, '水産冷蔵庫', 1, '', 14],
  ['P0014', '4901234567907', 'ハーブ苗（バジル）', '1ポット', 'Green', 'ポット', 120, 280, '温室A', 1, '', 80],
  ['P0015', '4901234567908', '観葉植物 フィカス', '1鉢', 'Green', '鉢', 900, 1980, '温室B', 1, '', 6],
  ['P0016', '4901234567909', '非売品サンプル(棚卸対象外)', '-', '企画', '個', 0, 0, '企画倉庫', 0, '展示用サンプル、棚卸対象外', 0],
];

async function seed() {
  await db.initSchema();

  for (let i = 0; i < departments.length; i++) {
    await db.run('INSERT INTO departments (name, sort_order) VALUES (?, ?) ON CONFLICT(name) DO NOTHING', [departments[i], i]);
  }

  for (const row of sampleProducts) {
    const dept = await db.get('SELECT id FROM departments WHERE name = ?', [row[4]]);
    await db.run(`
      INSERT INTO products
      (product_code, jan_code, name, spec, department_id, unit, cost_price, sell_price, location, is_inventory_target, note, stock_qty)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(product_code) DO NOTHING
    `, [row[0], row[1], row[2], row[3], dept ? dept.id : null, row[5], row[6], row[7], row[8], row[9], row[10], row[11]]);
  }

  console.log('シードデータ投入完了: 部門', departments.length, '件, 商品', sampleProducts.length, '件');
}

if (require.main === module) {
  seed()
    .then(() => db.pool.end())
    .catch((e) => { console.error('シード投入に失敗しました', e); process.exit(1); });
} else {
  module.exports = seed;
}
