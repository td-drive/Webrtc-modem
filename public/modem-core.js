/*
 * V.34 風ソフトモデム (PHY + HDLC + 簡易 LAPM)。
 * DOM 非依存。AudioWorklet と Node (テスト) の両方で動く。
 *
 * V.34 から借りているもの:
 *   - シンボルレート 2400 baud / 搬送波 1800 Hz
 *   - 自己同期スクランブラ (発呼 1+x^-18+x^-23, 応答 1+x^-5+x^-23)
 *   - ANSam 応答トーン (2100 Hz, 15 Hz AM, 450 ms 位相反転), トーン A/B
 *   - TRN (スクランブルした 1 の 4 点信号) による等化器トレーニング
 * V.34 と違うもの:
 *   - シェルマッピング / トレリス符号 / プリコーディング / 回線プロービングなし
 *   - 0.5 秒ごとに同期語を挿入するスーパーフレーム構造 (パケット欠落後の復帰用)
 * 回線は WebRTC DataChannel で 9600 Hz / 16 bit のサンプル列をそのまま運ぶ。
 */
(function (root) {
  'use strict';

  const FS = 9600, BAUD = 2400, SPS = 4, Q = 1; // Q: T/4 あたりのサンプル数
  const CAR_N = 16;                // 1800 Hz は 16 サンプルで 3 周期
  const GN = FS / 100, GCOEF = 2 * Math.cos(2 * Math.PI * 2100 / FS); // 2100 Hz 検出 (10 ms ブロック)
  const TXG = 0.4;                 // 送信レベル (16 bit でクリップしないよう下げる)
  const PKT = 192;                 // 回線パケット: 20 ms
  const ALPHA = 0.25, SPAN = 8, NTAPS = SPAN * SPS + 1;
  const SF_LEN = 1200, SYNC_LEN = 32, MODE_LEN = 8, HDR = SYNC_LEN + MODE_LEN;
  const PAYLOAD = SF_LEN - HDR;
  const MODE_BITS = [2, 4, 6, 8];  // QPSK, 16/64/256-QAM
  const SNR_UP = [-99, 21, 27.5, 33.5], SNR_HYST = 2.5;
  const NT = 16, CENTER = 8, LOOKAHEAD = 2 * (NT - 1 - CENTER);
  const RING = 2048, MASK = RING - 1;
  const SYNC_THR = 0.6;
  const WINDOW = 8, RTO = 1.5, MAX_INFO = 64;
  const T_I = 1, T_RR = 2, T_RATE = 3, T_RACK = 4;

  // ---- テーブル ----
  const COS = new Float64Array(CAR_N), SIN = new Float64Array(CAR_N);
  for (let i = 0; i < CAR_N; i++) {
    COS[i] = Math.cos(2 * Math.PI * 3 * i / CAR_N);
    SIN[i] = Math.sin(2 * Math.PI * 3 * i / CAR_N);
  }

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

  // 変調モード表示語: ±(1+j)/√2 の Walsh 符号
  const WALSH = [
    [1, 1, 1, 1, 1, 1, 1, 1], [1, -1, 1, -1, 1, -1, 1, -1],
    [1, 1, -1, -1, 1, 1, -1, -1], [1, -1, -1, 1, 1, -1, -1, 1],
  ];

  const CONST = MODE_BITS.map((b) => {
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
      this.n = 0;
      this.role = null;
      // --- TX ---
      this.seq = []; this.segIdx = -1; this.segType = 'idle'; this.segLeft = 0; this.segN = 0;
      this.txSymR = new Float64Array(SPAN + 1); this.txSymI = new Float64Array(SPAN + 1);
      this.txPh = 0; this.txCar = 0; this.txPos = 0;
      this.txMode = 0; this.txModePending = 0; this.trnCount = 0; this.inData = false;
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
      this.rxMode = 0; this.rxSr = 0; this.rxTap = 5;
      this.pts = [];
      // --- HDLC RX ---
      this.hOnes = 0; this.hIn = false; this.hBits = new Uint8Array(4096); this.hN = 0;
      this.hBuf = new Uint8Array(512);
      // --- link ---
      this.txData = []; this.unacked = []; this.resendIdx = 0;
      this.vs = 0; this.va = 0; this.vr = 0; this.ackPending = false;
      this.rxWant = -1; this.rateReq = false; this.rateToken = 0; this.rateReqSentAt = -9;
      this.rateAckPending = null; this.rateAcked = false; this.peerRate = false; this.connected = false;
      this.stat = { framesOk: 0, fcsErr: 0, retx: 0 };
      // --- tone detector ---
      this.g1 = 0; this.g2 = 0; this.gE = 0; this.gN = 0; this.ansCount = 0; this.ansOff = 0;
      this.ansDetected = false; this.ansEnded = false;
    }

    now() { return this.n / FS; }

    start(role) {
      this.role = role;
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
        this.n++;
      }
    }

    // 送信はローカルクロックで、受信は回線からサンプルが届いた時に進める
    txBlock(out, len) { for (let i = 0; i < len; i++) { out[i] = this.txSample(); this.n++; } }
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
      const o = TXG * (xr * COS[this.txCar] - xi * SIN[this.txCar]);
      this.txCar = (this.txCar + 1) % CAR_N;
      this.txPh = (this.txPh + 1) % SPS;
      return o;
    }

    nextSymbol() {
      const pos = this.txPos;
      if (pos === 0) {
        if (!this.inData) {
          if (this.trnCount >= 3) { this.inData = true; this.onEvent({ type: 'tx', phase: 'data' }); }
          else this.trnCount++;
        }
        this.txMode = this.inData ? this.txModePending : 0;
      }
      if (pos < SYNC_LEN) { this.txSymR[0] = SYNC_R[pos]; this.txSymI[0] = SYNC_I[pos]; }
      else if (pos < HDR) {
        const w = WALSH[this.txMode][pos - SYNC_LEN] * Math.SQRT1_2;
        this.txSymR[0] = w; this.txSymI[0] = w;
      } else {
        const c = CONST[this.txMode];
        let v = 0;
        for (let b = 0; b < c.bits; b++) {
          const bit = this.inData ? this.hdlcNextBit() : 1;
          const s = this.txSr;
          const o = bit ^ ((s >> (this.txTap - 1)) & 1) ^ ((s >> 22) & 1);
          this.txSr = ((s << 1) | o) & 0x7fffff;
          v = (v << 1) | o;
        }
        this.txSymR[0] = c.re[v]; this.txSymI[0] = c.im[v];
      }
      this.txPos = (pos + 1) % SF_LEN;
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
        return [T_RACK, t, this.vr];
      }
      if (this.rateReq && now - this.rateReqSentAt > 0.7) {
        this.rateReqSentAt = now;
        return [T_RATE, this.rateToken, this.vr, this.rxWant];
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
      } else if (type === T_RATE && len >= 4) {
        this.txModePending = Math.max(0, Math.min(3, buf[3]));
        this.rateAckPending = ns;
        this.peerRate = true;
        this.linkCheck();
      } else if (type === T_RACK) {
        if (ns === this.rateToken && this.rateReq) { this.rateReq = false; this.rateAcked = true; this.linkCheck(); }
      }
    }

    linkCheck() {
      if (!(this.rateAcked && this.peerRate)) return;
      const ev = {
        type: this.connected ? 'rate' : 'connect',
        txBps: MODE_BITS[this.txModePending] * BAUD, rxBps: MODE_BITS[Math.max(0, this.rxWant)] * BAUD,
      };
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
      const zr = 2 / TXG * s * COS[c], zi = -2 / TXG * s * SIN[c];
      this.rxCar = (c + 1) % CAR_N;
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
        this.onEvent({ type: 'carrier', on: true });
      }
      // (再)同期: 「中央タップ初期化」と「直前の良好なタップを位相補正したもの」を
      // それぞれ同期語でトレーニングし、誤差の小さい方を採用する
      const avail = Math.min(SYNC_LEN, Math.floor((this.tq - LOOKAHEAD - sfStart) / 4) + 1);
      const g2 = pk.cr * pk.cr + pk.ci * pk.ci;
      this.wr.fill(0); this.wi.fill(0);
      this.wr[CENTER] = pk.cr / g2; this.wi[CENTER] = -pk.ci / g2;
      let best = this.trainSync(sfStart, avail);
      if (this.snapOk) {
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
        if (this.trainSync(sfStart, avail) > best) { this.wr.set(ar); this.wi.set(ai); }
      }
      this.locked = true; this.rxPos = 0; this.nextSymT = sfStart;
      this.peakSeen = true; this.missCount = 0; this.fresh = true;
      this.syncErr = 0; this.syncCnt = 0;
      this.hIn = false; this.hOnes = 0;
    }

    trainSync(sfStart, avail) {
      for (let pass = 0; pass < 8; pass++) {
        for (let k = 0; k < avail; k++) {
          this.eqOut(sfStart + 4 * k);
          this.eqUpdate(SYNC_R[k] - this.yr, SYNC_I[k] - this.yi, 0.2);
        }
      }
      let e = 0;
      for (let k = 0; k < avail; k++) {
        this.eqOut(sfStart + 4 * k);
        const er = SYNC_R[k] - this.yr, ei = SYNC_I[k] - this.yi;
        e += er * er + ei * ei;
      }
      return e;
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
          this.locked = false; this.mseEma = -1; this.mseHist = []; this.goodSf = 0;
          this.onEvent({ type: 'carrier', on: false });
          return;
        }
        this.peakSeen = false;
        if (!this.fresh && this.syncErr / SYNC_LEN < 0.02) {
          this.snapR.set(this.wr); this.snapI.set(this.wi); this.snapOk = true;
        }
      }
      this.eqOut(this.nextSymT);
      const yr = this.yr, yi = this.yi;
      if (pos < SYNC_LEN) {
        if (pos === 0) { this.syncErr = 0; this.syncCnt = 0; }
        const er = SYNC_R[pos] - yr, ei = SYNC_I[pos] - yi;
        this.syncErr += er * er + ei * ei; this.syncCnt++;
        this.eqUpdate(er, ei, this.fresh ? 0.3 : 0.05);
      } else if (pos < HDR) {
        const k = pos - SYNC_LEN;
        this.modeYr[k] = yr; this.modeYi[k] = yi;
        const dr = yr >= 0 ? Math.SQRT1_2 : -Math.SQRT1_2, di = yi >= 0 ? Math.SQRT1_2 : -Math.SQRT1_2;
        this.eqUpdate(dr - yr, di - yi, 0.02);
        if (k === MODE_LEN - 1) {
          let best = -1e9, bm = 0;
          for (let m = 0; m < 4; m++) {
            let acc = 0;
            for (let i = 0; i < MODE_LEN; i++) acc += (this.modeYr[i] + this.modeYi[i]) * WALSH[m][i];
            if (acc > best) { best = acc; bm = m; }
          }
          this.rxMode = bm;
        }
      } else {
        const c = CONST[this.rxMode], L1 = c.L - 1;
        let ii = Math.round((yr / c.norm + L1) / 2), iq = Math.round((yi / c.norm + L1) / 2);
        ii = ii < 0 ? 0 : ii > L1 ? L1 : ii; iq = iq < 0 ? 0 : iq > L1 ? L1 : iq;
        this.eqUpdate((2 * ii - L1) * c.norm - yr, (2 * iq - L1) * c.norm - yi, 0.02);
        const v = ((ii ^ (ii >> 1)) << c.h) | (iq ^ (iq >> 1));
        for (let b = c.bits - 1; b >= 0; b--) {
          const bit = (v >> b) & 1, s = this.rxSr;
          const o = bit ^ ((s >> (this.rxTap - 1)) & 1) ^ ((s >> 22) & 1);
          this.rxSr = ((s << 1) | bit) & 0x7fffff;
          this.hdlcRxBit(o);
        }
        if ((pos & 7) === 0) this.pts.push(yr, yi);
      }
      if (pos === SF_LEN - 1) { this.endSuperframe(); this.rxPos = 0; } else this.rxPos = pos + 1;
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
        let want = Math.max(0, this.rxWant);
        while (want < 3 && snr >= SNR_UP[want + 1]) want++;
        while (want > 0 && snr < SNR_UP[want] - SNR_HYST) want--;
        if (want !== this.rxWant) {
          this.rxWant = want; this.rateReq = true; this.rateAcked = false;
          this.rateToken = (this.rateToken + 1) & 255; this.rateReqSentAt = -9;
        }
      }
      this.onEvent({
        type: 'stats', snr, rxBps: MODE_BITS[this.rxMode] * BAUD, txBps: MODE_BITS[this.txMode] * BAUD,
        pts: this.pts, resyncs: this.resyncs, framesOk: this.stat.framesOk, fcsErr: this.stat.fcsErr,
        retx: this.stat.retx, queued: this.txData.length,
      });
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
      constructor(step) { this.buf = new Float32Array(8192); this.w = 0; this.r = 0; this.step = step; this.run = false; }
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
        this.step = FS / sampleRate; this.acc = 0;
        this.tmp = new Float32Array(256); this.rxf = new Float32Array(PKT);
        this.pkt = new Int16Array(PKT); this.pn = 0; this.txSeq = 0;
        this.rxSeq = -1; this.lost = 0;
        this.monTx = new MonRing(this.step); this.monRx = new MonRing(this.step);
        this.port.onmessage = (e) => {
          const d = e.data;
          if (d.type === 'start') {
            this.m = new Modem((ev) => { if (ev.type === 'stats') ev.lost = this.lost; this.port.postMessage(ev); });
            this.m.start(d.role);
          } else if (d.type === 'pkt' && this.m) this.onPacket(d.seq, new Int16Array(d.buf));
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
        this.acc += out.length * this.step;
        const k = Math.floor(this.acc); this.acc -= k;
        this.m.txBlock(this.tmp, k);
        this.monTx.push(this.tmp, k);
        for (let i = 0; i < k; i++) {
          const v = Math.max(-1, Math.min(1, this.tmp[i]));
          this.pkt[this.pn++] = Math.round(v * 32767);
          if (this.pn === PKT) {
            const buf = this.pkt.buffer.slice(0);
            this.port.postMessage({ type: 'pkt', seq: this.txSeq++, buf }, [buf]);
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
