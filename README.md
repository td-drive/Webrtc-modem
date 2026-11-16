# V.34 風ダイヤルアップ over WebRTC

WebRTC 越しに QAM モデム信号を流してテキストを送り合う試作。

回線は音声トラックではなく DataChannel (順序保証なし・再送なし) で、9600 Hz / 16 bit の
サンプル列をそのまま運ぶ。受信側は届いたサンプルを順に復調するだけで再生クロックを持たず、
欠落パケットは同じ長さの無音で埋める。そのため音声トラックで起きるジッタバッファの
サンプル伸縮がなく、キャリア同期が切れない。

    npm install
    npm run dev      # wrangler dev: http://localhost:8787 を 2 つのタブで開く
    npm run deploy   # Cloudflare Workers へデプロイ (初回は npx wrangler login)
    npm test         # 模擬回線でのオフライン検証
    npm run test:e2e # Chromium 2 ページで実際に WebRTC 接続 (要 playwright)

片方が「着信待ち」、もう片方が同じ番号に「発信」する。

## 構成

- `public/modem-core.js` モデム本体 (AudioWorklet / Node 共用)
- `public/main.js` WebRTC 接続と UI
- `src/worker.js` シグナリング (Cloudflare Workers + Durable Objects, WebSocket)
- `wrangler.toml` Workers の設定。`public/` は静的アセットとして配信される

## TURN (NAT 越えできない環境向け)

`RING` のあと進まない場合は TURN 中継が必要。Cloudflare ダッシュボードの Realtime → TURN で
TURN キーを作成し、表示される 2 つの値を Worker のシークレットに登録する。

    npx wrangler secret put TURN_KEY_ID
    npx wrangler secret put TURN_KEY_API_TOKEN

登録後は接続時のログに `[ice] TURN: 有効` と表示される。ローカル (`npm run dev`) で使う場合は
`.dev.vars` に同じ 2 行を `KEY=値` 形式で書く。

## V.34 との対応

| 項目 | V.34 | この実装 |
|---|---|---|
| シンボルレート / 搬送波 | 2400〜3429 baud / 1600〜1959 Hz | 2400 baud / 1800 Hz 固定 |
| スクランブラ | 1+x⁻¹⁸+x⁻²³ (発呼), 1+x⁻⁵+x⁻²³ (応答) | 同じ |
| 起動手順 | V.8 (ANSam, CM/JM) → 回線プロービング → TRN | ANSam → トーン A/B → TRN (簡略) |
| 変調 | シェルマッピング + 4D トレリス + プリコーディング | 無符号化 4/16/64/256-QAM (Gray) |
| 速度 | 2400〜33600 bps | 4800 / 9600 / 14400 / 19200 bps (SNR で自動選択) |
| 誤り訂正 | V.42 LAPM (別規格) | HDLC + FCS-16 + go-back-N 再送 |
| 同期維持 | 連続キャリア | 連続キャリア + 0.5 秒ごとの同期語 (パケット欠落後の復帰と SNR 測定用) |

実物の V.34 モデムとは相互接続できない。
