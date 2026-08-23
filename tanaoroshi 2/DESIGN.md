# バーコード読取式 棚卸しシステム 設計書

## 1. 全体アーキテクチャ

```
┌─────────────────────┐        HTTPS        ┌──────────────────────────┐
│  スマホ / タブレット   │ ───────────────────▶ │  Webサーバー (Node.js/Express) │
│  ブラウザ (PWA風UI)   │ ◀─────────────────── │   REST API                │
│  カメラでバーコード読取 │                      └───────────┬──────────────┘
└─────────────────────┘                                  │
┌─────────────────────┐                                  ▼
│  PC ブラウザ         │ ───────────────────▶  ┌──────────────────────────┐
│ (商品マスター管理/結果確認) │                   │  データベース (クラウドDB)   │
└─────────────────────┘                        │  PostgreSQL (Neon等)        │
                                                └──────────────────────────┘
```

* フロントエンドはスマホの標準ブラウザで動作する**Webアプリ**（アプリインストール不要）。カメラ読取には
  [html5-qrcode](https://github.com/mebjas/html5-qrcode) を使用し、JAN/EAN/CODE128等の1次元バーコードを
  ブラウザのカメラAPI(getUserMedia)経由で読み取る。
* バックエンドはNode.js + Express によるREST API。データはPostgreSQL(Neon等のクラウドDB)に保存する。
  接続先は環境変数`DATABASE_URL`で指定し、SQL発行部分は`server/db.js`に集約しているため、
  他のPostgreSQL互換サービス(Amazon RDS / Cloud SQL等)への切り替えも接続文字列の変更のみで対応できる。
* 複数端末から同時アクセスできるよう、状態はすべてサーバー側DBに保持し、クライアントはAPI経由でのみ
  読み書きする（クライアント側にローカル保存の在庫データを持たない = 端末をまたいでも一貫性を保つ）。
* 操作履歴（誰が・いつ・何を登録/修正したか）は `operation_logs` と `inventory_scan_logs` に記録し、
  データ消失防止のため全ての登録操作は都度DBにコミットする（自動保存）。バックアップ/障害復旧は
  Neon等のマネージドDBが提供するポイントインタイムリカバリ機能に委ねる構成としている。
* 将来のPOS/会計/販売管理連携を見据え、商品マスターに `product_code`（自社商品コード）と
  `jan_code`（JAN/EANコード）を分離して保持し、他システムとのコード体系の橋渡しができる設計にしている。
  また全APIはREST/JSON形式のため、外部システムからも同一APIを叩いて連携可能。

## 2. データベース設計 (ER図)

```mermaid
erDiagram
    DEPARTMENTS ||--o{ PRODUCTS : "所属"
    PRODUCTS ||--o{ INVENTORY_ITEMS : "棚卸対象"
    PRODUCTS ||--o{ INVENTORY_SCAN_LOGS : "読取対象"
    INVENTORY_SESSIONS ||--o{ INVENTORY_ITEMS : "含む"
    INVENTORY_SESSIONS ||--o{ INVENTORY_SCAN_LOGS : "含む"
    INVENTORY_ITEMS ||--o{ INVENTORY_ITEM_REVISIONS : "修正履歴"

    DEPARTMENTS {
      int id PK
      string name
      int sort_order
    }
    PRODUCTS {
      int id PK
      string product_code "商品コード"
      string jan_code "JANコード(検索キー)"
      string name "商品名"
      string spec "規格・容量"
      int department_id FK
      string unit "単位"
      real cost_price "仕入単価"
      real sell_price "売価"
      string location "保管場所"
      int is_inventory_target "棚卸対象(1)/対象外(0)"
      string note
      real stock_qty "登録在庫数(理論在庫)"
      datetime created_at
      datetime updated_at
    }
    INVENTORY_SESSIONS {
      int id PK
      string title "例:2026年8月棚卸"
      string status "in_progress/temp_saved/finalized"
      date target_date
      datetime started_at
      datetime finalized_at
      int revision_count
      int based_on_session_id FK "前回セッション参照"
      string created_by
      string note
    }
    INVENTORY_ITEMS {
      int id PK
      int session_id FK
      int product_id FK
      string jan_code
      real quantity "棚卸数量(累計)"
      string unit
      string location "棚・保管場所"
      string note
      string status "counted/duplicate_warning"
      datetime created_at
      datetime updated_at
      string updated_by
    }
    INVENTORY_SCAN_LOGS {
      int id PK
      int session_id FK
      int item_id FK
      int product_id FK
      string jan_code
      real qty_entered "今回入力した数量"
      string mode "add/overwrite"
      real result_qty "処理後の数量"
      string operator
      datetime scanned_at
    }
    INVENTORY_ITEM_REVISIONS {
      int id PK
      int item_id FK
      int session_id FK
      real old_quantity
      real new_quantity
      string reason "修正理由"
      string operator
      datetime revised_at
    }
    OPERATION_LOGS {
      int id PK
      string user
      string action
      string target
      string detail
      datetime created_at
    }
    SETTINGS {
      string key PK
      string value
    }
```

補足:
* `INVENTORY_ITEMS` は棚卸セッション内で「商品ごとに1行」持つ集約テーブル。同じバーコードを何度読んでも
  行は増えず、`quantity` を加算/上書きする。個々の読取イベント（誰が・いつ・何個入力したか）は
  `INVENTORY_SCAN_LOGS` に全件残す（監査ログ・トラブル時の追跡用）。
* `PRODUCTS.stock_qty` は理論在庫（登録在庫数）。棚卸差異 = 棚卸数量 − 理論在庫、として利用可能。
* 確定(`finalized`)後は `INVENTORY_ITEMS` を直接更新禁止。修正が必要な場合は `INVENTORY_ITEM_REVISIONS`
  に履歴を残しつつ数量を更新し、セッションの `revision_count` をインクリメントする「棚卸し修正」操作を通す。
* 前回比較は「対象部門・全体で直近の `finalized` セッション」を自動的に基準として使う
  （`based_on_session_id` で明示指定も可）。

## 3. 画面遷移設計

```mermaid
flowchart TD
    TOP[トップメニュー] -->|最大ボタン| SCAN[バーコード読取]
    TOP --> LIST[棚卸一覧]
    TOP --> SEARCH[商品検索]
    TOP --> RESULT[棚卸結果]
    TOP --> MASTER[商品マスター]
    TOP --> SETTINGS[設定]
    TOP --> DASH[ダッシュボード]

    SCAN -->|バーコード検出| INFO[商品情報表示]
    INFO -->|登録済み| QTY[棚卸数量入力]
    INFO -->|未登録商品| WARN[未登録警告表示]
    WARN --> SCAN
    QTY -->|登録ボタン| SAVE[保存処理 加算/上書き]
    SAVE -->|自動遷移| SCAN

    LIST --> ITEMEDIT[明細編集/削除]
    SEARCH --> PRODDETAIL[商品詳細]

    RESULT --> DEPTVIEW[部門別集計]
    RESULT --> COMPARE[前回比較]
    RESULT --> EXPORT[CSV/Excel出力]
    RESULT --> HISTORY[棚卸履歴一覧]

    MASTER --> MADD[商品追加/編集]
    MASTER --> IMPORT[CSV/Excel一括登録]

    SETTINGS --> DUPMODE[加算/上書き設定]
    SETTINGS --> SESSIONCTRL[開始/一時保存/確定/修正]
```

* **バーコード読取→登録→次の読取** は画面遷移なしで完結する「1画面ワークフロー」として実装
  （SCAN→INFO→QTY→SAVE→SCANが同一画面内でカード切り替え、片手操作を想定し主要ボタンは画面下部に大きく配置）。

## 4. 主要処理フロー（バーコード読取〜登録）

```mermaid
sequenceDiagram
    participant U as 作業者(スマホ)
    participant C as ブラウザ(カメラ)
    participant S as APIサーバー
    participant D as DB

    U->>C: バーコードにカメラを向ける
    C->>C: html5-qrcodeでデコード
    C->>S: GET /api/products/lookup?jan=xxxx&session_id=yy
    S->>D: 商品マスター検索 + 現セッションの既存数量取得
    D-->>S: 商品情報 / 該当なし
    alt 商品が見つかった
        S-->>C: 商品コード・商品名・規格・部門・単位・登録在庫数・既存棚卸数量
        C-->>U: 商品情報カード表示 + 数量キーパッド表示
        U->>C: 棚卸数量を入力し「登録」を押す
        C->>S: POST /api/sessions/:id/items {jan_code, qty, location, note}
        S->>S: 数値チェック(0以上の数値のみ)/異常値チェック/棚卸対象外チェック
        S->>D: 加算 or 上書き(設定に従う)で INVENTORY_ITEMS を更新
        S->>D: INVENTORY_SCAN_LOGS に読取イベントを追記
        D-->>S: 更新後データ
        S-->>C: 登録完了 + 更新後の合計数量
        C-->>U: トースト表示→0.6秒後に自動でスキャン画面へ復帰
    else 商品が見つからない
        S-->>C: 404 (未登録)
        C-->>U: 「商品マスターに登録されていません」を表示
    end
```

## 5. API設計（抜粋）

| メソッド | パス | 概要 |
|---|---|---|
| GET | /api/departments | 部門一覧 |
| GET | /api/products?q=&department_id= | 商品検索 |
| GET | /api/products/lookup?jan=&session_id= | バーコードで商品検索+現在の棚卸状況 |
| POST | /api/products | 商品新規登録 |
| PUT | /api/products/:id | 商品更新 |
| DELETE | /api/products/:id | 商品削除 |
| POST | /api/products/import | CSV/Excel一括登録 |
| GET | /api/sessions | 棚卸セッション履歴一覧 |
| POST | /api/sessions | 棚卸し開始(新規セッション作成) |
| GET | /api/sessions/:id | セッション詳細 |
| POST | /api/sessions/:id/save | 一時保存（ステータス更新） |
| POST | /api/sessions/:id/finalize | 棚卸し確定 |
| POST | /api/sessions/:id/items/:itemId/revise | 棚卸し修正（確定後の修正、履歴を残す） |
| GET | /api/sessions/:id/items?q= | 棚卸明細一覧・検索 |
| POST | /api/sessions/:id/items | バーコード登録（加算/上書き） |
| PUT | /api/sessions/:id/items/:itemId | 明細の手動編集(未確定時のみ) |
| DELETE | /api/sessions/:id/items/:itemId | 明細削除(未確定時のみ) |
| GET | /api/sessions/:id/results | 商品別/部門別集計・前回比較 |
| GET | /api/sessions/:id/dashboard | 進捗ダッシュボード・未棚卸一覧 |
| GET | /api/sessions/:id/export.csv | CSV出力 |
| GET | /api/sessions/:id/export.xlsx | Excel出力 |
| GET/PUT | /api/settings | 加算/上書き既定値等の設定 |
| GET | /api/logs | 操作履歴一覧 |

## 6. 画面構成（トップメニュー）

スマホ最優先。トップは6つの大型ボタン、「バーコード読取」は最大サイズ・最上部に配置。

```
┌───────────────────────────┐
│        棚卸しシステム         │
│  2026年8月棚卸(実施中)        │
├───────────────────────────┤
│ ┌─────────────────────┐ │
│ │   📷 バーコード読取     │ │ ← 最大ボタン
│ └─────────────────────┘ │
│ ┌───────────┐┌───────────┐│
│ │ 📋 棚卸一覧  ││ 🔍 商品検索  ││
│ └───────────┘└───────────┘│
│ ┌───────────┐┌───────────┐│
│ │ 📊 棚卸結果  ││ 📦 商品マスター││
│ └───────────┘└───────────┘│
│ ┌───────────┐┌───────────┐│
│ │ ⚙ 設定      ││ 📈 ダッシュボード││
│ └───────────┘└───────────┘│
└───────────────────────────┘
```

## 7. 誤入力防止・警告仕様

* 数量入力欄は `type=number, min=0, step=適切な単位刻み` とし、サーバー側でも
  `quantity >= 0` かつ数値であることを再検証（クライアント制御だけに頼らない）。
* 未登録バーコード読取時: 商品マスターに登録されていない旨を警告表示し、そのまま登録は不可
  （「商品マスターへ新規登録」ボタンから即登録可能な導線も用意）。
* 同一商品複数回読取: 設定（加算/上書き、既定=加算）に従って自動処理し、画面上に
  「前回◯個 → 今回入力△個 → 合計□個」を表示して上書きミスを防止。
* 棚卸対象外商品（`is_inventory_target=0`）を読み取った場合は警告バナーを表示し、
  登録するには確認操作を要求。
* 異常値チェック: 登録在庫数の一定倍率（既定5倍、設定変更可）を超える数量が入力された場合、
  「本当にこの数量でよろしいですか？」の確認ダイアログを表示。

## 8. 技術スタック

| 層 | 技術 |
|---|---|
| フロントエンド | HTML/CSS/Vanilla JS (SPA, hashルーティング), html5-qrcode (カメラバーコード読取) |
| バックエンド | Node.js + Express |
| DB | PostgreSQL (Neon等のクラウドDB、`pg`ドライバ経由で接続) |
| ホスティング | Render等のPaaS（GitHub連携でデプロイ、HTTPS自動付与） |
| CSV/Excel | xlsx (SheetJS) |
| 認証(拡張余地) | 本デモは簡易操作者名入力。本番はSSO/IDプロバイダ連携を想定 |

## 9. 将来拡張（POS/会計/販売管理連携）

* 商品マスターに外部連携キー(`product_code`)を保持済み。
* 全機能をREST APIとして実装しているため、他システムからのAPI呼び出し・Webhook追加が容易。
* `inventory_sessions`確定時に会計システム向け仕訳データ（棚卸差異計上）を出力するAPIを
  将来的に追加できる設計。
