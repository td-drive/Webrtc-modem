/*
 * V.34 の起動手順: フェーズ 1 (V.8) とフェーズ 2 (回線プロービング)。9600 Hz で動く。
 *
 * フェーズ 1 (V.8):
 *   応答側 ANSam → 発呼側 CM (V.21 低群 FSK 300 bps) → 応答側 JM (V.21 高群) → 発呼側 CJ
 * フェーズ 2 (V.34 11.2.1):
 *   INFO0c / INFO0a (600 bps DPSK、搬送波 1200 / 2400 Hz)
 *   トーン B / A と位相反転による往復遅延の測定
 *   L1 / L2 回線プロービング信号 (150 Hz 間隔のトーン群)
 *   INFO1c / INFO1a でシンボルレートを決定
 *
 * メッセージのビット配置は SpanDSP の v8.c / v34tx.c (仕様の項目を引用したコメント付き) を参考にした。
 * 往復遅延は送信サンプル数を時計にして測る。ブラウザでは受信がパケット単位 (20 ms) でまとめて届き、
 * 音声コールバックもまとまって呼ばれるので、測定値は数十 ms の誤差を持つ目安にしかならない。
 * L1/L2 は送出するだけで、受信側の周波数特性の解析はしていない (回線がデジタルで平坦なため)。
 */
(function (root) {
  'use strict';
  const V34 = root.V34 || (typeof require !== 'undefined' ? require('./v34-map.js') : null);
  const FS = 9600, TWO_PI = 2 * Math.PI;
  const ms = (x) => Math.round(x * FS / 1000);

  // ---------- V.21 FSK (300 bps、1 ビット 32 サンプル) ----------
  const V21 = { low: { mark: 980, space: 1180 }, high: { mark: 1650, space: 1850 } };
  const BIT = 32;
  const LAT = 41; // 位相反転の送出から検出までの固定遅れ (往復分、サンプル数。遅延 0 の回線で較正)

  class FskTx {
    constructor(ch) { this.ch = ch; this.q = []; this.ph = 0; this.n = 0; this.bit = 1; this.on = false; }
    octets(list) { for (const o of list) { this.q.push(0); for (let i = 0; i < 8; i++) this.q.push((o >> i) & 1); this.q.push(1); } }
    ones(n) { for (let i = 0; i < n; i++) this.q.push(1); }
    sample() {
      if (!this.on) return 0;
      if (this.n === 0) this.bit = this.q.length ? this.q.shift() : 1;
      this.n = (this.n + 1) % BIT;
      this.ph += TWO_PI * (this.bit ? this.ch.mark : this.ch.space) / FS;
      return 0.2 * Math.sin(this.ph);
    }
  }

  class FskRx {
    constructor(ch, onOctet) {
      this.onOctet = onOctet; this.buf = new Float32Array(BIT); this.p = 0; this.tick = 0;
      this.tab = [ch.mark, ch.space].map((f) => {
        const c = new Float64Array(BIT), s = new Float64Array(BIT);
        for (let i = 0; i < BIT; i++) { c[i] = Math.cos(TWO_PI * f * i / FS); s[i] = Math.sin(TWO_PI * f * i / FS); }
        return { c, s };
      });
      this.state = 0; this.cnt = 0; this.nbits = 0; this.val = 0;
    }
    sample(x) {
      this.buf[this.p] = x; this.p = (this.p + 1) % BIT;
      if (++this.tick < 4) return;
      this.tick = 0;
      let e = 0;
      const en = [0, 0];
      for (let k = 0; k < 2; k++) {
        let re = 0, im = 0;
        const { c, s } = this.tab[k];
        for (let i = 0; i < BIT; i++) { const v = this.buf[(this.p + i) % BIT]; re += v * c[i]; im += v * s[i]; if (k === 0) e += v * v; }
        en[k] = re * re + im * im;
      }
      const present = e > 0.02 && (en[0] + en[1]) > 0.5 * (BIT / 2) * e;
      const bit = en[0] >= en[1] ? 1 : 0;
      // 調歩同期: スタートビットの立ち下がりから 1 ビット (8 tick) ごとに読む
      if (this.state === 0) { if (present && bit === 0) { this.state = 1; this.cnt = 0; } }
      else if (this.state === 1) {
        if (++this.cnt === 4) { if (bit !== 0 || !present) this.state = 0; else { this.state = 2; this.cnt = 0; this.nbits = 0; this.val = 0; } }
      } else if (++this.cnt === 8) {
        this.cnt = 0;
        if (this.nbits < 8) this.val |= bit << this.nbits++;
        else { this.state = 0; if (bit === 1) this.onOctet(this.val); }
      }
    }
  }

  // ---------- 600 bps DPSK (INFO 系列とトーン A/B)。1 ボー 16 サンプル ----------
  const BAUD = 16;
  const HANN = new Float64Array(2 * BAUD);
  for (let i = 0; i < 2 * BAUD; i++) HANN[i] = 0.5 - 0.5 * Math.cos(TWO_PI * (i + 0.5) / (2 * BAUD));

  class CcTx {
    constructor(freq, nextBit) { this.w = TWO_PI * freq / FS; this.nextBit = nextBit; this.on = false; this.reset(); }
    reset() { this.n = 0; this.t = 0; this.cur = 1; this.prev = 1; }
    restartBaud() { this.n = 0; } // 位相反転のタイミング合わせ用 (トーン送出中だけ使う)
    sample() {
      if (!this.on) return 0;
      if (this.n === 0) { this.prev = this.cur; if (this.nextBit()) this.cur = -this.cur; } // ビット 1 = 位相反転
      const a = this.prev * HANN[this.n + BAUD] + this.cur * HANN[this.n]; // ボー境界をなめらかにつなぐ
      this.n = (this.n + 1) % BAUD;
      return 0.2 * a * Math.cos(this.w * this.t++);
    }
  }

  function crc16(bits, from, to) { // x^16 + x^12 + x^5 + 1、初期値全 1、送出順に計算
    let c = 0xffff;
    for (let i = from; i <= to; i++) { const fb = (c ^ bits[i]) & 1; c >>>= 1; if (fb) c ^= 0x8408; }
    return c;
  }
  const SYNC12 = 0xf72; // 1111 + 01110010 (送出順)

  class CcRx {
    constructor(freq, ev) {
      this.ev = ev; this.w = TWO_PI * freq / FS; this.t = 0;
      this.zr = new Float64Array(BAUD); this.zi = new Float64Array(BAUD); this.x2 = new Float64Array(BAUD);
      this.cr = new Float64Array(BAUD); this.ci = new Float64Array(BAUD); // 1 ボー前の相関値
      this.sr = 0; this.si = 0; this.se = 0;
      this.present = false; this.run = 0; this.lock = 0; this.mute = 0;
      this.hist = new Int32Array(BAUD); this.cap = []; for (let i = 0; i < BAUD; i++) this.cap.push(null);
      this.payloadEnd = 28; // 期待する INFO 系列の最終データビット番号
    }
    sample(x) {
      const p = this.t % BAUD, a = this.w * this.t;
      const zr = x * Math.cos(a), zi = -x * Math.sin(a);
      this.sr += zr - this.zr[p]; this.si += zi - this.zi[p]; this.se += x * x - this.x2[p];
      this.zr[p] = zr; this.zi[p] = zi; this.x2[p] = x * x;
      if (p === 0) { let r = 0, i = 0, e = 0; for (let k = 0; k < BAUD; k++) { r += this.zr[k]; i += this.zi[k]; e += this.x2[k]; } this.sr = r; this.si = i; this.se = e; } // 丸め誤差の蓄積を消す
      const m2 = this.sr * this.sr + this.si * this.si;
      const q = this.se > 0.002 ? m2 / (8 * this.se) : 0; // 純音なら 1
      const dot = this.sr * this.cr[p] + this.si * this.ci[p];
      const prev2 = this.cr[p] * this.cr[p] + this.ci[p] * this.ci[p];
      this.cr[p] = this.sr; this.ci[p] = this.si;
      // トーンの有無
      if (q > 0.5) { if (this.run < 0) this.run = 0; if (++this.run === 64 && !this.present) { this.present = true; this.ev('tone', true, this.t); } }
      else if (q < 0.3) { if (this.run > 0) this.run = 0; if (--this.run === -64 && this.present) { this.present = false; this.ev('tone', false, this.t); } }
      // 位相反転
      if (this.lock > 0) this.lock--;
      else if (this.present && q > 0.5 && dot < -0.3 * Math.sqrt(m2 * prev2)) { this.lock = 48; this.ev('reversal', true, this.t); }
      // INFO 系列: 16 通りのボー位相それぞれでビット列を追い、CRC が合ったものを採る
      if (this.mute > 0) this.mute--;
      else {
        const bit = dot < 0 ? 1 : 0;
        const c = this.cap[p];
        if (c) {
          c.push(bit);
          if (c.length === this.payloadEnd + 17) {
            this.cap[p] = null;
            const crc = crc16(c, 12, this.payloadEnd);
            let got = 0;
            for (let i = 0; i < 16; i++) got |= c[this.payloadEnd + 1 + i] << i;
            if (crc === got) { this.mute = 320; this.cap.fill(null); this.hist.fill(0); this.ev('info', c, this.t); }
          }
        } else {
          this.hist[p] = ((this.hist[p] << 1) | bit) & 0xfff;
          if (this.hist[p] === SYNC12 && q > 0.3) this.cap[p] = [1, 1, 1, 1, 0, 1, 1, 1, 0, 0, 1, 0];
        }
      }
      this.t++;
    }
  }

  // ---------- L1 / L2 プロービング信号 (V.34 10.1.2.4) ----------
  const PROBE = new Float64Array(64); // 150 Hz の倍数なので 64 サンプル周期
  (function () {
    const tones = [[150, 0], [300, 1], [450, 0], [600, 0], [750, 0], [1050, 0], [1350, 0], [1500, 0], [1650, 1], [1950, 0], [2100, 0],
      [2250, 1], [2550, 0], [2700, 1], [2850, 0], [3000, 1], [3150, 1], [3300, 1], [3450, 1], [3600, 0], [3750, 0]]; // 900/1200/1800/2400 は欠番
    let e = 0;
    for (let i = 0; i < 64; i++) { let x = 0; for (const [f, inv] of tones) x += Math.cos(TWO_PI * f * i / FS + (inv ? Math.PI : 0)); PROBE[i] = x; e += x * x; }
    const k = 0.07 / Math.sqrt(e / 64); // L2 の実効値
    for (let i = 0; i < 64; i++) PROBE[i] *= k;
  })();

  // ---------- INFO 系列の組み立てと解釈 ----------
  function infoBits(fields, payloadEnd) {
    const b = [1, 1, 1, 1, 0, 1, 1, 1, 0, 0, 1, 0];
    for (const [v, n] of fields) for (let i = 0; i < n; i++) b.push((v >> i) & 1);
    if (b.length !== payloadEnd + 1) throw new Error('INFO length');
    const crc = crc16(b, 12, payloadEnd);
    for (let i = 0; i < 16; i++) b.push((crc >> i) & 1);
    b.push(1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0); // 末尾のフィル + トーンに戻る前の余白
    return b;
  }
  const field = (b, from, n) => { let v = 0; for (let i = 0; i < n; i++) v |= b[from + i] << i; return v; };
  const maxRate = (S) => { let n = 14; while (n > 0 && !V34.params(S, n)) n--; return n; };

  function info0(maxS) { // 対応シンボルレート (搬送波は高い方だけ使う)
    const sup = (i) => (i <= maxS ? 1 : 0);
    return infoBits([[sup(1), 1], [sup(2), 1], [sup(5), 1], [0, 1], [sup(3), 1], [0, 1], [sup(4), 1], [sup(5), 1],
      [0, 1], [0, 3], [0, 1], [1, 1], [0, 2], [0, 1]], 28);
  }
  function parseInfo0(b) {
    const s = [true, !!b[12], !!b[13], !!(b[15] || b[16]), !!(b[17] || b[18]), !!(b[14] && b[19])];
    return { supports: s };
  }
  function info1c(rates) { // rates[i]: シンボルレート i で見込める最大データレート (2400 bps 単位、0 = 使えない)
    const f = [[0, 3], [0, 3], [0, 7]];
    for (let i = 0; i < 6; i++) f.push([1, 1], [0, 4], [rates[i], 4]);
    f.push([0, 10]);
    return infoBits(f, 88);
  }
  function parseInfo1c(b) { const r = []; for (let i = 0; i < 6; i++) r.push(field(b, 25 + 9 * i + 5, 4)); return { rates: r }; }
  function info1a(S) { return infoBits([[0, 3], [0, 3], [0, 7], [1, 1], [0, 4], [maxRate(S), 4], [S, 3], [S, 3], [0, 10]], 49); }
  function parseInfo1a(b) { return { sAC: field(b, 34, 3), sCA: field(b, 37, 3) }; }

  // V.8 の CM / JM: 同期 0xE0、呼機能 = V シリーズデータ (0xC1)、変調 = V.34 全二重 (0x45 + 拡張 2 個)、プロトコル = LAPM (0x2A)
  const CM = [0xe0, 0xc1, 0x45, 0x10, 0x10, 0x2a];

  class Startup {
    constructor(role, maxS, onEvent) {
      this.role = role; this.maxS = maxS; this.onEvent = onEvent;
      this.t = 0; this.done = false; this.failed = false; this.S = 0; this.rtd = -1;
      this.state = ''; this.since = 0; this.bauds = 0; this.bits = []; this.probeN = 0; this.probeGain = 0;
      this.msg = []; this.lastMsg = ''; this.zeros = 0; this.gotMsg = false; this.gotCj = false;
      this.peer0 = null; this.peer1 = null; this.tInfo = -1e9; this.tRev = 0; this.tone = false; this.revAt = -1; this.toneOffAt = 0;
      this.ansamN = 0; this.g1 = 0; this.g2 = 0; this.gE = 0; this.gN = 0; this.ansCount = 0; this.ansSeen = false;
      const call = role === 'call';
      this.fskTx = new FskTx(call ? V21.low : V21.high);
      this.fskRx = new FskRx(call ? V21.high : V21.low, (o) => this.onOctet(o));
      this.ccTx = new CcTx(call ? 1200 : 2400, () => this.ccBit());
      this.ccRx = new CcRx(call ? 2400 : 1200, (type, v, t) => this.onCc(type, v));
      this.go(call ? 'c:wait-ansam' : 'a:pre');
    }

    go(state) {
      this.state = state; this.since = this.t; this.bauds = 0;
      const s = state.slice(2);
      const probe = s === 'L1' || s === 'L2';
      this.ccTx.on = ['info0', 'tone1', 'rev1', 'tone2', 'tone3', 'rev3', 'tone4', 'info1', 'rev1b', 'tail'].includes(s);
      if (s === 'info0') { this.ccTx.reset(); this.bits = info0(this.maxS); this.ccRx.payloadEnd = 28; }
      if (s === 'tone3' || s === 'tone4') this.ccTx.reset();
      if (probe) { this.probeGain = s === 'L1' ? 2 : 1; if (s === 'L1') this.probeN = 0; } else this.probeGain = 0;
      const label = { 'a:ansam': 'ansam', 'c:cm': 'cm', 'a:jm': 'jm', 'c:cj': 'cj', 'c:info0': 'info0', 'a:info0': 'info0', 'a:L1': 'probe', 'c:L1': 'probe', 'c:info1': 'info1', 'a:info1': 'info1' }[state];
      if (label) this.onEvent({ type: 'hs', step: label });
    }

    fail(why) { if (!this.done) { this.done = true; this.failed = true; this.onEvent({ type: 'fail', reason: why }); } }
    finish(S) { this.S = S; this.done = true; this.onEvent({ type: 'hs', step: 'phase2-done', baud: V34.RATES[S].name, rtd: this.rtd }); }

    // ---- 受信 ----
    rx(x) {
      if (this.done) return;
      if (this.role === 'call' && !this.ansSeen) this.detectAnsam(x);
      this.fskRx.sample(x);
      this.ccRx.sample(x);
    }

    detectAnsam(x) { // 2100 Hz を 10 ms ブロックの Goertzel で検出
      const k = 2 * Math.cos(TWO_PI * 2100 / FS), g0 = x + k * this.g1 - this.g2;
      this.g2 = this.g1; this.g1 = g0; this.gE += x * x;
      if (++this.gN < 96) return;
      const p = this.g1 * this.g1 + this.g2 * this.g2 - k * this.g1 * this.g2;
      const hit = this.gE > 0.01 && p > 0.5 * 48 * this.gE;
      this.g1 = this.g2 = this.gE = 0; this.gN = 0;
      if (hit) { if (++this.ansCount >= 40) { this.ansSeen = true; this.onEvent({ type: 'ansam' }); } } else if (this.ansCount > 0) this.ansCount -= 2;
    }

    onOctet(o) { // CM / JM は同じ内容が 2 回続けて届いたら採用。CJ は 0x00 が 3 個
      if (o === 0) { if (++this.zeros >= 3) this.gotCj = true; } else this.zeros = 0;
      if (o === 0xe0) {
        const m = this.msg.join(',');
        if (this.msg.length >= 3 && m === this.lastMsg) {
          if (this.msg[1] !== 0xc1 || (this.msg[2] & 0x5f) !== 0x45) return this.fail('相手が V.34 に対応していません');
          this.gotMsg = true;
        }
        this.lastMsg = m; this.msg = [o];
      } else if (this.msg.length && this.msg.length < 16) this.msg.push(o);
    }

    onCc(type, v) {
      if (type === 'tone') { this.tone = v; if (!v) this.toneOffAt = this.t; }
      else if (type === 'reversal') { if (this.t - this.tInfo > 160) this.revAt = this.t; } // INFO 系列中の反転は無視
      else if (type === 'info') {
        this.tInfo = this.t;
        if (this.ccRx.payloadEnd === 28) this.peer0 = parseInfo0(v);
        else this.peer1 = this.role === 'call' ? parseInfo1a(v) : parseInfo1c(v);
      }
    }

    // 反転を 1 回だけ受け取る
    takeReversal() { if (this.revAt < 0) return -1; const t = this.revAt; this.revAt = -1; return t; }

    // ---- 600 bps 側の次のビット (トーン送出中は 0、位相反転は 1) ----
    ccBit() {
      this.bauds++;
      const s = this.state.slice(2);
      if (s === 'info0' || s === 'info1') {
        if (this.bits.length) return this.bits.shift();
        if (s === 'info0') this.go(this.state[0] + ':tone1'); else this.go(this.state[0] + ':post');
        return 0;
      }
      if (this.pendingRev) { this.pendingRev = false; this.tRev = this.t; return 1; }
      return 0;
    }

    // 40 ms 後ちょうどに反転を返すため、ボーの刻みを検出時刻に合わせ直す
    answerReversalIn40ms(next) { this.ccTx.restartBaud(); this.go(next); }

    // ---- 送信 (1 サンプルごとに状態も進める) ----
    tx() {
      if (this.done) return 0;
      const el = this.t - this.since, st = this.state;
      let o = 0;
      switch (st) {
        // ===== 応答側 =====
        case 'a:pre': if (el >= ms(200)) this.go('a:ansam'); break;
        case 'a:ansam': { // ANSam: 2100 Hz、15 Hz で 20% 振幅変調、450 ms ごとに位相反転
          const n = this.ansamN++;
          o = 0.2 * (Math.floor(n / ms(450)) & 1 ? -1 : 1) * (1 + 0.2 * Math.sin(TWO_PI * 15 * n / FS)) * Math.sin(TWO_PI * 2100 * n / FS);
          if (this.gotMsg) { this.gotMsg = false; this.go('a:gap1'); } else if (el > ms(6000)) this.fail('CM を受信できません');
          break;
        }
        case 'a:gap1': if (el >= ms(75)) { this.fskTx.on = true; this.fskTx.ones(10); this.go('a:jm'); } break;
        case 'a:jm':
          if (this.fskTx.q.length < 10) { this.fskTx.octets(CM); this.fskTx.ones(10); }
          if (this.gotCj) { this.fskTx.on = false; this.go('a:gap2'); } else if (el > ms(5000)) this.fail('CJ を受信できません');
          break;
        case 'a:gap2': if (el >= ms(75)) this.go('a:info0'); break;
        case 'a:tone1': // トーン A を 50 ms 以上、INFO0c を受け取るまで
          if (this.bauds >= 30 && this.peer0) { this.pendingRev = true; this.revAt = -1; this.go('a:rev1'); } else if (el > ms(4000)) this.fail('INFO0c を受信できません');
          break;
        case 'a:rev1': { // 相手 (トーン B) の反転を待ち、往復遅延を測る
          const t = this.takeReversal();
          if (t >= 0 && !this.pendingRev) { this.rtd = Math.max(0, (t - this.tRev - ms(40) - LAT) * 1000 / FS); this.answerReversalIn40ms('a:tone2'); }
          else if (el > ms(3000)) this.fail('トーン B の位相反転がありません');
          break;
        }
        case 'a:tone2': if (this.bauds === 24) this.pendingRev = true; if (this.bauds >= 31) this.go('a:L1'); break; // 40 ms 後に反転、さらに 10 ms
        case 'a:L1': if (el >= ms(160)) this.go('a:L2'); break;
        case 'a:L2': if (this.tone && el >= ms(100)) { this.revAt = -1; this.go('a:tone3'); } else if (el > ms(1500)) this.fail('トーン B がありません'); break;
        case 'a:tone3': { // 2 回目のやり取り: 相手の反転から 40 ms 後に反転を返す
          const t = this.takeReversal();
          if (t >= 0) this.answerReversalIn40ms('a:rev3'); else if (el > ms(3000)) this.fail('トーン B の位相反転がありません');
          break;
        }
        case 'a:rev3': if (this.bauds === 24) this.pendingRev = true; if (this.bauds >= 31) { this.ccRx.payloadEnd = 88; this.peer1 = null; this.go('a:listen'); } break;
        case 'a:listen': // 相手の L1/L2 を受ける間は無音。トーン B が止んでから 460 ms 後にトーン A
          if (!this.tone && this.t - Math.max(this.toneOffAt, this.since) >= ms(460)) this.go('a:tone4'); else if (el > ms(3000)) this.fail('L1/L2 が終わりません');
          break;
        case 'a:tone4':
          if (this.peer1) {
            let S = 0;
            for (let i = 0; i <= this.maxS; i++) if (this.peer1.rates[i] > 0 && this.peer0.supports[i]) S = i;
            this.S = S; this.bits = info1a(S); this.go('a:info1');
          } else if (el > ms(4000)) this.fail('INFO1c を受信できません');
          break;
        case 'a:post': if (el >= ms(70)) this.finish(this.S); break;

        // ===== 発呼側 =====
        case 'c:wait-ansam': if (this.ansSeen) { this.fskTx.on = true; this.fskTx.ones(10); this.go('c:cm'); } else if (el > ms(15000)) this.fail('応答トーンがありません'); break;
        case 'c:cm':
          if (this.fskTx.q.length < 10) {
            if (this.gotMsg) { this.fskTx.octets([0, 0, 0]); this.go('c:cj'); } // JM を 2 回確認 → CJ
            else { this.fskTx.octets(CM); this.fskTx.ones(10); }
          }
          if (el > ms(8000)) this.fail('JM を受信できません');
          break;
        case 'c:cj': if (!this.fskTx.q.length && this.fskTx.n === 0) { this.fskTx.on = false; this.go('c:gap'); } break;
        case 'c:gap': if (el >= ms(75)) this.go('c:info0'); break;
        case 'c:tone1': { // トーン B。INFO0a を受け、トーン A の反転を見たら 40 ms 後に反転を返す
          const t = this.takeReversal();
          if (t >= 0 && this.peer0) this.answerReversalIn40ms('c:rev1'); else if (el > ms(5000)) this.fail('INFO0a / トーン A の反転がありません');
          break;
        }
        case 'c:rev1': if (this.bauds === 24) { this.pendingRev = true; this.revAt = -1; } if (this.bauds >= 31) this.go('c:sil1'); break;
        case 'c:sil1': { // 無音で相手の 2 回目の反転を待つ → 往復遅延
          const t = this.takeReversal();
          if (t >= 0) { this.rtd = Math.max(0, (t - this.tRev - ms(40) - LAT) * 1000 / FS); this.go('c:listen'); } else if (el > ms(3000)) this.fail('トーン A の位相反転がありません');
          break;
        }
        case 'c:listen': if (el >= ms(400)) { this.revAt = -1; this.go('c:tone3'); } break; // 相手の L1 (160 ms) と L2 を受ける
        case 'c:tone3': // トーン B を出し、相手がトーン A に切り替えたら反転
          if (this.tone && this.bauds >= 30) { this.pendingRev = true; this.go('c:rev1b'); } else if (el > ms(3000)) this.fail('トーン A がありません');
          break;
        case 'c:rev1b': { const t = this.takeReversal(); if (t >= 0 && !this.pendingRev) this.go('c:tail'); else if (el > ms(3000)) this.fail('トーン A の位相反転がありません'); break; }
        case 'c:tail': if (el >= ms(10)) { this.ccRx.payloadEnd = 49; this.peer1 = null; this.go('c:L1'); } break;
        case 'c:L1': if (el >= ms(160)) this.go('c:L2'); break;
        case 'c:L2': // 相手がトーン A を出したら INFO1c
          if (this.tone && el >= ms(100)) {
            const r = [];
            for (let i = 0; i < 6; i++) r.push(i <= this.maxS && this.peer0.supports[i] ? maxRate(i) : 0);
            this.ccTx.reset(); this.bits = info1c(r); this.go('c:info1');
          } else if (el > ms(1500)) this.fail('トーン A がありません');
          break;
        case 'c:post': if (this.peer1) this.finish(Math.min(5, this.peer1.sCA)); else if (el > ms(3000)) this.fail('INFO1a を受信できません'); break;
      }
      if (this.fskTx.on) o = this.fskTx.sample();
      else if (this.ccTx.on) o = this.ccTx.sample();
      else if (this.probeGain) o = this.probeGain * PROBE[this.probeN++ & 63];
      this.t++;
      return o;
    }
  }

  const api = { Startup, FS };
  root.V34Startup = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
