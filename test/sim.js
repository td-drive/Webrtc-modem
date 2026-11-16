// オフライン検証: 2 台のモデムを模擬回線 (雑音・遅延・サンプル滑り) でつなぐ。
const { Modem, FS } = require('../public/modem-core.js');

function gauss() {
  let u = 0; while (u === 0) u = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
}

function run(name, { snrDb, slipsAt = [], seconds = 25, gain = 1, loss = 0 }) {
  let n0 = 0; const log = { a: [], b: [] }, rx = { a: [], b: [] }, last = {};
  const mk = (k) => new Modem((ev) => {
    if (ev.type === 'data') rx[k].push(...ev.bytes);
    else if (ev.type === 'stats') { if (last[k] && ev.resyncs !== last[k].resyncs) log[k].push('resync@' + (n0 / FS).toFixed(1)); last[k] = ev; }
    else log[k].push(`${ev.type}${ev.phase ? ':' + ev.phase : ''}${ev.txBps ? ` tx${ev.txBps}/rx${ev.rxBps}` : ''}`);
  });
  const A = mk('a'), B = mk('b');
  A.start('answer'); B.start('call');
  const noise = 0.141 * gain * Math.pow(10, -snrDb / 20);
  const RINGN = 16384;
  let delayAB = FS / 10 + 7, delayBA = FS / 10 + 7; // 100 ms + 端数
  const lineAB = new Float32Array(RINGN), lineBA = new Float32Array(RINGN);
  let w = 0;
  const BL = 192, inA = new Float32Array(BL), inB = new Float32Array(BL), outA = new Float32Array(BL), outB = new Float32Array(BL);
  const msgA = Buffer.from('こんにちは、こちら応答側です。The quick brown fox jumps over the lazy dog. '.repeat(150));
  const msgB = Buffer.from('発呼側からのテキスト。0123456789 abcdefghijklmnopqrstuvwxyz '.repeat(150));
  let sent = false, slipIdx = 0;
  for (let n = 0; n < seconds * FS; n += BL) {
    n0 = n;
    if (!sent && A.connected && B.connected) { A.send(msgA); B.send(msgB); sent = true; }
    for (let i = 0; i < BL; i++) {
      inB[i] = lineAB[(w + i - delayAB + RINGN) % RINGN] * gain + noise * gauss();
      inA[i] = lineBA[(w + i - delayBA + RINGN) % RINGN] * gain + noise * gauss();
    }
    if (loss && Math.random() < loss) inB.fill(0); // パケット欠落: 同じ長さの無音になる
    A.process(inA, outA); B.process(inB, outB);
    for (let i = 0; i < BL; i++) { lineAB[w] = outA[i]; lineBA[w] = outB[i]; w = (w + 1) % RINGN; }
    if (slipIdx < slipsAt.length && n >= slipsAt[slipIdx][0] * FS) { // ジッタバッファの伸縮を模擬
      delayAB += slipsAt[slipIdx][1]; slipIdx++;
    }
  }
  const okA = Buffer.from(rx.a).equals(msgB), okB = Buffer.from(rx.b).equals(msgA);
  console.log(`\n[${name}] snr=${snrDb}dB  A<-B ${okA ? 'OK' : 'NG ' + rx.a.length + '/' + msgB.length}  B<-A ${okB ? 'OK' : 'NG ' + rx.b.length + '/' + msgA.length}`);
  console.log('  A:', log.a.join(', '));
  console.log('  B:', log.b.join(', '));
  for (const k of ['a', 'b']) {
    const s = last[k];
    console.log(`  ${k}: snr=${s.snr.toFixed(1)} rx=${s.rxBps} tx=${s.txBps} resync=${s.resyncs} ok=${s.framesOk} fcsErr=${s.fcsErr} retx=${s.retx}`);
  }
  return okA && okB;
}

let ok = true;
ok = run('clean', { snrDb: 45 }) && ok;
ok = run('pstn-like', { snrDb: 30, gain: 0.6 }) && ok;
ok = run('noisy', { snrDb: 12, seconds: 50 }) && ok;
ok = run('slips', { snrDb: 35, slipsAt: [[7.1, 7], [8.3, -25], [9.2, 1], [10.4, 96], [11.1, -1], [12.6, 2]], seconds: 35 }) && ok;
ok = run('packet-loss 2%', { snrDb: 60, loss: 0.02, seconds: 40 }) && ok;
console.log(ok ? '\nALL PASS' : '\nFAILED');
process.exit(ok ? 0 : 1);
