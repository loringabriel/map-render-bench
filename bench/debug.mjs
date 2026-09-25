import puppeteer from 'puppeteer-core';
const url = process.argv[2];
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: false, defaultViewport: null, args: ['--window-size=1400,900'] });
const page = await browser.newPage();
page.on('console', (m) => console.log('[console]', m.type(), m.text().slice(0, 300), m.type() === 'error' ? m.location()?.url : ''));
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 500)));
page.on('requestfailed', (r) => console.log('[reqfail]', r.url().slice(0, 120), r.failure()?.errorText));
await page.goto(url, { waitUntil: 'load' });
for (let i = 0; i < 12; i++) {
  await new Promise((r) => setTimeout(r, 1500));
  const s = await page.evaluate(() => ({ status: document.getElementById('status')?.textContent, phase: document.getElementById('hud-phase')?.textContent, fps: document.getElementById('hud-fps')?.textContent, res: !!window.__benchResult }));
  console.log(JSON.stringify(s));
  if (s.phase === 'measuring' && !globalThis.shot) { globalThis.shot = 1; await page.screenshot({ path: process.argv[3] || '/tmp/shot.png' }); }
  if (s.res) break;
}
console.log(JSON.stringify(await page.evaluate(() => window.__benchResult), null, 1)?.slice(0, 1500));
await browser.close();
