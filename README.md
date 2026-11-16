# V.34 風ダイヤルアップ over WebRTC

WebRTC の音声チャネルに QAM モデム信号を流してテキストを送り合う試作。

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

## V.34 との対応

| 項目 | V.34 | この実装 |
|---|---|---|
| シンボルレート / 搬送波 | 2400〜3429 baud / 1600〜1959 Hz | 2400 baud / 1800 Hz 固定 |
| スクランブラ | 1+x⁻¹⁸+x⁻²³ (発呼), 1+x⁻⁵+x⁻²³ (応答) | 同じ |
| 起動手順 | V.8 (ANSam, CM/JM) → 回線プロービング → TRN | ANSam → トーン A/B → TRN (簡略) |
| 変調 | シェルマッピング + 4D トレリス + プリコーディング | 無符号化 4/16/64/256-QAM (Gray) |
| 速度 | 2400〜33600 bps | 4800 / 9600 / 14400 / 19200 bps (SNR で自動選択) |
| 誤り訂正 | V.42 LAPM (別規格) | HDLC + FCS-16 + go-back-N 再送 |
| 同期維持 | 連続キャリア | 0.5 秒ごとの同期語 (ジッタバッファのサンプル滑り対策) |

実物の V.34 モデムとは相互接続できない。
