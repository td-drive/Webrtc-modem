/*
 * V.34 風ソフトモデム (PHY + HDLC + 簡易 LAPM)。
 * DOM 非依存。AudioWorklet と Node (テスト) の両方で動く。
 *
 * V.34 から借りているもの:
 *   - 6 種類のシンボルレート (2400〜3429 baud) と搬送波周波数
 *   - データモードの符号化 (シェルマッピング + 16 状態 4D トレリス符号、v34-map.js)
 *   - 自己同期スクランブラ (発呼 1+x^-18+x^-23, 応答 1+x^-5+x^-23)
 *   - ANSam 応答トーン (2100 Hz, 15 Hz AM, 450 ms 位相反転), トーン A/B
 *   - TRN (スクランブルした 1 の 4 点信号) による等化器トレーニング
 * V.34 と違うもの:
 *   - 起動手順は簡略版 (V.8 の CM/JM、回線プロービング、MP シーケンスなし)
 *   - プリコーディングと非線形符号化なし
 *   - 0.5 秒ごとに同期語を挿入するスーパーフレーム構造 (パケット欠落後の復帰用)
 * 回線は WebRTC DataChannel で 9600 Hz / 16 bit のサンプル列をそのまま運ぶ。
 */
(function (root) {
  'use strict';

  const V34 = root.V34 || (typeof require !== 'undefined' ? require('./v34-map.js') : null);

  const FS = 9600, SPS = 4, Q = 1; // 起動時 (2400 baud) の回線レート。Q: T/4 あたりのサンプル数
  // 回線のサンプルレートは常にシンボルレートの 4 倍。シンボルレートを上げる = サンプルを速く流す
  const SYMRATE = V34.RATES.map((r) => 2400 * r.a / r.c);
  const CARS = V34.RATES.map((r) => { // 搬送波 = S·d/e → 1 サンプルあたり d/(4e) 周
    const n = 4 * r.e, cos = new Float64Array(n), sin = new Float64Array(n);
    for (let i = 0; i < n; i++) { cos[i] = Math.cos(2 * Math.PI * r.d * i / n); sin[i] = Math.sin(2 * Math.PI * r.d * i / n); }
    return { n, cos, sin };
  });
  const GN = FS / 100, GCOEF = 2 * Math.cos(2 * Math.PI * 2100 / FS); // 2100 Hz 検出 (10 ms ブロック)
  const TXG = 0.4;                 // 送信レベル (16 bit でクリップしないよう下げる)
  const PKT = 192;                 // 回線パケット
  const ALPHA = 0.1, SPAN = 24, NTAPS = SPAN * SPS + 1; // 3429 baud でも 4 kHz 未満に収まる狭いロールオフ
  // コンテナ (非標準): 同期語 32 + ヘッダ 16 + V.34 マッピングフレーム 144 個
  const SF_LEN = 1200, SYNC_LEN = 32, MODE_LEN = 16, HDR = SYNC_LEN + MODE_LEN;
  const FRAMES = (SF_LEN - HDR) / 8;
  const GUARD = 64;                // シンボルレート切り替え時の無音 (シンボル数)
  const SNR_MARGIN = 7.5, SNR_HYST = 2; // 必要 SNR ≒ 3.01 × (bit/シンボル) + 余裕
  const NT = 16, CENTER = 8, LOOKAHEAD = 2 * (NT - 1 - CENTER);
  const RING = 2048, MASK = RING - 1;
  const SYNC_THR = 0.6;
  const WINDOW = 16, RTO = 1.5, MAX_INFO = 128;
  const T_I = 1, T_RR = 2, T_RATE = 3, T_RACK = 4;

  // ---- テーブル ----
  const RRC = new Float64Array(NTAPS);
  (function () {
    let e = 0;
    for (let i = 0; i < NTAPS; i++) {
      const t = (i - (NTAPS - 1) / 2) / SPS;
      let h;
      if (Math.abs(t) < 1e-9) h = 1 - ALPHA + 4 * ALPHA / Math.PI;
      else if (Math.abs(Math.abs(t) - 1 / (4 * ALPHA)) < 1e-9) {
        h = ALPHA / Math.SQRT2 * ((1 + 2 / Math.PI) * Math.sin(Math.PI / (4 * ALPHA)) +
          (1 - 2 / Math.PI) * Math.cos(Math.PI / (4 * ALPHA)));
      } else {
        h = (Math.sin(Math.PI * t * (1 - ALPHA)) + 4 * ALPHA * t * Math.cos(Math.PI * t * (1 + ALPHA))) /
          (Math.PI * t * (1 - 16 * ALPHA * ALPHA * t * t));
      }
      RRC[i] = h; e += h * h;
    }
    const k = 1 / Math.sqrt(e);
    for (let i = 0; i < NTAPS; i++) RRC[i] *= k;
  })();

  // 同期語: LFSR から作った 32 個の QPSK シンボル
  const SYNC_R = new Float64Array(SYNC_LEN), SYNC_I = new Float64Array(SYNC_LEN);
  (function () {
    let sr = 0x5a;
    const bit = () => { const b = ((sr >> 6) ^ (sr >> 5)) & 1; sr = ((sr << 1) | b) & 0x7f; return b; };
    for (let i = 0; i < SYNC_LEN; i++) {
      SYNC_R[i] = (bit() ? 1 : -1) * Math.SQRT1_2;
      SYNC_I[i] = (bit() ? 1 : -1) * Math.SQRT1_2;
    }
  })();

  // ヘッダ語: 4 bit を長さ 8 の双直交符号 (Hadamard の行 × ±1) にして ±(1+j)/√2 で送る
  const H8 = [];
  for (let i = 0; i < 8; i++) { H8.push([]); for (let j = 0; j < 8; j++) { let v = i & j, p = 0; while (v) { p ^= v & 1; v >>= 1; } H8[i].push(p ? -1 : 1); } }

  const bpsOf = (S, n) => (n > 0 ? 2400 * n : Math.round(2 * SYMRATE[S])); // n = 0 は無符号化 4 点 (起動・交渉用)
  function validRate(S, n) { while (n > 0 && !V34.params(S, n)) n--; return n; }

  const CONST = [2].map((b) => {
    const h = b / 2, L = 1 << h, norm = 1 / Math.sqrt(2 * (L * L - 1) / 3);
    const g2i = new Int32Array(L);
    for (let i = 0; i < L; i++) g2i[i ^ (i >> 1)] = i;
    const re = new Float64Array(1 << b), im = new Float64Array(1 << b);
    for (let v = 0; v < (1 << b); v++) {
      re[v] = (2 * g2i[v >> h] - (L - 1)) * norm;
      im[v] = (2 * g2i[v & (L - 1)] - (L - 1)) * norm;
    }
    return { bits: b, h, L, norm, re, im };
  });

  function crc16(buf, len) { // X.25 FCS
    let c = 0xffff;
    for (let i = 0; i < len; i++) {
      c ^= buf[i];
      for (let k = 0; k < 8; k++) c = (c & 1) ? (c >>> 1) ^ 0x8408 : c >>> 1;
    }
    return c ^ 0xffff;
  }

  class Modem {
    constructor(onEvent) {
      this.onEvent = onEvent || (() => {});
      this.n = 0; this.time = 0; this.maxS = 5;
      this.role = null;
      // --- TX ---
      this.seq = []; this.segIdx = -1; this.segType = 'idle'; this.segLeft = 0; this.segN = 0;
      this.txSymR = new Float64Array(SPAN + 1); this.txSymI = new Float64Array(SPAN + 1);
      this.txPh = 0; this.txCar = 0; this.txPos = 0;
      this.txS = 0; this.txSPending = 0; this.txAnn = 0; this.txFs = FS; this.guardLeft = 0;
      this.txRate = 0; this.txRatePending = 0; this.txP = null; this.trnCount = 0; this.inData = false;
      this.enc = new V34.Encoder(); this.txFrame = new Int16Array(16);
      this.txBitFn = () => this.txScr(this.inData ? this.hdlcNextBit() : 1);
      this.txSr = 0; this.txTap = 18;
      this.tb = new Uint8Array(8192); this.tbPos = 0; this.tbLen = 0;
      // --- RX front end ---
      this.zr = new Float64Array(2 * NTAPS); this.zi = new Float64Array(2 * NTAPS);
      this.zp = 0; this.rxCar = 0; this.qcnt = 0;
      this.qr = new Float64Array(RING); this.qi = new Float64Array(RING); this.tq = 0;
      this.cand = null;
      // --- equalizer / symbol clock ---
      this.wr = new Float64Array(NT); this.wi = new Float64Array(NT);
      this.xr = new Float64Array(NT); this.xi = new Float64Array(NT);
      this.xp = 0; this.yr = 0; this.yi = 0;
      this.snapR = new Float64Array(NT); this.snapI = new Float64Array(NT); this.snapOk = false;
      this.locked = false; this.rxPos = 0; this.nextSymT = 0;
      this.peakSeen = false; this.missCount = 0; this.fresh = true;
      this.syncErr = 0; this.syncCnt = 0;
      this.mseEma = -1; this.mseHist = []; this.goodSf = 0; this.resyncs = 0;
      this.modeYr = new Float64Array(MODE_LEN); this.modeYi = new Float64Array(MODE_LEN);
      this.rxS = 0; this.rxNextS = 0; this.rxRate = -1; this.rxP = null; this.rxSr = 0; this.rxTap = 5;
      this.switching = false; this.everLocked = false; this.hunt = 0;
      this.dec = new V34.Decoder((b) => this.rxDescr(b), FRAMES);
      this.pts = [];
      // --- HDLC RX ---
      this.hOnes = 0; this.hIn = false; this.hBits = new Uint8Array(4096); this.hN = 0;
      this.hBuf = new Uint8Array(512);
      // --- link ---
      this.txData = []; this.unacked = []; this.resendIdx = 0;
      this.vs = 0; this.va = 0; this.vr = 0; this.ackPending = false;
      this.rxWant = -1; this.peerForS = -1; this.rateForS = -1; this.expectS = -1; this.rateReq = false; this.rateToken = 0; this.rateReqSentAt = -9;
      this.rateAckPending = null; this.rateAcked = false; this.peerRate = false; this.connected = false;
      this.stat = { framesOk: 0, fcsErr: 0, retx: 0 };
      // --- tone detector ---
      this.g1 = 0; this.g2 = 0; this.gE = 0; this.gN = 0; this.ansCount = 0; this.ansOff = 0;
      this.ansDetected = false; this.ansEnded = false;
    }

    now() { return this.time; }

    txScr(bit) {
      const s = this.txSr, o = bit ^ ((s >> (this.txTap - 1)) & 1) ^ ((s >> 22) & 1);
      this.txSr = ((s << 1) | o) & 0x7fffff;
      return o;
    }

    rxDescr(bit) {
      const s = this.rxSr;
      this.rxSr = ((s << 1) | bit) & 0x7fffff;
      this.hdlcRxBit(bit ^ ((s >> (this.rxTap - 1)) & 1) ^ ((s >> 22) & 1));
    }

    start(role, maxS) {
      this.role = role;
      if (maxS >= 0 && maxS <= 5) this.maxS = maxS;
      this.txTap = role === 'call' ? 18 : 5;
      this.rxTap = role === 'call' ? 5 : 18;
      this.seq = role === 'answer'
        ? [['sil', 0.4], ['ansam', 2.0], ['sil', 0.075], ['tone', 0.5, 2400], ['sil', 0.05], ['qam', 0]]
        : [['wait', 0], ['sil', 0.1], ['tone', 0.5, 1200], ['sil', 0.05], ['qam', 0]];
      this.segIdx = -1;
      this.nextSeg();
    }

    send(bytes) { for (let i = 0; i < bytes.length; i++) this.txData.push(bytes[i]); }

    process(inp, out) { // テスト用: 送受信を同じクロックで回す
      const len = out.length;
      for (let i = 0; i < len; i++) {
        this.rxSample(inp ? inp[i] : 0);
        out[i] = this.txSample();
        this.n++; this.time += 1 / this.txFs;
      }
    }

    // 送信はローカルクロックで、受信は回線からサンプルが届いた時に進める
    txBlock(out, len) { for (let i = 0; i < len; i++) { out[i] = this.txSample(); this.n++; this.time += 1 / this.txFs; } }
    rxBlock(inp, len) { for (let i = 0; i < len; i++) this.rxSample(inp[i]); }

    // ================= TX =================
    nextSeg() {
      const s = this.seq[++this.segIdx];
      this.segType = s[0]; this.segLeft = Math.round(s[1] * FS); this.segN = 0; this.segF = s[2] || 0;
      if (s[0] === 'qam') { this.txPos = 0; this.txPh = 0; this.trnCount = 0; this.inData = false; this.txSr = 0; }
      this.onEvent({ type: 'tx', phase: s[0] === 'tone' ? (s[2] === 2400 ? 'toneA' : 'toneB') : s[0] === 'qam' ? 'trn' : s[0] });
    }

    txSample() {
      let o = 0;
      switch (this.segType) {
        case 'idle': return 0;
        case 'qam': return this.qamSample();
        case 'wait':
          if (this.ansEnded || this.locked) this.nextSeg();
          return 0;
        case 'tone': {
          const half = (this.segN + this.segLeft) >> 1; // 中間で位相反転
          o = 0.2 * (this.segN >= half ? -1 : 1) * Math.sin(2 * Math.PI * this.segF * this.segN / FS);
          break;
        }
        case 'ansam': {
          const rev = Math.floor(this.segN / (0.45 * FS)) & 1 ? -1 : 1;
          o = 0.2 * rev * (1 + 0.2 * Math.sin(2 * Math.PI * 15 * this.segN / FS)) *
            Math.sin(2 * Math.PI * 2100 * this.segN / FS);
          break;
        }
      }
      this.segN++;
      if (--this.segLeft <= 0) this.nextSeg();
      return o;
    }

    qamSample() {
      const sr = this.txSymR, si = this.txSymI;
      if (this.txPh === 0) {
        for (let k = SPAN; k > 0; k--) { sr[k] = sr[k - 1]; si[k] = si[k - 1]; }
        this.nextSymbol();
      }
      let xr = 0, xi = 0;
      for (let k = 0, idx = this.txPh; idx < NTAPS; k++, idx += SPS) {
        xr += sr[k] * RRC[idx]; xi += si[k] * RRC[idx];
      }
      const car = CARS[this.txS];
      const o = TXG * (xr * car.cos[this.txCar] - xi * car.sin[this.txCar]);
      this.txCar = (this.txCar + 1) % car.n;
      this.txPh = (this.txPh + 1) % SPS;
      return o;
    }

    nextSymbol() {
      if (this.guardLeft > 0) { // シンボルレート切り替え前の無音。終わったら搬送波と回線レートを替える
        this.txSymR[0] = 0; this.txSymI[0] = 0;
        if (--this.guardLeft === 0) { this.txS = this.txAnn; this.txCar = 0; this.txFs = 4 * SYMRATE[this.txS]; }
        return;
      }
      const pos = this.txPos;
      if (pos === 0) {
        if (!this.inData) {
          if (this.trnCount >= 3) { this.inData = true; this.onEvent({ type: 'tx', phase: 'data' }); }
          else this.trnCount++;
        }
        this.txRate = this.inData ? validRate(this.txS, this.txRatePending) : 0;
        this.txP = this.txRate ? V34.params(this.txS, this.txRate) : null;
        if (this.txP) { this.enc.configure(this.txP); this.enc.resetFrames(); }
        this.txAnn = this.inData ? Math.min(this.txSPending, this.maxS) : this.txS; // 次のコンテナのシンボルレート
      }
      if (pos < SYNC_LEN) { this.txSymR[0] = SYNC_R[pos]; this.txSymI[0] = SYNC_I[pos]; }
      else if (pos < HDR) {
        const k = pos - SYNC_LEN, nib = k < 8 ? this.txRate : this.txAnn;
        const w = H8[nib & 7][k & 7] * (nib & 8 ? -1 : 1) * Math.SQRT1_2;
        this.txSymR[0] = w; this.txSymI[0] = w;
      } else if (this.txP) { // V.34 データモード: マッピングフレーム単位で符号化
        const fi = (pos - HDR) & 7;
        if (fi === 0) this.enc.frame(this.txBitFn, this.txFrame);
        this.txSymR[0] = this.txFrame[2 * fi] * this.txP.scale; this.txSymI[0] = this.txFrame[2 * fi + 1] * this.txP.scale;
      } else { // 無符号化 4 点 (TRN と交渉用)
        const c = CONST[0], v = (this.txBitFn() << 1) | this.txBitFn();
        this.txSymR[0] = c.re[v]; this.txSymI[0] = c.im[v];
      }
      if (pos === SF_LEN - 1) { this.txPos = 0; if (this.txAnn !== this.txS) this.guardLeft = GUARD; } else this.txPos = pos + 1;
    }

    // ---- HDLC TX ----
    hdlcNextBit() {
      if (this.tbPos >= this.tbLen) this.loadFrame();
      return this.tb[this.tbPos++];
    }

    pushFlag() {
      const tb = this.tb;
      tb[this.tbLen++] = 0;
      for (let i = 0; i < 6; i++) tb[this.tbLen++] = 1;
      tb[this.tbLen++] = 0;
    }

    loadFrame() {
      this.tbPos = 0; this.tbLen = 0;
      this.pushFlag();
      const f = this.nextFrame();
      if (!f) return;
      const len = f.length;
      const buf = new Uint8Array(len + 2);
      buf.set(f);
      const c = crc16(buf, len);
      buf[len] = c & 0xff; buf[len + 1] = c >> 8;
      let ones = 0;
      const tb = this.tb;
      for (let i = 0; i < len + 2; i++) {
        for (let k = 0; k < 8; k++) {
          const b = (buf[i] >> k) & 1;
          tb[this.tbLen++] = b;
          if (b) { if (++ones === 5) { tb[this.tbLen++] = 0; ones = 0; } } else ones = 0;
        }
      }
      this.pushFlag();
    }

    // ---- link layer (go-back-N) ----
    nextFrame() {
      const now = this.now();
      if (this.rateAckPending !== null) {
        const t = this.rateAckPending; this.rateAckPending = null;
        return [T_RACK, t, this.vr, Math.min(this.txSPending, this.maxS)];
      }
      if (this.rateReq && now - this.rateReqSentAt > 0.7) {
        this.rateReqSentAt = now;
        return [T_RATE, this.rateToken, this.vr, this.rxWant, this.maxS, this.rateForS];
      }
      const un = this.unacked;
      if (un.length && this.resendIdx >= un.length && now - un[0].sentAt > RTO) {
        this.resendIdx = 0; this.stat.retx++;
      }
      if (this.resendIdx < un.length) {
        const u = un[this.resendIdx++];
        u.sentAt = now; this.ackPending = false;
        return [T_I, u.ns, this.vr].concat(u.data);
      }
      if (un.length < WINDOW && this.txData.length) {
        const u = { ns: this.vs, data: this.txData.splice(0, MAX_INFO), sentAt: now };
        this.vs = (this.vs + 1) & 255;
        un.push(u); this.resendIdx = un.length; this.ackPending = false;
        return [T_I, u.ns, this.vr].concat(u.data);
      }
      if (this.ackPending) { this.ackPending = false; return [T_RR, 0, this.vr]; }
      return null;
    }

    onFrame(buf, len) {
      const type = buf[0], ns = buf[1], nr = buf[2];
      let k = (nr - this.va) & 255;
      if (k <= this.unacked.length) {
        while (k-- > 0) {
          this.unacked.shift(); this.va = (this.va + 1) & 255;
          if (this.resendIdx > 0) this.resendIdx--;
        }
      }
      if (type === T_I) {
        if (ns === this.vr) {
          this.vr = (this.vr + 1) & 255;
          this.onEvent({ type: 'data', bytes: Array.prototype.slice.call(buf, 3, len) });
        }
        this.ackPending = true;
      } else if (type === T_RATE && len >= 6) {
        this.txRatePending = Math.min(14, buf[3]);
        this.txSPending = Math.min(5, buf[4]);
        this.peerForS = buf[5];
        this.rateAckPending = ns;
        this.peerRate = true;
        this.linkCheck();
      } else if (type === T_RACK && len >= 4) {
        this.expectS = Math.min(5, buf[3]); // 相手が実際に使うシンボルレート
        if (ns === this.rateToken && this.rateReq) { this.rateReq = false; this.rateAcked = true; }
        this.linkCheck();
      }
    }

    // 双方向とも「シンボルレート切り替え済み + そのレートで選んだ速度が合意済み」になったら接続完了
    linkCheck() {
      const txTarget = Math.min(this.txSPending, this.maxS);
      if (!(this.rateAcked && this.peerRate && this.rxS === this.expectS && this.rateForS === this.rxS && this.txS === txTarget && this.peerForS === this.txS)) return;
      const tx = bpsOf(this.txS, validRate(this.txS, this.txRatePending)), rx = bpsOf(this.rxS, this.rxWant);
      if (this.connected && tx === this.lastTx && rx === this.lastRx) return;
      this.lastTx = tx; this.lastRx = rx;
      const ev = { type: this.connected ? 'rate' : 'connect', txBps: tx, rxBps: rx, txBaud: V34.RATES[this.txS].name, rxBaud: V34.RATES[this.rxS].name };
      this.connected = true;
      this.onEvent(ev);
    }

    // ================= RX =================
    rxSample(s) {
      // 2100 Hz 検出 (Goertzel, 10 ms ブロック)
      if (!this.ansEnded) {
        const g0 = s + GCOEF * this.g1 - this.g2;
        this.g2 = this.g1; this.g1 = g0; this.gE += s * s;
        if (++this.gN === GN) {
          const p = this.g1 * this.g1 + this.g2 * this.g2 - GCOEF * this.g1 * this.g2;
          const hit = this.gE > 0.01 && p > 0.5 * (GN / 2) * this.gE;
          this.g1 = this.g2 = this.gE = 0; this.gN = 0;
          if (!this.ansDetected) {
            if (hit) { if (++this.ansCount >= 25) { this.ansDetected = true; this.onEvent({ type: 'ansam' }); } }
            else if (this.ansCount > 0) this.ansCount -= 2;
          } else if (hit) this.ansOff = 0;
          else if (++this.ansOff >= 4) this.ansEnded = true;
        }
      }
      // ダウンコンバート + 整合フィルタ (T/4 ごとに出力)
      const c = this.rxCar;
      const car = CARS[this.rxS];
      const zr = 2 / TXG * s * car.cos[c], zi = -2 / TXG * s * car.sin[c];
      this.rxCar = (c + 1) % car.n;
      const p = this.zp;
      this.zr[p] = this.zr[p + NTAPS] = zr; this.zi[p] = this.zi[p + NTAPS] = zi;
      this.zp = (p + 1) % NTAPS;
      if (++this.qcnt < Q) return;
      this.qcnt = 0;
      let mr = 0, mi = 0;
      const ZR = this.zr, ZI = this.zi, base = this.zp;
      for (let k = 0; k < NTAPS; k++) { mr += ZR[base + k] * RRC[k]; mi += ZI[base + k] * RRC[k]; }
      const t = ++this.tq;
      this.qr[t & MASK] = mr; this.qi[t & MASK] = mi;
      this.correlate(t);
      // 切り替え後や同期喪失後に見つからなければ、他のシンボルレートも順に探す
      if (this.locked) this.hunt = 0;
      else if (this.everLocked && ++this.hunt > 6 * SF_LEN) { this.hunt = 0; this.rxS = (this.rxS + 1) % 6; this.rxCar = 0; }
      while (this.locked && t >= this.nextSymT + LOOKAHEAD) { this.processSymbol(); this.nextSymT += 4; }
    }

    correlate(t) {
      const qr = this.qr, qi = this.qi;
      let cr = 0, ci = 0, e = 0;
      for (let i = 0; i < SYNC_LEN; i++) {
        const idx = (t - 4 * (SYNC_LEN - 1 - i)) & MASK;
        const a = qr[idx], b = qi[idx];
        cr += a * SYNC_R[i] + b * SYNC_I[i];
        ci += b * SYNC_R[i] - a * SYNC_I[i];
        e += a * a + b * b;
      }
      if (e > 0.03) {
        const m = (cr * cr + ci * ci) / (SYNC_LEN * e);
        if (m > SYNC_THR && (!this.cand || m > this.cand.m)) {
          this.cand = { m, t, cr: cr / SYNC_LEN, ci: ci / SYNC_LEN, first: this.cand ? this.cand.first : t };
        }
      }
      if (this.cand && t - this.cand.first >= 3) { const c = this.cand; this.cand = null; this.onPeak(c); }
    }

    onPeak(pk) {
      const sfStart = pk.t - 4 * (SYNC_LEN - 1);
      if (this.locked) {
        let d = (sfStart - (this.nextSymT - 4 * this.rxPos)) % (4 * SF_LEN);
        if (d < 0) d += 4 * SF_LEN;
        if (d > 2 * SF_LEN) d -= 4 * SF_LEN;
        const bad = this.syncCnt >= 8 && this.syncErr / this.syncCnt > this.badThr();
        if (Math.abs(d) <= 1 && !bad) { this.peakSeen = true; return; }
        this.resyncs++;
      } else {
        if (!this.switching) this.onEvent({ type: 'carrier', on: true });
        this.switching = false; this.everLocked = true;
      }
      this.dec.restart(); this.rxRate = -1; // 復号をやり直す
      // (再)同期: 「中央タップ初期化」と「直前の良好なタップを位相補正したもの」を
      // それぞれ同期語でトレーニングし、誤差の小さい方を採用する
      const avail = Math.min(SYNC_LEN, Math.floor((this.tq - LOOKAHEAD - sfStart) / 4) + 1);
      const g2 = pk.cr * pk.cr + pk.ci * pk.ci;
      this.wr.fill(0); this.wi.fill(0);
      this.wr[CENTER] = pk.cr / g2; this.wi[CENTER] = -pk.ci / g2;
      const eA = this.trainSync(sfStart, avail, true);
      if (this.snapOk) { // 良好だった時のタップに位相補正だけ掛けたもの。十分合っていればこちらを使う
        const ar = Float64Array.from(this.wr), ai = Float64Array.from(this.wi);
        let nr = 0, ni = 0, den = 0;
        this.wr.set(this.snapR); this.wi.set(this.snapI);
        for (let k = 0; k < avail; k++) {
          this.eqOut(sfStart + 4 * k);
          nr += SYNC_R[k] * this.yr + SYNC_I[k] * this.yi;
          ni += SYNC_I[k] * this.yr - SYNC_R[k] * this.yi;
          den += this.yr * this.yr + this.yi * this.yi;
        }
        nr /= den + 1e-12; ni /= den + 1e-12;
        for (let j = 0; j < NT; j++) {
          const a = this.snapR[j], b = this.snapI[j];
          this.wr[j] = a * nr - b * ni; this.wi[j] = a * ni + b * nr;
        }
        if (this.trainSync(sfStart, avail, false) > 1.5 * eA + 0.005) { this.wr.set(ar); this.wi.set(ai); }
      }
      this.locked = true; this.rxPos = 0; this.nextSymT = sfStart;
      this.peakSeen = true; this.missCount = 0; this.fresh = true;
      this.syncErr = 0; this.syncCnt = 0;
      this.hIn = false; this.hOnes = 0;
    }

    // 同期語での平均二乗誤差を返す (train なら先に数回学習する)。無音の区間は数えない
    trainSync(sfStart, avail, train) {
      for (let pass = 0; train && pass < 8; pass++) {
        for (let k = 0; k < avail; k++) {
          this.eqOut(sfStart + 4 * k);
          this.eqUpdate(SYNC_R[k] - this.yr, SYNC_I[k] - this.yi, 0.2);
        }
      }
      let e = 0, n = 0;
      for (let k = 0; k < avail; k++) {
        this.eqOut(sfStart + 4 * k);
        if (this.xp < 2) continue;
        const er = SYNC_R[k] - this.yr, ei = SYNC_I[k] - this.yi;
        e += er * er + ei * ei; n++;
      }
      return n ? e / n : 1;
    }

    // 同期語の誤差がこれを超えたら等化器が壊れたとみなす
    badThr() { return this.mseEma > 0 ? Math.min(0.25, Math.max(0.06, 4 * this.mseEma)) : 0.25; }

    eqOut(tSym) {
      const qr = this.qr, qi = this.qi, wr = this.wr, wi = this.wi, xr = this.xr, xi = this.xi;
      let yr = 0, yi = 0, p = 0;
      const base = tSym - 2 * CENTER;
      for (let j = 0; j < NT; j++) {
        const idx = (base + 2 * j) & MASK;
        const a = qr[idx], b = qi[idx];
        xr[j] = a; xi[j] = b;
        yr += wr[j] * a - wi[j] * b; yi += wr[j] * b + wi[j] * a;
        p += a * a + b * b;
      }
      this.yr = yr; this.yi = yi; this.xp = p;
    }

    eqUpdate(er, ei, mu) {
      if (this.xp < 2) return; // 無音区間 (パケット欠落) では適応しない
      const g = mu / (this.xp + 1e-9), wr = this.wr, wi = this.wi, xr = this.xr, xi = this.xi;
      for (let j = 0; j < NT; j++) {
        wr[j] += g * (er * xr[j] + ei * xi[j]);
        wi[j] += g * (ei * xr[j] - er * xi[j]);
      }
    }

    processSymbol() {
      const pos = this.rxPos;
      if (pos === SYNC_LEN) {
        if (this.peakSeen) this.missCount = 0;
        else if (++this.missCount >= 3) {
          this.locked = false; this.mseEma = -1; this.mseHist = []; this.goodSf = 0; this.dec.restart(); this.rxRate = -1;
          this.onEvent({ type: 'carrier', on: false });
          return;
        }
        this.peakSeen = false;
        if (!this.fresh && this.syncCnt === SYNC_LEN && this.syncErr / SYNC_LEN < 0.02) {
          this.snapR.set(this.wr); this.snapI.set(this.wi); this.snapOk = true;
        }
      }
      this.eqOut(this.nextSymT);
      const yr = this.yr, yi = this.yi;
      if (pos < SYNC_LEN) {
        if (pos === 0) { this.syncErr = 0; this.syncCnt = 0; }
        const er = SYNC_R[pos] - yr, ei = SYNC_I[pos] - yi;
        if (this.xp >= 2) { this.syncErr += er * er + ei * ei; this.syncCnt++; } // 欠落パケットの無音は数えない
        this.eqUpdate(er, ei, this.fresh ? 0.3 : 0.05);
      } else if (pos < HDR) {
        const k = pos - SYNC_LEN;
        this.modeYr[k] = yr; this.modeYi[k] = yi;
        const dr = yr >= 0 ? Math.SQRT1_2 : -Math.SQRT1_2, di = yi >= 0 ? Math.SQRT1_2 : -Math.SQRT1_2;
        this.eqUpdate(dr - yr, di - yi, 0.02);
        if (k === MODE_LEN - 1) this.onHeader();
      } else if (this.rxP) { // V.34 データモード: ビタビ復号器へ
        const g = this.rxP.scale, ur = yr / g, ui = yi / g;
        this.dec.push(ur, ui);
        // 等化器の追従は仮判定 (最寄りの奇数格子点) でごく弱く行う。主な適応は同期語
        this.eqUpdate((2 * Math.round((ur - 1) / 2) + 1) * g - yr, (2 * Math.round((ui - 1) / 2) + 1) * g - yi, 0.005);
        if ((pos & 7) === 0) this.pts.push(yr, yi);
      } else {
        const c = CONST[0];
        const ii = yr >= 0 ? 1 : 0, iq = yi >= 0 ? 1 : 0;
        this.eqUpdate((2 * ii - 1) * c.norm - yr, (2 * iq - 1) * c.norm - yi, 0.02);
        this.rxDescr(ii); this.rxDescr(iq);
        if ((pos & 7) === 0) this.pts.push(yr, yi);
      }
      if (pos === SF_LEN - 1) { this.endSuperframe(); this.rxPos = 0; } else this.rxPos = pos + 1;
    }

    onHeader() { // ヘッダ: このコンテナのデータレートと、次のコンテナのシンボルレート
      const nib = [0, 0];
      let sure = true;
      for (let h = 0; h < 2; h++) {
        let best = 0, bi = 0;
        for (let i = 0; i < 8; i++) {
          let acc = 0;
          for (let j = 0; j < 8; j++) acc += (this.modeYr[h * 8 + j] + this.modeYi[h * 8 + j]) * H8[i][j];
          if (Math.abs(acc) > Math.abs(best)) { best = acc; bi = i; }
        }
        nib[h] = bi | (best < 0 ? 8 : 0);
        if (Math.abs(best) < 0.6 * 8 * Math.SQRT2) sure = false; // 無音や壊れた受信では信用しない
      }
      let rate = this.rxRate < 0 ? 0 : this.rxRate, nextS = this.rxS;
      if (sure && nib[0] <= 14 && nib[1] <= 5 && (nib[0] === 0 || V34.params(this.rxS, nib[0]))) { rate = nib[0]; nextS = nib[1]; }
      else if (this.rxRate < 0) sure = false;
      if (rate !== this.rxRate) {
        if (this.rxRate > 0) this.dec.flush(); // 前のレートの未確定分を出し切る
        this.dec.restart();
        this.rxP = rate ? V34.params(this.rxS, rate) : null;
        if (this.rxP) this.dec.configure(this.rxP);
        this.rxRate = rate;
      }
      this.rxNextS = nextS;
    }

    endSuperframe() {
      const mse = this.syncErr / Math.max(1, this.syncCnt);
      if (!this.fresh && mse < this.badThr()) {
        // 直近 5 スーパーフレームの中央値 (単発の外れ値で速度を落とさない)
        this.mseHist.push(mse); if (this.mseHist.length > 5) this.mseHist.shift();
        this.mseEma = this.mseHist.slice().sort((a, b) => a - b)[this.mseHist.length >> 1];
        this.goodSf++;
      }
      this.fresh = false;
      const snr = this.mseEma > 0 ? -10 * Math.log10(this.mseEma) : 0;
      if (this.goodSf >= 3) {
        const S = this.rxS;
        let want = 0;
        for (let n = 14; n >= 1; n--) {
          if (!V34.params(S, n)) continue;
          const need = 3.01 * (2400 * n / SYMRATE[S]) + SNR_MARGIN - (n <= this.rxWant ? SNR_HYST : 0);
          if (snr >= need) { want = n; break; }
        }
        if (want !== this.rxWant || this.rateForS !== S) {
          this.rxWant = want; this.rateForS = S; this.rateReq = true; this.rateAcked = false;
          this.rateToken = (this.rateToken + 1) & 255; this.rateReqSentAt = -9;
        }
      }
      this.onEvent({
        type: 'stats', snr, rxBps: bpsOf(this.rxS, Math.max(0, this.rxRate)), txBps: bpsOf(this.txS, this.txRate),
        rxBaud: V34.RATES[this.rxS].name, txBaud: V34.RATES[this.txS].name,
        pts: this.pts, resyncs: this.resyncs, framesOk: this.stat.framesOk, fcsErr: this.stat.fcsErr,
        retx: this.stat.retx, queued: this.txData.length,
      });
      this.linkCheck();
      if (this.rxNextS !== this.rxS) { // 相手がシンボルレートを替える: 無音の間に搬送波を替えて同期語を探し直す
        if (this.rxRate > 0) this.dec.flush();
        this.rxRate = -1; this.rxS = this.rxNextS; this.rxCar = 0;
        this.locked = false; this.switching = true; this.cand = null;
      }
      this.pts = [];
    }

    // ---- HDLC RX ----
    hdlcRxBit(b) {
      if (b) {
        if (++this.hOnes >= 7) { this.hIn = false; return; }
        if (this.hIn) { if (this.hN < 4096) this.hBits[this.hN++] = 1; else this.hIn = false; }
        return;
      }
      const ones = this.hOnes; this.hOnes = 0;
      if (ones === 5) return; // スタッフビット
      if (ones === 6) {       // フラグ
        if (this.hIn) {
          const nb = this.hN - 7;
          if (nb >= 40 && (nb & 7) === 0) {
            const len = nb >> 3, buf = this.hBuf, bits = this.hBits;
            for (let i = 0; i < len; i++) {
              let v = 0;
              for (let k = 0; k < 8; k++) v |= bits[i * 8 + k] << k;
              buf[i] = v;
            }
            const c = crc16(buf, len - 2);
            if (buf[len - 2] === (c & 0xff) && buf[len - 1] === (c >> 8)) {
              this.stat.framesOk++; this.onFrame(buf, len - 2);
            } else this.stat.fcsErr++;
          } else if (nb > 8) this.stat.fcsErr++;
        }
        this.hIn = true; this.hN = 0;
        return;
      }
      if (this.hIn) { if (this.hN < 4096) this.hBits[this.hN++] = 0; else this.hIn = false; }
    }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { Modem, FS };

  if (typeof AudioWorkletProcessor !== 'undefined') {
    // スピーカー用: 9600 Hz のサンプル列を再生レートへ線形補間で引き上げるリング
    class MonRing {
      constructor(step) { this.step = step; this.buf = new Float32Array(8192); this.w = 0; this.r = 0; this.run = false; }
      push(x, len) { for (let i = 0; i < len; i++) { this.buf[this.w & 8191] = x[i]; this.w++; } }
      read() {
        const fill = this.w - this.r;
        if (!this.run) { if (fill < 600) return 0; this.run = true; }      // 約 60 ms ためてから再生
        if (fill < 2) { this.run = false; return 0; }
        if (fill > 4000) this.r = this.w - 600;                             // 遅れすぎたら追いつく
        const i = Math.floor(this.r), f = this.r - i;
        this.r += this.step;
        return this.buf[i & 8191] * (1 - f) + this.buf[(i + 1) & 8191] * f;
      }
    }

    // 回線は「サンプルをそのまま運ぶデータチャネル」。受信側は届いたサンプルを順に処理するだけで、
    // 再生クロックを持たない。欠落パケットは同じ長さの無音で埋めるので、時間軸は伸縮しない。
    class ModemProcessor extends AudioWorkletProcessor {
      constructor() {
        super();
        this.m = null;
        this.acc = 0;
        this.tmp = new Float32Array(256); this.rxf = new Float32Array(PKT);
        this.pkt = new Int16Array(PKT); this.pn = 0; this.txSeq = 0;
        this.rxSeq = -1; this.lost = 0;
        this.monTx = new MonRing(FS / sampleRate); this.monRx = new MonRing(FS / sampleRate);
        this.port.onmessage = (e) => {
          const d = e.data;
          if (d.type === 'start') {
            this.m = new Modem((ev) => { if (ev.type === 'stats') ev.lost = this.lost; this.port.postMessage(ev); });
            this.m.start(d.role, d.maxS);
          } else if (d.type === 'pkt' && this.m) { this.monRx.step = 4 * SYMRATE[d.s % 6] / sampleRate; this.onPacket(d.seq, new Int16Array(d.buf)); }
          else if (d.type === 'send' && this.m) this.m.send(d.bytes);
          else if (d.type === 'stop') this.m = null;
        };
      }

      onPacket(seq, pcm) {
        if (pcm.length !== PKT) return;
        if (this.rxSeq >= 0) {
          let gap = seq - this.rxSeq;
          if (gap <= 0) return;                 // 遅れて届いたものは捨てる (既に無音で埋めた)
          if (gap > 1) {
            this.lost += gap - 1;
            this.rxf.fill(0);
            for (gap = Math.min(gap - 1, 100); gap > 0; gap--) { this.m.rxBlock(this.rxf, PKT); this.monRx.push(this.rxf, PKT); }
          }
        }
        this.rxSeq = seq;
        for (let i = 0; i < PKT; i++) this.rxf[i] = pcm[i] / 32768;
        this.m.rxBlock(this.rxf, PKT);
        this.monRx.push(this.rxf, PKT);
      }

      process(inputs, outputs) {
        const out = outputs[0][0];
        if (!this.m || !out) return true;
        this.monTx.step = this.m.txFs / sampleRate;
        this.acc += out.length * this.monTx.step;
        const k = Math.floor(this.acc); this.acc -= k;
        this.m.txBlock(this.tmp, k);
        this.monTx.push(this.tmp, k);
        for (let i = 0; i < k; i++) {
          const v = Math.max(-1, Math.min(1, this.tmp[i]));
          this.pkt[this.pn++] = Math.round(v * 32767);
          if (this.pn === PKT) {
            const buf = this.pkt.buffer.slice(0);
            this.port.postMessage({ type: 'pkt', seq: this.txSeq++, s: this.m.txS, buf }, [buf]);
            this.pn = 0;
          }
        }
        for (let i = 0; i < out.length; i++) out[i] = this.monTx.read() + this.monRx.read();
        return true;
      }
    }
    registerProcessor('v34ish-modem', ModemProcessor);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
