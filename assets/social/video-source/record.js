const { chromium } = require('playwright');
// usage: node record.js <html> <outdir> stills|frames [fps]
(async () => {
  const [html, out, mode, fpsArg] = process.argv.slice(2);
  const fps = Number(fpsArg || 30);
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1080, height: 1920 } });
  await p.goto('file://' + html, { waitUntil: 'networkidle' });
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(500);
  const dur = await p.evaluate(() => window.DURATION);
  const times = mode === 'stills' ? [1.0, 2.6, 6.5, 8.4, 12.8, 15.9, 17.2, 20.4, 24.5, 29.5] : Array.from({ length: Math.round(dur * fps) }, (_, i) => i / fps);
  let i = 0;
  for (const t of times) {
    await p.evaluate((ms) => window.renderAt(ms), t * 1000);
    const name = mode === 'stills' ? `still-${String(t).replace('.', '_')}.jpg` : `f${String(i).padStart(5, '0')}.jpg`;
    await p.screenshot({ path: `${out}/${name}`, type: 'jpeg', quality: 92 });
    i++;
  }
  console.log(`${i} images`);
  await b.close();
})();
