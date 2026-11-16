// Cloudflare Workers 用シグナリング。
// 「電話番号」ごとに Durable Object を 1 つ立て、WebSocket 2 本の間でメッセージを中継する。
// 静的ファイル (public/) は Workers の静的アセット機能が配信する。
import { DurableObject } from 'cloudflare:workers';

const json = (o) => JSON.stringify(o);

export class Room extends DurableObject {
  async fetch(req) {
    const mode = new URL(req.url).searchParams.get('mode');
    const others = this.ctx.getWebSockets();
    const [client, server] = Object.values(new WebSocketPair());
    if ((mode === 'call' && others.length !== 1) || (mode === 'answer' && others.length !== 0)) {
      server.accept();
      server.send(json({ type: mode === 'call' && others.length === 0 ? 'no-answer' : 'busy' }));
      server.close(1000, 'rejected');
    } else {
      this.ctx.acceptWebSocket(server); // ハイバネーション対応: 待機中は課金対象の実行時間にならない
      for (const o of others) o.send(json({ type: 'ring' }));
      server.send(json({ type: 'joined' }));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    if (typeof message !== 'string' || message.length > 65536) return;
    let msg;
    try { msg = JSON.parse(message); } catch { return; }
    for (const o of this.ctx.getWebSockets()) if (o !== ws) o.send(json({ type: 'signal', msg }));
  }

  webSocketClose(ws) { this.left(ws); }
  webSocketError(ws) { this.left(ws); }

  left(ws) {
    try { ws.close(1000, 'bye'); } catch { /* 既に閉じている */ }
    for (const o of this.ctx.getWebSockets()) {
      if (o !== ws) { try { o.send(json({ type: 'peer-left' })); } catch { /* 無視 */ } }
    }
  }
}

// TURN: Cloudflare Realtime の TURN キーが設定されていれば、短命の認証情報を発行して返す。
// 設定: wrangler secret put TURN_KEY_ID / TURN_KEY_API_TOKEN
const STUN = [{ urls: 'stun:stun.l.google.com:19302' }];

async function ice(env) {
  let iceServers = STUN, turn = '未設定 (STUN のみ)';
  if (env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN) {
    try {
      const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: json({ ttl: 86400 }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const list = [].concat((await r.json()).iceServers || []) // 配列でも単一オブジェクトでも受ける
        .map((s) => ({ ...s, urls: [].concat(s.urls || []).filter((u) => !/:53(\?|$)/.test(u)) })) // ブラウザは 53 番を拒否する
        .filter((s) => s.urls.length);
      if (!list.some((s) => s.credential)) throw new Error('no TURN credential in response');
      iceServers = list; turn = '有効';
    } catch (e) {
      turn = `エラー (${e.message}) STUN のみ`;
    }
  }
  return new Response(json({ iceServers, turn }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/ice') return ice(env);
    if (url.pathname !== '/ws') return new Response('not found', { status: 404 });
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    const room = (url.searchParams.get('room') || '').replace(/\D/g, '').slice(0, 32);
    if (!room) return new Response('room required', { status: 400 });
    return env.ROOM.get(env.ROOM.idFromName(room)).fetch(req);
  },
};
