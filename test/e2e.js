// 実ブラウザ (Chromium 2 ページ) で WebRTC 越しに接続して文字を送り合う。
// 使い方: node test/e2e.js  (wrangler dev でローカル起動する)
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');

(async () => {
  const PORT = 8134;
  const srv = spawn('npx', ['wrangler', 'dev', '--port', String(PORT)], { cwd: path.join(__dirname, '..'), stdio: 'ignore', detached: true });
  for (let i = 0; i < 60; i++) { // 起動待ち
    try { if ((await fetch(`http://localhost:${PORT}/`)).ok) break; } catch { /* まだ */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  let ok = false;
  try {
    const mk = async (name) => {
      const p = await (await browser.newContext()).newPage();
      p.on('pageerror', (e) => console.log(`[${name}] pageerror`, e.message));
      await p.goto(`http://localhost:${PORT}/`);
      return p;
    };
    const a = await mk('A'), b = await mk('B');
    await a.click('#answer');
    await a.waitForFunction(() => document.querySelector('#s-state').textContent === 'WAITING');
    await new Promise((r) => setTimeout(r, 300));
    await b.click('#dial');
    const t0 = Date.now();
    await Promise.all([a, b].map((p) => p.waitForFunction(() => document.querySelector('#s-state').textContent === 'ONLINE', null, { timeout: 40000 })));
    console.log(`connected in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    const msgA = 'こんにちは、応答側です。' + 'ABCDEFGHIJ'.repeat(60);
    const msgB = '発呼側より。' + '0123456789'.repeat(60);
    await a.fill('#text', msgA); await a.press('#text', 'Enter');
    await b.fill('#text', msgB); await b.press('#text', 'Enter');
    const has = (p, m) => p.waitForFunction((m) => document.querySelector('#term').textContent.split('> ' + m).join('').includes(m), m, { timeout: 30000 });
    await Promise.all([has(b, msgA), has(a, msgB)]);
    await new Promise((r) => setTimeout(r, 15000)); // しばらく回して再同期の頻度を見る
    await a.fill('#text', 'second line'); await a.press('#text', 'Enter');
    await has(b, 'second line');
    for (const [n, p] of [['A', a], ['B', b]]) {
      console.log(`--- ${n} ---`);
      console.log(await p.evaluate(() => [...document.querySelectorAll('dl dt')].map((dt) => `${dt.textContent}=${dt.nextElementSibling.textContent}`).join('  ')));
      console.log(await p.evaluate(() => [...document.querySelectorAll('#term div')].map((d) => d.textContent.slice(0, 70)).join('\n')));
    }
    await a.screenshot({ path: '/tmp/claude-0/-home-user-webrtc-modem/eafe2a68-e82e-5e47-b47e-b7c606203f7e/scratchpad/shot.png' });
    ok = true;
  } catch (e) {
    console.log('FAILED:', e.message.split('\n')[0]);
  } finally {
    await browser.close(); try { process.kill(-srv.pid); } catch { /* 終了済み */ }
  }
  console.log(ok ? 'E2E PASS' : 'E2E FAIL');
  process.exit(ok ? 0 : 1);
})();
