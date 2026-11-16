'use strict';
const $ = (id) => document.getElementById(id);
const term = $('term');
let ctx, node, mon, pc, ws, room, role, started = false, online = false;
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
  for (const id of ['answer', 'dial', 'number', 'codec']) $(id).disabled = busy;
  $('hangup').disabled = !busy;
}
function setOnline(on) {
  online = on;
  $('text').disabled = $('sendbtn').disabled = !on;
  if (on) $('text').focus();
}

async function initAudio() {
  if (!ctx) {
    ctx = new AudioContext({ sampleRate: 48000 });
    await ctx.audioWorklet.addModule('modem-core.js');
    mon = ctx.createGain();
    mon.connect(ctx.destination);
  }
  await ctx.resume();
  mon.gain.value = $('speaker').checked ? 0.5 : 0;
  node = new AudioWorkletNode(ctx, 'v34ish-modem', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
  node.port.onmessage = (e) => onModem(e.data);
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

function mungeOpus(sdp) { // モデム信号向け: モノラル・CBR・DTX/FEC なし
  return sdp.replace(/a=fmtp:(\d+) (.*useinbandfec=1.*)/g, (m, pt, p) =>
    `a=fmtp:${pt} ${p.replace('useinbandfec=1', 'useinbandfec=0')};stereo=0;cbr=1;usedtx=0;maxaveragebitrate=128000`);
}

function preferCodec() {
  const want = $('codec').value === 'pcmu' ? 'audio/pcmu' : 'audio/opus';
  const caps = RTCRtpReceiver.getCapabilities('audio').codecs;
  const first = caps.filter((c) => c.mimeType.toLowerCase() === want);
  if (!first.length) return;
  const rest = caps.filter((c) => c.mimeType.toLowerCase() !== want);
  for (const t of pc.getTransceivers()) if (t.setCodecPreferences) t.setCodecPreferences(first.concat(rest));
}

function makePc() {
  pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  const dest = ctx.createMediaStreamDestination();
  dest.channelCount = 1;
  node.connect(dest);
  pc.addTrack(dest.stream.getAudioTracks()[0], dest.stream);
  pc.onicecandidate = (e) => { if (e.candidate) signal({ ice: e.candidate }); };
  pc.ontrack = (e) => {
    const stream = e.streams[0] || new MediaStream([e.track]);
    $('remote').srcObject = stream; // Chrome は <audio> に繋がないとリモート音声が流れない
    $('remote').play().catch(() => {});
    const src = ctx.createMediaStreamSource(stream);
    src.connect(node); src.connect(mon);
  };
  pc.onconnectionstatechange = async () => {
    if (!pc) return;
    if (pc.connectionState === 'connected' && !started) {
      started = true;
      const stats = await pc.getStats();
      stats.forEach((s) => {
        if (s.type === 'outbound-rtp' && s.codecId) {
          const c = stats.get(s.codecId);
          if (c) $('s-codec').textContent = c.mimeType.replace('audio/', '');
        }
      });
      // ジッタバッファが落ち着くのを少し待ってからハンドシェイク開始
      setTimeout(() => node && node.port.postMessage({ type: 'start', role }), role === 'answer' ? 800 : 0);
      setState('HANDSHAKE');
    } else if (['failed', 'closed', 'disconnected'].includes(pc.connectionState) && started) {
      hangup('NO CARRIER');
    }
  };
}

async function onSignal(msg) {
  if (msg.sdp) {
    await pc.setRemoteDescription(msg.sdp);
    if (msg.sdp.type === 'offer') {
      preferCodec();
      const ans = await pc.createAnswer();
      ans.sdp = mungeOpus(ans.sdp);
      await pc.setLocalDescription(ans);
      signal({ sdp: pc.localDescription });
    }
  } else if (msg.ice) {
    try { await pc.addIceCandidate(msg.ice); } catch (e) { /* 競合は無視 */ }
  }
}

async function go(r) {
  role = r; room = $('number').value.replace(/\D/g, '');
  if (!room) return;
  setUi(true); started = false; dec = new TextDecoder();
  await initAudio();
  if (role === 'call') { sys(`ATDT${room}`); setState('DIALING'); await dtmf(room); }
  else { sys('ATS0=1'); sys(`着信待ち: ${room}`); setState('WAITING'); }
  makePc();
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
      preferCodec();
      const offer = await pc.createOffer();
      offer.sdp = mungeOpus(offer.sdp);
      await pc.setLocalDescription(offer);
      signal({ sdp: pc.localDescription });
    } else if (m.type === 'signal') onSignal(m.msg);
  };
}

function hangup(reason) {
  if (ws) { const s = ws; ws = null; s.close(); }
  if (pc) { pc.close(); pc = null; }
  if (node) { node.port.postMessage({ type: 'stop' }); node.disconnect(); node = null; }
  $('remote').srcObject = null;
  setOnline(false); setUi(false); setState('OFFLINE');
  line(reason || 'NO CARRIER', 'warn'); rxLine = null;
}

const PHASE = { ansam: 'ANSam (2100 Hz) 送出', toneA: 'トーン A 送出', toneB: 'トーン B 送出', trn: 'TRN トレーニング', data: 'データモード', wait: '応答トーン待ち' };

function onModem(ev) {
  switch (ev.type) {
    case 'tx': if (PHASE[ev.phase]) sys(`  [tx] ${PHASE[ev.phase]}`); break;
    case 'ansam': sys('  [rx] 応答トーン検出'); break;
    case 'carrier': sys(ev.on ? '  [rx] キャリア検出' : '  [rx] キャリア断'); break;
    case 'connect':
      line(`CONNECT ${ev.rxBps}/${ev.txBps}`, 'warn'); rxLine = null;
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
      $('s-snr').textContent = ev.snr ? `${ev.snr.toFixed(1)} dB` : '–';
      $('s-resync').textContent = ev.resyncs; $('s-fcs').textContent = ev.fcsErr; $('s-retx').textContent = ev.retx;
      drawScope(ev.pts);
      break;
    case 'error': line(ev.msg, 'warn'); break;
  }
}

function drawScope(pts) {
  const c = $('scope'), g = c.getContext('2d'), w = c.width, s = w / 2.8;
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
