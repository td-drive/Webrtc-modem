// V.34 マッピング単体テスト: 全シンボルレート × 全データレートで符号化→(雑音)→ビタビ復号の往復を確認する。
const V34 = require('../public/v34-map.js');
function gauss() { let u = 0; while (!u) u = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random()); }

function run(sIdx, n, snrDb, frames = 600) {
  const p = V34.params(sIdx, n);
  if (!p) return null;
  const CONT = 144, tx = [], rx = [];
  const enc = new V34.Encoder(); enc.configure(p);
  const dec = new V34.Decoder((b) => rx.push(b), CONT); dec.configure(p);
  const out = new Int16Array(16);
  const sigma = snrDb === Infinity ? 0 : Math.sqrt(0.5) / p.scale * Math.pow(10, -snrDb / 20);
  for (let f = 0; f < frames; f++) {
    if (f % CONT === 0) enc.resetFrames();
    enc.frame(() => { const b = Math.random() < 0.5 ? 1 : 0; tx.push(b); return b; }, out);
    for (let i = 0; i < 8; i++) dec.push(out[2 * i] + sigma * gauss(), out[2 * i + 1] + sigma * gauss());
  }
  dec.flush();
  let err = 0;
  const skip = p.b; // 先頭フレームは差動符号の初期値が不定
  for (let i = skip; i < rx.length; i++) if (rx[i] !== tx[i]) err++;
  return { len: rx.length === tx.length, err, bits: rx.length - skip, p };
}

let ok = true, count = 0;
for (let s = 0; s < 6; s++) for (let n = 1; n <= 14; n++) {
  const r = run(s, n, Infinity);
  if (!r) continue;
  count++;
  if (!r.len || r.err) { ok = false; console.log(`NG S=${V34.RATES[s].name} R=${2400 * n} b=${r.p.b} k=${r.p.k} q=${r.p.q} M=${r.p.M} len=${r.len} err=${r.err}`); }
}
console.log(`noiseless round trip: ${count} combinations ${ok ? 'OK' : 'FAILED'}`);
if (process.argv[2] === 'ber') {
  for (const [s, n] of [[0, 2], [0, 9], [3, 8], [5, 7], [5, 10], [5, 14]]) {
    const p = V34.params(s, n), bps = 2400 * n / (2400 * V34.RATES[s].a / V34.RATES[s].c);
    let line = `S=${V34.RATES[s].name} R=${2400 * n} (${bps.toFixed(2)} bit/sym):`;
    for (let off = 0; off <= 6; off += 1) {
      const snr = 3.01 * bps + off, r = run(s, n, snr, 3000);
      line += `  +${off}dB:${(r.err / r.bits).toExponential(1)}`;
    }
    console.log(line);
  }
}
process.exit(ok ? 0 : 1);
