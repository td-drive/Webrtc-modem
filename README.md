# V.34 風ダイヤルアップ over WebRTC

WebRTC 越しに QAM モデム信号を流してテキストを送り合う試作。

回線は音声トラックではなく DataChannel (順序保証なし・再送なし) で、16 bit の
サンプル列をそのまま運ぶ (回線のサンプルレートはシンボルレートの 4 倍で、2400 baud のとき 9600 Hz)。受信側は届いたサンプルを順に復調するだけで再生クロックを持たず、
欠落パケットは同じ長さの無音で埋める。そのため音声トラックで起きるジッタバッファの
サンプル伸縮がなく、キャリア同期が切れない。

    npm install
    npm run dev      # wrangler dev: http://localhost:8787 を 2 つのタブで開く
    npm run deploy   # Cloudflare Workers へデプロイ (初回は npx wrangler login)
    npm test         # V.34 符号化の往復テスト + 模擬回線でのオフライン検証
    npm run test:e2e # Chromium 2 ページで実際に WebRTC 接続 (要 playwright)

片方が「着信待ち」、もう片方が同じ番号に「発信」する。

## 構成

- `public/modem-core.js` モデム本体: 変復調・等化・HDLC・再送 (AudioWorklet / Node 共用)
- `public/v34-map.js` V.34 データモードの符号化と復号
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
| シンボルレート / 搬送波 | 2400〜3429 baud の 6 種 | 同じ 6 種 (搬送波は高い方)。UI で上限を選べる |
| データレート | 2400〜33600 bps | 同じ表 (Table 8/10)。SNR から自動選択。補助チャネル (+200 bps) なし |
| データモードの符号化 | シェルマッピング + 16/32/64 状態 4D トレリス + プリコーディング + 非線形符号化 | シェルマッピング + 16 状態 4D トレリス。プリコーディング係数 0、非線形符号化なし |
| スクランブラ | 1+x⁻¹⁸+x⁻²³ (発呼), 1+x⁻⁵+x⁻²³ (応答) | 同じ |
| 受信 | — | 4D ビタビ復号 + 逆マッピング |
| 起動手順 | V.8 (ANSam, CM/JM) → 回線プロービング → S/PP/TRN → MP | ANSam → トーン A/B → TRN → HDLC で速度交渉 (簡略・非互換) |
| フレーム同期 | 起動時に確立し連続送信 | 0.5 秒ごとに同期語 32 + ヘッダ 16 シンボルを挿入 (非標準) |
| 誤り訂正 | V.42 LAPM (別規格) | HDLC + FCS-16 + go-back-N 再送 |

### 互換性について

- データモードのビット→シンボル変換 (`public/v34-map.js`) は V.34 9 節の式と表に沿って書いた。
  仕様書本文は参照できなかったため、解釈は SpanDSP の `v34tx.c` / `v34rx.c` を参考にしている。
- 確認できているのは自前の符号化と復号の往復 (全 65 通りのシンボルレート × データレート) だけ。
  参照実装や実機との突き合わせはしていないので、ビット互換は未検証。
- 起動手順と同期語の挿入が非標準なので、実物の V.34 モデムとは接続できない。
