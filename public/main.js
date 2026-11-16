'use strict';
const $ = (id) => document.getElementById(id);
const term = $('term');
let ctx, node, mon, pc, dc, ws, routeShown, room, role, started = false, online = false;
const enc = new TextEncoder();
let dec = new TextDecoder();
let rxLine = null;

function line(text, cls) {
  const d = document.createElement('div');
  if (cls) d.className = cls;
  d.textContent = text;
  term.appendChild(d);
  term.scrollTop = term.scrollHeight;
  return d;
}
const sys = (t) => { rxLine = null; line(t, 'sys'); };
const setState = (s) => { $('s-state').textContent = s; };

function setUi(busy) {
  for (const id of ['answer', 'dial', 'number', 'baud']) $(id).disabled = busy;
  $('hangup').disabled = !busy;
}
function setOnline(on) {
  online = on;
  $('text').disabled = $('sendbtn').disabled = !on;
  if (on) $('text').focus();
}

async function initAudio() {
  if (!ctx) {
    ctx = new AudioContext();
    await ctx.audioWorklet.addModule('v34-map.js'); // 先に読み込んで同じワークレットスコープに置く
    await ctx.audioWorklet.addModule('v34-startup.js');
    await ctx.audioWorklet.addModule('modem-core.js');
    mon = ctx.createGain();
    mon.connect(ctx.destination);
  }
  await ctx.resume();
  mon.gain.value = $('speaker').checked ? 0.5 : 0;
  node = new AudioWorkletNode(ctx, 'v34ish-modem', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
  node.port.onmessage = (e) => { if (e.data.type === 'pkt') sendPacket(e.data.seq, e.data.s, e.data.buf); else onModem(e.data); };
  node.connect(mon);
}

async function dtmf(digits) { // ダイヤル音 (ローカル再生のみ)
  const F = { 1: [697, 1209], 2: [697, 1336], 3: [697, 1477], 4: [770, 1209], 5: [770, 1336], 6: [770, 1477],
    7: [852, 1209], 8: [852, 1336], 9: [852, 1477], 0: [941, 1336] };
  let t = ctx.currentTime + 0.05;
  for (const ch of digits) {
    if (!F[ch]) continue;
    for (const f of F[ch]) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = f; g.gain.value = 0.15;
      o.connect(g).connect(mon); o.start(t); o.stop(t + 0.07);
    }
    t += 0.11;
  }
  await new Promise((r) => setTimeout(r, (t - ctx.currentTime) * 1000));
}

function signal(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

const STUN = [{ urls: 'stun:stun.l.google.com:19302' }];

async function getIce() { // サーバが TURN を設定していれば一時的な認証情報付きで返ってくる
  try {
    const j = await (await fetch('/ice', { cache: 'no-store' })).json();
    sys(`  [ice] TURN: ${j.turn}`);
    return j.iceServers && j.iceServers.length ? j.iceServers : STUN;
  } catch (e) {
    sys('  [ice] TURN: 取得失敗 (STUN のみ)');
    return STUN;
  }
}

function setLine(ch) {
  dc = ch;
  dc.binaryType = 'arraybuffer';
  dc.onopen = () => {
    started = true;
    setState('HANDSHAKE');
    // 応答側は相手の受信準備を少し待ってから応答トーンを出す
    setTimeout(() => node && node.port.postMessage({ type: 'start', role, maxS: +$('baud').value }), role === 'answer' ? 800 : 0);
  };
  dc.onmessage = (e) => { // [seq:u32][シンボルレート番号:u8][int16 × 192]
    if (!node || e.data.byteLength < 7) return;
    const v = new DataView(e.data), seq = v.getUint32(0, true), s = v.getUint8(4);
    const buf = e.data.slice(5);
    node.port.postMessage({ type: 'pkt', seq, s, buf }, [buf]);
  };
  dc.onclose = () => { if (pc && started) hangup('NO CARRIER'); };
}

function sendPacket(seq, s, buf) {
  if (!dc || dc.readyState !== 'open' || dc.bufferedAmount > 65536) return; // 詰まったら捨てる
  const out = new Uint8Array(5 + buf.byteLength);
  new DataView(out.buffer).setUint32(0, seq, true);
  out[4] = s;
  out.set(new Uint8Array(buf), 5);
  dc.send(out);
}

function makePc(iceServers) {
  pc = new RTCPeerConnection({ iceServers });
  pc.oniceconnectionstatechange = () => { if (pc && !started) sys(`  [ice] ${pc.iceConnectionState}`); };
  pc.onicecandidate = (e) => { if (e.candidate) signal({ ice: e.candidate }); };
  // 回線: 順序保証なし・再送なしのデータチャネルで PCM サンプルを運ぶ
  if (role === 'call') setLine(pc.createDataChannel('line', { ordered: false, maxRetransmits: 0 }));
  else pc.ondatachannel = (e) => setLine(e.channel);
  pc.onconnectionstatechange = async () => {
    if (!pc) return;
    if (pc.connectionState === 'connected' && !routeShown) {
      routeShown = true;
      const stats = await pc.getStats();
      stats.forEach((s) => {
        if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') {
          const l = stats.get(s.localCandidateId), r = stats.get(s.remoteCandidateId);
          if (l && r) sys(`  [ice] 経路: ${l.candidateType === 'relay' || r.candidateType === 'relay' ? 'TURN 中継' : '直接'} (${l.candidateType}/${r.candidateType})`);
        }
      });
    } else if (pc.connectionState === 'failed' && !started) {
      hangup('NO CARRIER (ICE 接続失敗: 経路が見つかりません)');
    } else if (['failed', 'closed', 'disconnected'].includes(pc.connectionState) && started) {
      hangup('NO CARRIER');
    }
  };
}

async function onSignal(msg) {
  if (msg.sdp) {
    await pc.setRemoteDescription(msg.sdp);
    if (msg.sdp.type === 'offer') {
      await pc.setLocalDescription(await pc.createAnswer());
      signal({ sdp: pc.localDescription });
    }
  } else if (msg.ice) {
    try { await pc.addIceCandidate(msg.ice); } catch (e) { /* 競合は無視 */ }
  }
}

async function go(r) {
  role = r; room = $('number').value.replace(/\D/g, '');
  if (!room) return;
  setUi(true); started = false; routeShown = false; dec = new TextDecoder();
  await initAudio();
  if (role === 'call') { sys(`ATDT${room}`); setState('DIALING'); await dtmf(room); }
  else { sys('ATS0=1'); sys(`着信待ち: ${room}`); setState('WAITING'); }
  const iceServers = await getIce();
  if ($('hangup').disabled) return; // 取得中に切断された
  makePc(iceServers);
  const sock = ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?room=${room}&mode=${role}`);
  // シグナリングが接続確立前に切れたら中止。確立後は P2P なので切れても通話は続く
  sock.onclose = () => { if (ws === sock && !started) hangup('NO DIALTONE'); };
  sock.onmessage = async (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'no-answer') hangup('NO ANSWER');
    else if (m.type === 'busy') hangup('BUSY');
    else if (m.type === 'ring') sys('RING');
    else if (m.type === 'peer-left') { if (pc && !started) hangup('NO CARRIER'); }
    else if (m.type === 'joined' && role === 'call') {
      await pc.setLocalDescription(await pc.createOffer());
      signal({ sdp: pc.localDescription });
    } else if (m.type === 'signal') onSignal(m.msg);
  };
}

function hangup(reason) {
  if (ws) { const s = ws; ws = null; s.close(); }
  dc = null;
  if (pc) { pc.close(); pc = null; }
  if (node) { node.port.postMessage({ type: 'stop' }); node.disconnect(); node = null; }
  setOnline(false); setUi(false); setState('OFFLINE');
  line(reason || 'NO CARRIER', 'warn'); rxLine = null;
}

const PHASE = { S: 'フェーズ 3: S / S̄ 送出', PP: 'フェーズ 3: PP 送出', trn: 'フェーズ 3: TRN トレーニング', data: 'データモード' };
const HS = {
  ansam: '[tx] フェーズ 1: ANSam (2100 Hz) 送出', cm: '[tx] フェーズ 1: CM 送出 (V.21 FSK)', jm: '[tx] フェーズ 1: CM 受信 → JM 送出',
  cj: '[tx] フェーズ 1: JM 受信 → CJ 送出', info0: '[tx] フェーズ 2: INFO0 送出 (600 bps DPSK)', probe: '[tx] フェーズ 2: L1 / L2 プロービング信号',
  info1: '[tx] フェーズ 2: INFO1 送出',
};

function onModem(ev) {
  switch (ev.type) {
    case 'tx': if (PHASE[ev.phase]) sys(`  [tx] ${PHASE[ev.phase]}`); break;
    case 'ansam': sys('  [rx] 応答トーン検出'); break;
    case 'hs':
      if (ev.step === 'phase2-done') sys(`  [rx] フェーズ 2 完了: ${ev.baud} baud、往復遅延 約 ${ev.rtd.toFixed(0)} ms`);
      else if (HS[ev.step]) sys(`  ${HS[ev.step]}`);
      break;
    case 'fail': hangup(`NO CARRIER (${ev.reason})`); break;
    case 'carrier': sys(ev.on ? '  [rx] キャリア検出' : '  [rx] キャリア断'); break;
    case 'connect':
      line(`CONNECT ${ev.rxBps}/${ev.txBps}  (${ev.rxBaud}/${ev.txBaud} baud, V.34 トレリス符号)`, 'warn'); rxLine = null;
      setState('ONLINE'); setOnline(true);
      if ($('speaker').checked) mon.gain.setTargetAtTime(0, ctx.currentTime, 0.2); // ATM1: 接続後は消音
      break;
    case 'rate': sys(`  [rate] 受信 ${ev.rxBps} / 送信 ${ev.txBps} bps`); break;
    case 'data': {
      const s = dec.decode(new Uint8Array(ev.bytes), { stream: true });
      for (const part of s.split(/(\n)/)) {
        if (part === '\n') rxLine = null;
        else if (part) { if (!rxLine) rxLine = line(''); rxLine.textContent += part; }
      }
      term.scrollTop = term.scrollHeight;
      break;
    }
    case 'stats':
      $('s-tx').textContent = `${ev.txBps} bps`; $('s-rx').textContent = `${ev.rxBps} bps`;
      $('s-baud').textContent = `${ev.rxBaud} / ${ev.txBaud}`;
      $('s-snr').textContent = ev.snr ? `${ev.snr.toFixed(1)} dB` : '–';
      $('s-lost').textContent = ev.lost; $('s-resync').textContent = ev.resyncs; $('s-fcs').textContent = ev.fcsErr; $('s-retx').textContent = ev.retx;
      drawScope(ev.pts);
      break;
    case 'error': line(ev.msg, 'warn'); break;
  }
}

function drawScope(pts) {
  const c = $('scope'), g = c.getContext('2d'), w = c.width, s = w / 3.6;
  g.fillStyle = '#0b0f0c'; g.fillRect(0, 0, w, w);
  g.strokeStyle = '#24382a'; g.beginPath(); g.moveTo(w / 2, 0); g.lineTo(w / 2, w); g.moveTo(0, w / 2); g.lineTo(w, w / 2); g.stroke();
  g.fillStyle = '#b9f5c4';
  for (let i = 0; i < pts.length; i += 2) g.fillRect(w / 2 + pts[i] * s - 1, w / 2 - pts[i + 1] * s - 1, 2, 2);
}

$('answer').onclick = () => go('answer');
$('dial').onclick = () => go('call');
$('hangup').onclick = () => hangup('NO CARRIER');
$('speaker').onchange = () => { if (mon) mon.gain.value = $('speaker').checked && !online ? 0.5 : 0; };
$('form').onsubmit = (e) => {
  e.preventDefault();
  const t = $('text').value;
  if (!online || !t) return;
  rxLine = null;
  line(`> ${t}`, 'me');
  node.port.postMessage({ type: 'send', bytes: Array.from(enc.encode(t + '\n')) });
  $('text').value = '';
};
sys('番号を決めて片方が「着信待ち」、もう片方が同じ番号へ「発信」してください。');
