const express = require('express');
const cors = require('cors');
const path = require('path');

const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true }));

app.use('/api', require('./routes/products'));
app.use('/api', require('./routes/sessions'));
app.use('/api', require('./routes/export'));

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;

// 起動時にDBスキーマを初期化してからリクエスト受付を開始する
// (データ本体の保存・バックアップはPostgreSQLホスティング側(Neon等)に委ねる。
//  Neonは自動バックアップ/ポイントインタイムリカバリを提供している)
db.initSchema()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`棚卸しシステム起動: http://localhost:${PORT}`);
    });
  })
  .catch((e) => {
    console.error('DB初期化に失敗しました。DATABASE_URL の設定を確認してください。', e);
    process.exit(1);
  });
