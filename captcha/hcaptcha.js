'use strict';

const { By }    = require('selenium-webdriver');
const { spawn } = require('child_process');
const path      = require('path');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function rand(a, b) { return Math.floor(Math.random() * (b - a) + a); }

const PYTHON    = process.env.PYTHON || '/usr/bin/python3';
const SOLVER_PY = path.join(__dirname, '..', 'hcaptcha_cnn_solver.py');
const MAX_ROUNDS = 12;

// ── CNN Python process ────────────────────────────────────────────────────────
let _pyProc  = null;
let _pyReady = false;
let _pending = [];

function getPyProc() {
  if (_pyProc && !_pyProc.killed) return _pyProc;
  console.log('      🔄 Starting hCaptcha CNN solver...');
  _pyProc  = spawn(PYTHON, [SOLVER_PY], { stdio: ['pipe','pipe','pipe'] });
  _pyReady = false;
  let _buf = '';
  _pyProc.stdout.on('data', chunk => {
    _buf += chunk.toString();
    const lines = _buf.split('\n');
    _buf = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const r = _pending.shift();
      if (r) {
        clearTimeout(r.timer);
        try { r.resolve(JSON.parse(trimmed)); }
        catch (e) { r.reject(new Error(`Bad JSON: ${trimmed.slice(0,80)}`)); }
      }
    }
  });
  _pyProc.stderr.on('data', d => {
    const msg = d.toString().trim();
    if (msg.includes('solver ready') || msg.includes('Prototypes ready')) _pyReady = true;
    if (msg.includes('✅') || msg.includes('❌') || msg.includes('🎯') || msg.includes('Selected'))
      console.log(`      [cnn] ${msg}`);
  });
  _pyProc.on('exit', () => {
    _pyProc = null; _pyReady = false;
    for (const r of _pending) { clearTimeout(r.timer); r.reject(new Error('CNN exited')); }
    _pending = [];
  });
  return _pyProc;
}

async function waitPyReady(ms = 90000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (_pyReady) return true; await sleep(300); }
  return false;
}

async function cnnClassify(label, imagesOrUrls) {
  getPyProc();
  await waitPyReady();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const i = _pending.findIndex(r => r.resolve === resolve);
      if (i !== -1) _pending.splice(i, 1);
      reject(new Error('CNN timeout'));
    }, 60000);
    _pending.push({ resolve, reject, timer });
    const isUrls = Array.isArray(imagesOrUrls) && typeof imagesOrUrls[0] === 'string' && imagesOrUrls[0].startsWith('http');
    const payload = isUrls
      ? JSON.stringify({ task: label, urls: imagesOrUrls })
      : JSON.stringify({ task: label, images: imagesOrUrls });
    _pyProc.stdin.write(payload + '\n');
  });
}

// ── Selenium helpers ──────────────────────────────────────────────────────────
async function sw(driver) {
  try { await driver.switchTo().defaultContent(); } catch (_) {}
}

async function isHcaptchaSolved(driver) {
  try {
    await sw(driver);
    const jsCheck = await driver.executeScript(`
      var sels = ['textarea[name="h-captcha-response"]','input[name="h-captcha-response"]','[name="h-captcha-response"]'];
      for (var i=0; i<sels.length; i++) {
        var el = document.querySelector(sels[i]);
        if (el && (el.value||'').length > 10) return true;
      }
      return false;
    `).catch(() => false);
    return !!jsCheck;
  } catch (_) { return false; }
}

async function findAnchorIframe(driver) {
  await sw(driver);
  // Scroll widget into view + inject script if needed
  await driver.executeScript(`
    var el = document.querySelector('h-captcha,.h-captcha,[data-hcaptcha-widget-id]');
    if (el) el.scrollIntoView({block:'center'});
    if (!document.querySelector('iframe[src*="hcaptcha"]')) {
      var s = document.createElement('script');
      s.src = 'https://js.hcaptcha.com/1/api.js';
      s.async = true; s.defer = true;
      document.head.appendChild(s);
    }
  `).catch(() => {});
  // Wait up to 12s
  for (let i = 0; i < 24; i++) {
    try {
      const frames = await driver.findElements(By.css('iframe[src*="hcaptcha"]'));
      for (const f of frames) {
        if (await f.isDisplayed()) return f;
      }
    } catch (_) {}
    await sleep(500);
  }
  return null;
}

async function findChallengeIframe(driver) {
  await sw(driver);
  for (let i = 0; i < 16; i++) {
    try {
      const frames = await driver.findElements(By.css('iframe[src*="hcaptcha"]'));
      for (const f of frames) {
        if (!await f.isDisplayed()) continue;
        try {
          await driver.switchTo().frame(f);
          const hasPrompt = await driver.executeScript(
            'return !!document.querySelector("h2.prompt-text,.prompt-text")');
          await sw(driver);
          if (hasPrompt) return f;
        } catch (_) { await sw(driver); }
      }
      // XPath for challenge iframe
      const xf = await driver.findElements(
        By.xpath('//iframe[contains(@src,"hcaptcha") and contains(@src,"challenge")]'));
      for (const f of xf) { if (await f.isDisplayed()) return f; }
    } catch (_) {}
    await sleep(500);
  }
  return null;
}

async function clickCheckbox(driver) {
  const anchor = await findAnchorIframe(driver);
  if (!anchor) { console.log('      ⚠️ hCaptcha anchor iframe not found'); return false; }
  try {
    await driver.switchTo().frame(anchor);
    await sleep(500);
    const rect = await driver.executeScript(`
      var el = document.querySelector('#anchor,#checkbox,[role="checkbox"]') || document.body;
      var r = el.getBoundingClientRect();
      return { x: r.left + r.width/2, y: r.top + r.height/2 };
    `);
    // CDP click — isTrusted=true
    try {
      const conn = await driver.createCDPConnection('page');
      const x = rect.x + (Math.random() * 4 - 2);
      const y = rect.y + (Math.random() * 4 - 2);
      await conn.execute('Input.dispatchMouseEvent', { type: 'mouseMoved',    x, y, button: 'none' });
      await sleep(80);
      await conn.execute('Input.dispatchMouseEvent', { type: 'mousePressed',  x, y, button: 'left', clickCount: 1 });
      await sleep(80);
      await conn.execute('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      console.log('      🖱️ CDP click on hCaptcha checkbox');
    } catch (_) {
      await driver.executeScript(`
        var el = document.querySelector('#anchor,#checkbox,[role="checkbox"]') || document.body;
        ['mouseover','mousedown','mouseup','click'].forEach(function(t){
          el.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true}));
        });
      `);
      console.log('      🖱️ JS click on hCaptcha checkbox');
    }
    await sw(driver);
    return true;
  } catch (e) {
    console.log(`      ⚠️ Checkbox click: ${(e.message||'').slice(0,60)}`);
    await sw(driver);
    return false;
  }
}

async function getTaskLabel(driver, challengeFrame) {
  try {
    await driver.switchTo().frame(challengeFrame);
    const label = await driver.executeScript(`
      var span = document.querySelector('h2.prompt-text span');
      if (span) return span.innerText.trim().toLowerCase();
      var h2 = document.querySelector('h2.prompt-text');
      if (h2) return h2.innerText.trim().toLowerCase();
      return null;
    `);
    await sw(driver);
    return (label || '').replace(/please click (on |each |all )?/i, '').trim();
  } catch (_) { await sw(driver); return ''; }
}

async function getTileImages(driver, challengeFrame) {
  try {
    await driver.switchTo().frame(challengeFrame);
    const result = await driver.executeScript(`
      // Standard 3x3/4x4 grid — background-image tiles
      var allEls = Array.from(document.querySelectorAll('[style]'));
      var imgEls = allEls.filter(function(e){
        var s = e.getAttribute('style') || '';
        return s.includes('hcaptcha.com') || (s.includes('imgs') && s.includes('url('));
      });
      if (imgEls.length >= 3) {
        var urls = imgEls.map(function(e){
          var s = e.getAttribute('style') || '';
          var m = s.match(/url\(["']?(https?:\/\/[^"')\\s]+)["']?\)/);
          return m ? m[1] : null;
        }).filter(Boolean);
        if (urls.length >= 3) return { type: 'urls', data: urls };
      }
      // img src fallback
      var imgs = Array.from(document.querySelectorAll('img')).filter(function(i){
        return i.offsetWidth >= 30 && i.src && i.src.startsWith('http');
      });
      if (imgs.length >= 3) return { type: 'urls', data: imgs.map(function(i){ return i.src; }) };
      // Check if this is a non-standard challenge (drag, sequence, anomaly etc.)
      var prompt = (document.querySelector('.prompt-text')?.innerText || '').toLowerCase();
      var isNonStandard = prompt.includes('drag') || prompt.includes('anomal') ||
                          prompt.includes('sequence') || prompt.includes('concealed') ||
                          prompt.includes('letter') || prompt.includes('arrow') ||
                          prompt.includes('rotate') || prompt.includes('order') ||
                          !document.querySelector('.task-grid');
      return { type: isNonStandard ? 'non-standard' : 'none', data: [], prompt: prompt };
    `);
    await sw(driver);
    return result || { type: 'none', data: [] };
  } catch (_) { await sw(driver); return { type: 'none', data: [] }; }
}

async function getTileElements(driver, challengeFrame) {
  try {
    await driver.switchTo().frame(challengeFrame);
    const els = await driver.executeScript(`
      var els = Array.from(document.querySelectorAll('div.task-grid div.border-focus,.task-grid .border-focus'));
      if (els.length >= 3) return els;
      els = Array.from(document.querySelectorAll('div.task-grid div.image,.task-grid .image'));
      if (els.length >= 3) return els;
      return Array.from(document.querySelectorAll('img')).filter(function(i){
        return i.offsetWidth >= 30 && i.offsetParent !== null;
      });
    `);
    await sw(driver);
    return els || [];
  } catch (_) { await sw(driver); return []; }
}

async function clickTile(driver, challengeFrame, tileEl) {
  try {
    await driver.switchTo().frame(challengeFrame);
    const rect = await driver.executeScript(`
      var el = arguments[0];
      el.scrollIntoView({block:'center'});
      var r = el.getBoundingClientRect();
      return { x: r.left + r.width/2, y: r.top + r.height/2 };
    `, tileEl);
    try {
      const conn = await driver.createCDPConnection('page');
      const x = rect.x + (Math.random() * 10 - 5);
      const y = rect.y + (Math.random() * 10 - 5);
      await conn.execute('Input.dispatchMouseEvent', { type: 'mouseMoved',    x, y, button: 'none' });
      await sleep(60);
      await conn.execute('Input.dispatchMouseEvent', { type: 'mousePressed',  x, y, button: 'left', clickCount: 1 });
      await sleep(60);
      await conn.execute('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    } catch (_) {
      await driver.executeScript(`
        var el = arguments[0];
        ['mouseover','mousedown','mouseup','click'].forEach(function(t){
          el.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,clientX:arguments[1],clientY:arguments[2]}));
        });
      `, tileEl, rect.x, rect.y);
    }
    await sw(driver);
    return true;
  } catch (_) { await sw(driver); return false; }
}

async function clickVerify(driver, challengeFrame) {
  try {
    await driver.switchTo().frame(challengeFrame);
    const clicked = await driver.executeScript(`
      var btn = document.querySelector('div.submit.button,.submit.button');
      if (btn && btn.offsetParent !== null) { btn.click(); return true; }
      var btns = Array.from(document.querySelectorAll('button'));
      for (var i=0; i<btns.length; i++) {
        var t = (btns[i].innerText||'').toLowerCase();
        if ((t.includes('verify')||t.includes('submit')) && btns[i].offsetParent !== null) {
          btns[i].click(); return true;
        }
      }
      return false;
    `);
    await sw(driver);
    if (clicked) console.log('      ✅ Clicked Verify');
    return clicked;
  } catch (_) { await sw(driver); return false; }
}

// ── Main solver ───────────────────────────────────────────────────────────────
async function solveHcaptcha(driver) {
  console.log('      🤖 Solving hCaptcha with CNN...');

  // Click checkbox
  const clicked = await clickCheckbox(driver);
  if (!clicked) return false;
  await sleep(2000);

  // Check if already solved (easy captcha)
  if (await isHcaptchaSolved(driver)) {
    console.log('      ✅ hCaptcha solved at checkbox!');
    return true;
  }

  // Find challenge iframe
  let challengeFrame = null;
  for (let i = 0; i < 10; i++) {
    challengeFrame = await findChallengeIframe(driver);
    if (challengeFrame) break;
    await sleep(500);
  }
  if (!challengeFrame) {
    console.log('      ⚠️ No challenge iframe appeared');
    return false;
  }

  // Solve challenge rounds
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    console.log(`      🔄 Challenge round ${round}/${MAX_ROUNDS}`);

    const label = await getTaskLabel(driver, challengeFrame);
    if (!label) { console.log('      ⚠️ No task label'); break; }
    console.log(`      🎯 Task: "${label}"`);

    const tileData = await getTileImages(driver, challengeFrame);
    if (!tileData.data.length) { console.log('      ⚠️ No tile images'); break; }
    console.log(`      🖼️ ${tileData.data.length} tiles`);

    // CNN classify
    let indices = [];
    try {
      const result = await cnnClassify(label, tileData.data);
      indices = result.indices || [];
    } catch (e) {
      console.log(`      ⚠️ CNN error: ${e.message}`);
      break;
    }

    if (!indices.length) {
      console.log('      ⚠️ CNN returned no matches — reloading challenge');
      // Click skip/reload if available
      try {
        await driver.switchTo().frame(challengeFrame);
        await driver.executeScript(`
          var btn = document.querySelector('.refresh.button,[aria-label*="new"]');
          if (btn) btn.click();
        `);
        await sw(driver);
      } catch (_) { await sw(driver); }
      await sleep(2000);
      continue;
    }

    console.log(`      ✅ Clicking tiles: [${indices.join(', ')}]`);

    // Get tile elements and click matching ones
    const tileEls = await getTileElements(driver, challengeFrame);
    for (const idx of indices) {
      if (idx < tileEls.length) {
        await clickTile(driver, challengeFrame, tileEls[idx]);
        await sleep(rand(300, 600));
      }
    }

    await sleep(rand(800, 1200));

    // Click Verify
    await clickVerify(driver, challengeFrame);
    await sleep(rand(2000, 3000));

    // Check if solved
    if (await isHcaptchaSolved(driver)) {
      console.log('      ✅ hCaptcha solved!');
      return true;
    }

    // Check if new challenge appeared
    const newFrame = await findChallengeIframe(driver);
    if (newFrame) {
      challengeFrame = newFrame;
      continue;
    }

    // No new challenge — might be solved
    if (await isHcaptchaSolved(driver)) {
      console.log('      ✅ hCaptcha solved!');
      return true;
    }
    break;
  }

  console.log('      ❌ hCaptcha not solved');
  return false;
}

process.on('exit', () => { if (_pyProc) try { _pyProc.kill(); } catch (_) {} });
module.exports = { solveHcaptcha };
