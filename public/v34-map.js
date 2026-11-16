/*
 * V.34 データモードの符号化・復号 (ITU-T V.34 9 節)。
 *   - マッピングフレーム (2D シンボル 8 個) へのビット分配と SWP (9.3)
 *   - シェルマッピング (9.4)、差動符号化 (9.5)、スーパーコンステレーション (9.1)
 *   - 16 状態 4 次元トレリス符号 (9.6.3)、スーパーフレーム同期ビット反転 V0
 *   - 受信側: 4 次元ビタビ復号と逆マッピング
 * プリコーディング係数は 0 (c = p = 0)、非線形符号化なし、補助チャネルなし。
 *
 * 表 (コンステレーション、シンボルレート別の b / M) は V.34 の Figure 5、Table 8、Table 10 の値。
 * 仕様書本文を参照できないため、解釈は SpanDSP (Steve Underwood) の v34tx.c / v34rx.c を参考にした。
 * 実機の V.34 モデムとの突き合わせはしていない。
 */
(function (root) {
  'use strict';

  // 1/4 スーパーコンステレーション 416 点 (re, im)。番号の小さい順に電力が小さい。
  const SC = new Int8Array([
    1,1,-3,1,1,-3,-3,-3,1,5,5,1,-3,5,5,-3,5,5,-7,1,1,-7,-7,-3,-3,-7,-7,5,5,-7,1,9,
    9,1,-3,9,9,-3,-7,-7,5,9,9,5,-11,1,1,-11,-7,9,-11,-3,9,-7,-3,-11,-11,5,5,-11,9,9,1,13,
    13,1,-11,-7,-7,-11,-3,13,13,-3,5,13,13,5,-11,9,9,-11,-7,13,13,-7,-15,1,1,-15,-15,-3,-3,-15,-11,-11,
    9,13,13,9,-15,5,5,-15,-15,-7,-7,-15,1,17,-11,13,17,1,13,-11,-3,17,17,-3,-15,9,9,-15,5,17,17,5,
    -7,17,13,13,17,-7,-15,-11,-11,-15,-19,1,1,-19,9,17,17,9,-19,-3,-3,-19,-19,5,5,-19,-15,13,13,-15,-11,17,
    -19,-7,17,-11,-7,-19,1,21,-19,9,21,1,9,-19,-3,21,21,-3,-15,-15,13,17,17,13,5,21,21,5,-19,-11,-11,-19,
    -7,21,21,-7,-15,17,17,-15,9,21,21,9,-19,13,-23,1,13,-19,1,-23,-23,-3,-3,-23,-23,5,5,-23,-11,21,21,-11,
    17,17,-23,-7,-7,-23,-19,-15,-15,-19,13,21,21,13,-23,9,9,-23,1,25,25,1,-3,25,25,-3,5,25,-19,17,25,5,
    -23,-11,17,-19,-11,-23,-15,21,21,-15,-7,25,25,-7,-23,13,13,-23,9,25,25,9,-19,-19,17,21,21,17,-27,1,1,-27,
    -27,-3,-3,-27,-11,25,25,-11,-27,5,-23,-15,-15,-23,5,-27,-27,-7,-7,-27,13,25,25,13,-19,21,21,-19,-27,9,9,-27,
    -23,17,17,-23,1,29,29,1,-3,29,-15,25,29,-3,-27,-11,25,-15,-11,-27,5,29,29,5,21,21,-7,29,29,-7,-23,-19,
    -19,-23,-27,13,13,-27,17,25,25,17,9,29,29,9,-27,-15,-15,-27,-11,29,-31,1,29,-11,1,-31,-23,21,-31,-3,21,-23,
    -3,-31,-19,25,-31,5,25,-19,5,-31,13,29,29,13,-31,-7,-7,-31,-27,17,17,-27,-31,9,9,-31,-23,-23,-15,29,21,25,
    25,21,29,-15,-31,-11,-11,-31,1,33,33,1,-27,-19,-19,-27,-3,33,33,-3,5,33,33,5,17,29,29,17,-31,13,13,-31,
    -7,33,33,-7,-23,25,25,-23,9,33,-27,21,33,9,21,-27,-31,-15,-15,-31,-19,29,29,-19,-11,33,33,-11,-35,1,1,-35,
    -35,-3,-3,-35,25,25,-31,17,-35,5,17,-31,5,-35,13,33,33,13,-27,-23,-23,-27,-35,-7,-7,-35,21,29,29,21,-35,9,
    9,-35,-15,33,33,-15,-31,-19,-19,-31,-35,-11,-11,-35,-27,25,25,-27,1,37,-23,29,37,1,29,-23,-3,37,17,33,33,17,
    37,-3,5,37,-35,13,37,5,13,-35,-31,21,21,-31,-7,37,37,-7,9,37,-19,33,37,9,-35,-15,33,-19,-15,-35,-27,-27,
    25,29,29,25,-11,37,37,-11,-31,-23,-23,-31,-35,17,17,-35,-39,1,1,-39,21,33,33,21,-39,-3,-3,-39,13,37,37,13,
    -39,5,5,-39,-27,29,-39,-7,29,-27,-7,-39,-31,25,-35,-19,25,-31,-19,-35,-15,37,37,-15,-39,9,9,-39,-23,33,33,-23,
    -39,-11,-11,-39,17,37,37,17,-35,21,21,-35,1,41,29,29,41,1,-3,41,-39,13,41,-3,-31,-27,-27,-31,13,-39,5,41,
    41,5,25,33,33,25,-7,41,-19,37,41,-7,37,-19,-39,-15,-15,-39,-35,-23,-23,-35,9,41,41,9,-11,41,-31,29,41,-11,
    29,-31,21,37,37,21,-39,17,17,-39,-27,33,33,-27,13,41,-35,25,41,13,-43,1,25,-35,1,-43,-43,-3,-3,-43,-43,5,
    5,-43,-39,-19,-19,-39,-23,37,-43,-7,37,-23,-7,-43,-15,41,41,-15,-31,-31,29,33,33,29,-43,9,9,-43,-35,-27,-27,-35,
    -39,21,21,-39,17,41,41,17,-43,-11,-11,-43,25,37,37,25,-43,13,13,-43,1,45,45,1,-3,45,45,-3,-19,41,41,-19,
    5,45,-31,33,45,5,-39,-23,33,-31,-23,-39,-35,29,29,-35,-7,45,45,-7,-43,-15,-15,-43,-27,37,37,-27,9,45,45,9,
  ]);

  // シンボルレート S = 2400·a/c、搬送波 = S·d/e (高い方)、J = スーパーフレームあたりデータフレーム数、
  // P = データフレームあたりマッピングフレーム数。b[n-1], M[n-1] はデータレート 2400·n bps 用 (0 は不可)。
  const RATES = [
    { name: 2400, a: 1, c: 1, d: 3, e: 4, J: 7, P: 12, b: [8, 16, 24, 32, 40, 48, 56, 64, 72, 0, 0, 0, 0, 0], M: [1, 2, 4, 7, 14, 14, 14, 14, 14, 0, 0, 0, 0, 0] },
    { name: 2743, a: 8, c: 7, d: 2, e: 3, J: 8, P: 12, b: [0, 14, 21, 28, 35, 42, 49, 56, 63, 70, 77, 0, 0, 0], M: [0, 2, 3, 5, 9, 17, 15, 14, 13, 12, 11, 0, 0, 0] },
    { name: 2800, a: 7, c: 6, d: 2, e: 3, J: 7, P: 14, b: [0, 14, 21, 28, 35, 42, 48, 55, 62, 69, 76, 0, 0, 0], M: [0, 2, 3, 5, 9, 17, 14, 13, 12, 11, 10, 0, 0, 0] },
    { name: 3000, a: 5, c: 4, d: 2, e: 3, J: 7, P: 15, b: [0, 13, 20, 26, 32, 39, 45, 52, 58, 64, 71, 77, 0, 0], M: [0, 2, 3, 4, 7, 13, 11, 10, 17, 14, 13, 11, 0, 0] },
    { name: 3200, a: 4, c: 3, d: 3, e: 5, J: 7, P: 16, b: [0, 12, 18, 24, 30, 36, 42, 48, 54, 60, 66, 72, 78, 0], M: [0, 1, 2, 4, 6, 10, 17, 14, 12, 10, 17, 14, 12, 0] },
    { name: 3429, a: 10, c: 7, d: 4, e: 7, J: 8, P: 15, b: [0, 12, 17, 23, 28, 34, 40, 45, 51, 56, 62, 68, 73, 79], M: [0, 1, 2, 3, 5, 8, 14, 11, 18, 14, 12, 10, 15, 13] },
  ];

  // 奇数格子点 (a, b) の属性表: 1/4 コンステレーション内の番号、回転数、2D サブセットラベル
  const G = 64, OFF = 63;
  const IDX = new Int16Array(G * G).fill(-1), ROT = new Uint8Array(G * G);
  const cell = (a, b) => ((a + OFF) >> 1) * G + ((b + OFF) >> 1);
  for (let i = 0; i < 416; i++) {
    let a = SC[2 * i], b = SC[2 * i + 1];
    for (let r = 0; r < 4; r++) { // 時計回りに 90° ずつ
      IDX[cell(a, b)] = i; ROT[cell(a, b)] = r;
      const t = a; a = b; b = -t;
    }
  }
  function label(a, b) { // 9.6.3.1: 2D サブセットラベル (3 bit)
    const x = (a ^ b) & 2;
    return (((a ^ b) & 4) ^ (x << 1)) | (a & 2) | (x >> 1);
  }
  // ラベルから回転数 (mod 4) が決まることを確認しつつ表にする
  const LROT = new Int8Array(8).fill(-1);
  for (let a = -7; a <= 7; a += 2) for (let b = -7; b <= 7; b += 2) {
    const r = [[0, 3], [1, 2]][((a & 3) === 1) ? 0 : 1][((b & 3) === 1) ? 0 : 1]; // (1,1)→0 (1,3)→1 (3,3)→2 (3,1)→3
    const l = label(a, b);
    if (LROT[l] >= 0 && LROT[l] !== r) throw new Error('label/rotation mismatch');
    LROT[l] = r;
  }

  // Table 13: 2 つの 2D ラベル → 畳み込み符号器への入力 Y4..Y1
  const CE = [
    [0, 0, 1, 1, 8, 8, 9, 9], [3, 2, 2, 3, 11, 10, 10, 11], [5, 5, 4, 4, 13, 13, 12, 12], [6, 7, 7, 6, 14, 15, 15, 14],
    [8, 8, 9, 9, 0, 0, 1, 1], [11, 10, 10, 11, 3, 2, 2, 3], [13, 13, 12, 12, 5, 5, 4, 4], [14, 15, 15, 14, 6, 7, 7, 6],
  ];
  // Figure 10: 16 状態符号器。次状態は Y2, Y1 だけで決まる
  const TR = new Uint8Array(16 * 4);
  for (let s = 0; s < 16; s++) for (let y = 0; y < 4; y++) {
    const t1 = s & 1, t2 = (s >> 1) & 1, t3 = (s >> 2) & 1, t4 = (s >> 3) & 1, y1 = y & 1, y2 = y >> 1;
    TR[s * 4 + y] = (t2 ^ y1) | ((t3 ^ y2) << 1) | ((t4 ^ t1 ^ y2) << 2) | (t1 << 3);
  }
  const V0_PATTERN = 0x5fee; // Table 12

  const shellCache = {};
  function shellTables(M) { // 9.4: g2, g4, z8
    if (shellCache[M]) return shellCache[M];
    const n = 8 * (M - 1) + 1, g2 = new Float64Array(n), g4 = new Float64Array(n), g8 = new Float64Array(n), z8 = new Float64Array(n + 1);
    for (let p = 0; p <= 2 * (M - 1); p++) g2[p] = M - Math.abs(p - M + 1);
    for (let p = 0; p < n; p++) { let s = 0; for (let k = 0; k <= p; k++) s += g2[k] * g2[p - k]; g4[p] = s; }
    for (let p = 0; p < n; p++) { let s = 0; for (let k = 0; k <= p; k++) s += g4[k] * g4[p - k]; g8[p] = s; }
    for (let p = 1; p <= n; p++) z8[p] = z8[p - 1] + g8[p - 1];
    return (shellCache[M] = { g2, g4, z8 });
  }

  const paramCache = {};
  // sIdx: シンボルレート番号 0..5、n: データレート 2400·n bps (1..14)。不可なら null
  function params(sIdx, n) {
    const key = sIdx * 16 + n;
    if (key in paramCache) return paramCache[key];
    const R = RATES[sIdx], b = n >= 1 && n <= 14 ? R.b[n - 1] : 0;
    if (!b) return (paramCache[key] = null);
    let k = 0, q = 0;
    if (b > 12) { k = b - 12; while (k >= 32) { k -= 8; q++; } }
    const M = R.M[n - 1], bps = 2400 * n;
    const p = { sIdx, n, bps, b, k, q, M, J: R.J, P: R.P, r: (bps * 28) / (R.J * 100) - (b - 1) * R.P, lq: M << q, scale: 1 };
    // 平均電力を固定の擬似乱数で実測して正規化係数にする (送受で同じ値になる)
    const enc = new Encoder(); enc.configure(p);
    let seed = 0x1234567, e = 0;
    const bit = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 9) & 1; };
    const out = new Int16Array(16), N = 1500;
    for (let i = 0; i < N; i++) { enc.frame(bit, out); for (let j = 0; j < 16; j++) e += out[j] * out[j]; }
    p.scale = 1 / Math.sqrt(e / (8 * N));
    return (paramCache[key] = p);
  }

  class Encoder {
    constructor() { this.p = null; this.z = 0; this.state = 0; this.y0 = 0; this.bits = new Uint8Array(96); this.mjk = new Int32Array(8); this.resetFrames(); }
    configure(p) { this.p = p; }
    resetFrames() { this.sCnt = 0; this.dataFrame = 0; this.superFrame = 0; this.v0pat = 0; }

    // マッピングフレーム 1 個分。getBit: スクランブル済みビットの供給元。out: (re, im) × 8 の整数格子点
    frame(getBit, out) {
      const p = this.p, bits = this.bits, mjk = this.mjk;
      let bb = p.b, kk = p.k;
      this.sCnt += p.r; // SWP: 高フレーム / 低フレームの切り替え
      if (this.sCnt >= p.P) this.sCnt -= p.P; else if (bb > 12) { bb--; kk--; }
      for (let i = 0; i < bb; i++) bits[i] = getBit();
      let pos = 0;
      const take = (n) => { let v = 0; for (let i = 0; i < n; i++) v += bits[pos++] * (1 << i); return v; }; // 先頭ビットが LSB
      const ib = [0, 0, 0, 0], qb = [0, 0, 0, 0, 0, 0, 0, 0];
      let r0 = 0;
      if (p.k) {
        r0 = take(kk);
        for (let i = 0; i < 4; i++) { ib[i] = take(3); if (p.q) { qb[2 * i] = take(p.q); qb[2 * i + 1] = take(p.q); } }
      } else {
        const n3 = bb - 8;
        for (let i = 0; i < 4; i++) ib[i] = take(i < n3 ? 3 : 2);
      }
      shellMap(r0, p.M, mjk);
      let u0 = 0, l0 = 0;
      for (let step = 0; step < 8; step++) {
        const mi = (mjk[step] << p.q) + qb[step];
        let a = SC[2 * mi], b = SC[2 * mi + 1], rot;
        if ((step & 1) === 0) {
          this.z = (this.z + (ib[step >> 1] >> 1)) & 3; // 差動符号化
          rot = this.z;
          const v0 = ((this.dataFrame * 8 + step) % (4 * p.P) === 0) ? (V0_PATTERN >> this.v0pat++) & 1 : 0;
          u0 = this.y0 ^ v0; // C0 はプリコーディングなしなので 0
        } else rot = (this.z + ((ib[step >> 1] & 1) << 1) + u0) & 3;
        for (; rot > 0; rot--) { const t = a; a = b; b = -t; }
        out[2 * step] = a; out[2 * step + 1] = b;
        if ((step & 1) === 0) l0 = label(a, b);
        else { this.y0 = this.state & 1; this.state = TR[this.state * 4 + (CE[l0][label(a, b)] & 3)]; }
      }
      if (++this.dataFrame >= p.P) { this.dataFrame = 0; if (++this.superFrame >= p.J) { this.superFrame = 0; this.v0pat = 0; } }
      return bb;
    }
  }

  function shellMap(r0, M, mjk) { // 式 9-8〜9-24
    if (M <= 1) { mjk.fill(0); return; }
    const { g2, g4, z8 } = shellTables(M);
    let A = 1; while (z8[A] <= r0) A++; A--;
    let t1 = 0, t2 = r0 - z8[A], B = -1;
    while (t2 >= 0) { B++; t1 = g4[B] * g4[A - B]; t2 -= t1; }
    const r1 = t2 + t1, r2 = r1 % g4[B], r3 = (r1 - r2) / g4[B];
    let C = -1; t2 = r2;
    while (t2 >= 0) { C++; t1 = g2[C] * g2[B - C]; t2 -= t1; }
    const r4 = t2 + t1;
    let D = -1; t2 = r3;
    while (t2 >= 0) { D++; t1 = g2[D] * g2[A - B - D]; t2 -= t1; }
    const r5 = t2 + t1;
    const e = r4 % g2[C], f = (r4 - e) / g2[C], g = r5 % g2[D], h = (r5 - g) / g2[D];
    const pair = (i, w, v) => { if (w < M) { mjk[i] = v; mjk[i + 1] = w - v; } else { mjk[i + 1] = M - 1 - v; mjk[i] = w - mjk[i + 1]; } };
    pair(0, C, e); pair(2, B - C, f); pair(4, D, g); pair(6, A - B - D, h);
  }

  function shellUnmap(M, m) {
    if (M <= 1) return 0;
    const { g2, g4, z8 } = shellTables(M);
    const n2 = (x, y) => (x < M - y ? x : M - 1 - y);
    const n21 = n2(m[6], m[7]), n22 = n2(m[4], m[5]), n23 = n2(m[2], m[3]), n24 = n2(m[0], m[1]);
    let w2 = m[4] + m[5];
    const w41 = w2 + m[6] + m[7];
    let n41 = n21 * g2[w2] + n22;
    for (let k = 0; k < w2; k++) n41 += g2[k] * g2[w41 - k];
    w2 = m[0] + m[1];
    const w42 = w2 + m[2] + m[3];
    let n42 = n23 * g2[w2] + n24;
    for (let k = 0; k < w2; k++) n42 += g2[k] * g2[w42 - k];
    const w8 = w41 + w42;
    let n8 = n41 * g4[w42] + n42;
    for (let k = 0; k < w42; k++) n8 += g4[k] * g4[w8 - k];
    return z8[w8] + n8;
  }

  const DEPTH = 24, HN = 32, BIG = 1e12;

  // 4 次元ビタビ復号 + 逆マッピング。container: 何マッピングフレームごとにフレームカウンタを戻すか
  class Decoder {
    constructor(putBit, container) {
      this.putBit = putBit; this.container = container; this.p = null;
      this.pm = new Float64Array(16); this.npm = new Float64Array(16);
      this.prev = new Uint8Array(HN * 16); this.grp = new Uint8Array(HN * 16);
      this.gp = new Int16Array(HN * 8 * 4);
      this.d = [new Float64Array(8), new Float64Array(8)];
      this.pt = [new Int16Array(16), new Int16Array(16)];
      this.gc = new Float64Array(8);
      this.m = new Int32Array(8); this.q = new Int32Array(8); this.ib = new Int32Array(4);
      this.restart();
    }
    configure(p) { this.p = p; }
    restart() { // 状態不明から復号をやり直す (未確定分は捨てる)
      this.pm.fill(0); this.t = 0; this.out = 0; this.half = 0;
      this.fDataFrame = 0; this.fSuper = 0; this.fV0 = 0; this.f4d = 0; this.fFrames = 0; // 受信位置側のカウンタ
      this.bCnt = 0; this.bFrames = 0; this.step = 0; this.w0 = 0;       // 逆マッピング側のカウンタ
    }
    // 2D シンボル 1 個 (整数格子の単位に正規化済み)
    push(yr, yi) {
      const h = this.half, d = this.d[h], pt = this.pt[h], lq = this.p.lq;
      d.fill(BIG);
      const a0 = 2 * Math.floor(yr / 2) + 1, b0 = 2 * Math.floor(yi / 2) + 1;
      for (let i = -2; i <= 2; i++) {
        const a = a0 + 2 * i;
        if (a < -OFF || a > OFF) continue;
        const da = (yr - a) * (yr - a);
        for (let j = -2; j <= 2; j++) {
          const b = b0 + 2 * j;
          if (b < -OFF || b > OFF) continue;
          const ix = IDX[cell(a, b)];
          if (ix < 0 || ix >= lq) continue; // コンステレーション外
          const e = da + (yi - b) * (yi - b), l = label(a, b);
          if (e < d[l]) { d[l] = e; pt[2 * l] = a; pt[2 * l + 1] = b; }
        }
      }
      this.half ^= 1;
      if (h === 0) return;
      // --- 4D シンボル 1 個分の ACS ---
      const p = this.p, gc = this.gc, d0 = this.d[0], d1 = this.d[1], p0 = this.pt[0], p1 = this.pt[1];
      const ti = this.t % HN, gp = this.gp, gbase = ti * 32;
      gc.fill(BIG);
      for (let l0 = 0; l0 < 8; l0++) {
        if (d0[l0] >= BIG) continue;
        for (let l1 = 0; l1 < 8; l1++) {
          const c = d0[l0] + d1[l1];
          const g = (((LROT[l1] - LROT[l0]) & 1) << 2) | (CE[l0][l1] & 3); // (U0, Y2Y1) ごとに最良の組を残す
          if (c < gc[g]) { gc[g] = c; const o = gbase + g * 4; gp[o] = p0[2 * l0]; gp[o + 1] = p0[2 * l0 + 1]; gp[o + 2] = p1[2 * l1]; gp[o + 3] = p1[2 * l1 + 1]; }
        }
      }
      const v0 = ((this.fDataFrame * 8 + this.f4d * 2) % (4 * p.P) === 0) ? (V0_PATTERN >> this.fV0++) & 1 : 0;
      if (++this.f4d === 4) {
        this.f4d = 0;
        if (++this.fFrames >= this.container) { this.fFrames = 0; this.fDataFrame = -1; this.fSuper = 0; this.fV0 = 0; }
        if (++this.fDataFrame >= p.P) { this.fDataFrame = 0; if (++this.fSuper >= p.J) { this.fSuper = 0; this.fV0 = 0; } }
      }
      const pm = this.pm, npm = this.npm, prev = this.prev, grp = this.grp;
      npm.fill(BIG * 4);
      for (let s = 0; s < 16; s++) {
        const u0 = ((s >> 3) ^ v0) & 1; // この状態から出られるのは U0 = Y0 ⊕ V0 の枝だけ
        for (let y = 0; y < 4; y++) {
          const g = (u0 << 2) | y, c = pm[s] + gc[g], ns = TR[s * 4 + y];
          if (c < npm[ns]) { npm[ns] = c; prev[ti * 16 + ns] = s; grp[ti * 16 + ns] = g; }
        }
      }
      let best = 0;
      for (let s = 1; s < 16; s++) if (npm[s] < npm[best]) best = s;
      const mn = npm[best];
      for (let s = 0; s < 16; s++) pm[s] = npm[s] - mn;
      this.t++;
      if (this.t - this.out >= DEPTH) this.emit(best, this.out + 1);
    }
    // 最良状態からさかのぼり、時刻 upto より前の未出力分を確定させる
    emit(best, upto) {
      const path = [];
      let s = best;
      for (let t = this.t - 1; t >= this.out; t--) { const ti = t % HN; if (t < upto) path.push(ti * 32 + this.grp[ti * 16 + s] * 4); s = this.prev[ti * 16 + s]; }
      for (let i = path.length - 1; i >= 0; i--) { const o = path[i]; this.unmap4d(this.gp[o], this.gp[o + 1], this.gp[o + 2], this.gp[o + 3]); }
      this.out = upto;
    }
    flush() { // 残りを全部確定させる (レート切り替えの前)
      if (this.t > this.out) { let best = 0; for (let s = 1; s < 16; s++) if (this.pm[s] < this.pm[best]) best = s; this.emit(best, this.t); }
    }
    unmap4d(a0, b0, a1, b1) {
      const p = this.p, st = this.step, qm = (1 << p.q) - 1;
      const c0 = cell(a0, b0), c1 = cell(a1, b1), w1 = ROT[c0], w2 = ROT[c1];
      this.q[st] = IDX[c0] & qm; this.m[st] = IDX[c0] >> p.q;
      this.q[st + 1] = IDX[c1] & qm; this.m[st + 1] = IDX[c1] >> p.q;
      this.ib[st >> 1] = (((w1 - this.w0) & 3) << 1) | (((w2 - w1) >> 1) & 1);
      this.w0 = w1;
      this.step += 2;
      if (this.step < 8) return;
      this.step = 0;
      if (this.bFrames === 0) this.bCnt = 0;
      if (++this.bFrames >= this.container) this.bFrames = 0;
      let bb = p.b, kk = p.k;
      this.bCnt += p.r;
      if (this.bCnt >= p.P) this.bCnt -= p.P; else if (bb > 12) { bb--; kk--; }
      const put = this.putBit, emitBits = (v, n) => { for (let i = 0; i < n; i++) put(Math.floor(v / (1 << i)) & 1); };
      if (p.k) {
        emitBits(shellUnmap(p.M, this.m), kk);
        for (let i = 0; i < 4; i++) { emitBits(this.ib[i], 3); if (p.q) { emitBits(this.q[2 * i], p.q); emitBits(this.q[2 * i + 1], p.q); } }
      } else {
        const n3 = bb - 8;
        for (let i = 0; i < 4; i++) emitBits(this.ib[i], i < n3 ? 3 : 2);
      }
    }
  }

  const V34 = { RATES, params, Encoder, Decoder, DEPTH };
  root.V34 = V34;
  if (typeof module !== 'undefined' && module.exports) module.exports = V34;
})(typeof globalThis !== 'undefined' ? globalThis : this);
