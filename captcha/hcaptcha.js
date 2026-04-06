// captcha/hcaptcha.js
// hCaptcha solver — Node.js side.
// Spawns hcaptcha_solver.py (CNN) as a persistent child process,
// then drives the hCaptcha widget via Selenium:
//   1. Detect & click the hCaptcha checkbox
//   2. Wait for image challenge to appear
//   3. Read task label + fetch all tile images
//   4. Send to Python CNN → get matching tile indices
//   5. Click matching tiles → click Verify
//   6. Repeat for new challenges (up to MAX_ROUNDS)
'use strict';

const { By }    = require('selenium-webdriver');
const { spawn } = require('child_process');
const path      = require('path');
const fs        = require('fs');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function rand(a, b) { return Math.floor(Math.random() * (b - a) + a); }

// ── Python CNN process (singleton) ───────────────────────────────────────────
let _pyProc   = null;
let _pyReady  = false;
let _pendingResolvers = [];   // queue of {resolve, reject, timer}

const PYTHON     = process.env.PYTHON || '/usr/bin/python3';
const SOLVER_PY  = path.join(__dirname, '..', 'hcaptcha_cnn_solver.py');
const MAX_ROUNDS = 12;  // max challenge rounds (includes reloads for unsolvable types)

function getPyProc() {
  if (_pyProc && !_pyProc.killed) return _pyProc;

  console.log('      🔄 Starting hCaptcha CNN solver...');
  _pyProc  = spawn(PYTHON, [SOLVER_PY], { stdio: ['pipe', 'pipe', 'pipe'] });
  _pyReady = false;

  let _lineBuf = '';

  _pyProc.stdout.on('data', chunk => {
    _lineBuf += chunk.toString();
    const lines = _lineBuf.split('\n');
    _lineBuf = lines.pop();                 // keep incomplete line
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const resolver = _pendingResolvers.shift();
      if (resolver) {
        clearTimeout(resolver.timer);
        try {
          resolver.resolve(JSON.parse(trimmed));
        } catch (e) {
          resolver.reject(new Error(`Bad JSON: ${trimmed.slice(0, 80)}`));
        }
      }
    }
  });

  _pyProc.stderr.on('data', d => {
    const msg = d.toString().trim();
    if (msg.includes('solver ready') || msg.includes('Prototypes ready')) {
      _pyReady = true;
    }
    // Only print important lines to avoid noise
    if (msg.includes('✅') || msg.includes('❌') || msg.includes('🎯') ||
        msg.includes('Selected') || msg.includes('error')) {
      console.log(`      [hcaptcha-cnn] ${msg}`);
    }
  });

  _pyProc.on('exit', () => {
    _pyProc  = null;
    _pyReady = false;
    // Reject all pending
    for (const r of _pendingResolvers) {
      clearTimeout(r.timer);
      r.reject(new Error('CNN process exited'));
    }
    _pendingResolvers = [];
  });

  return _pyProc;
}

async function waitPyReady(timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (_pyReady) return true;
    await sleep(300);
  }
  return false;
}

async function cnnClassify(taskLabel, imagesOrUrls) {
  const proc = getPyProc();
  await waitPyReady();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = _pendingResolvers.findIndex(r => r.resolve === resolve);
      if (idx !== -1) _pendingResolvers.splice(idx, 1);
      reject(new Error('CNN classify timeout'));
    }, 60000);

    _pendingResolvers.push({ resolve, reject, timer });

    // Send URLs if available (Python fetches directly), else base64
    const payload = Array.isArray(imagesOrUrls)
      ? JSON.stringify({ task: taskLabel, images: imagesOrUrls }) + '\n'
      : JSON.stringify({ task: taskLabel, urls: imagesOrUrls.data }) + '\n';
    proc.stdin.write(payload);
  });
}

// ── Selenium helpers ──────────────────────────────────────────────────────────
async function sw(driver) {
  try { await driver.switchTo().defaultContent(); } catch (_) {}
}

async function isHcaptchaSolved(driver) {
  try {
    await sw(driver);
    // Check response token
    const tokens = await driver.findElements(
      By.css("textarea[name='h-captcha-response'],input[name='h-captcha-response']"));
    for (const t of tokens) {
      const val = (await t.getAttribute('value') || '').trim();
      if (val && val.length > 10) return true;
    }
    // Also check via JS (some implementations hide the textarea)
    const jsCheck = await driver.executeScript(`
      var sels = [
        'textarea[name="h-captcha-response"]',
        'input[name="h-captcha-response"]',
        '[name="h-captcha-response"]',
      ];
      for (var i=0; i<sels.length; i++) {
        var el = document.querySelector(sels[i]);
        if (el && (el.value||'').length > 10) return true;
      }
      return false;
    `).catch(() => false);
    if (jsCheck) return true;
  } catch (_) {}
  return false;
}

// Find the hCaptcha anchor iframe (checkbox)
async function findAnchorIframe(driver) {
  await sw(driver);

  // Scroll widget into view
  await driver.executeScript(`
    var el = document.querySelector('h-captcha,.h-captcha,[data-hcaptcha-widget-id]');
    if (el) el.scrollIntoView({block:'center'});
  `).catch(() => {});
  await sleep(1000);

  // Inject hCaptcha script if not loaded (web component / lazy sites)
  await driver.executeScript(`
    (function(){
      if (document.querySelector('iframe[src*="hcaptcha"]')) return;
      var el = document.querySelector('h-captcha,.h-captcha,[data-hcaptcha-widget-id]');
      if (!el) return;
      var s = document.createElement('script');
      s.src = 'https://js.hcaptcha.com/1/api.js';
      s.async = true; s.defer = true;
      document.head.appendChild(s);
    })();
  `).catch(() => {});

  // Wait up to 12s for hCaptcha iframe to appear
  for (let i = 0; i < 24; i++) {
    try {
      // Try src*=hcaptcha (works after script injection)
      const frames = await driver.findElements(By.css('iframe[src*="hcaptcha"]'));
      for (const f of frames) {
        if (await f.isDisplayed()) return f;
      }
      // Also try original XPath
      const xframes = await driver.findElements(
        By.xpath("//iframe[contains(@src,'hcaptcha') and contains(@src,'checkbox')]"));
      for (const f of xframes) {
        if (await f.isDisplayed()) return f;
      }
    } catch (_) {}
    await sleep(500);
  }
  return null;
}

// Find the hCaptcha challenge iframe (image grid)
async function findChallengeIframe(driver) {
  await sw(driver);
  // Wait up to 8s for challenge iframe (has prompt-text inside)
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
      // XPath fallback
      const xframes = await driver.findElements(
        By.xpath("//iframe[contains(@src,'hcaptcha') and contains(@src,'challenge')]"));
      for (const f of xframes) {
        if (await f.isDisplayed()) return f;
      }
    } catch (_) {}
    await sleep(500);
  }
  return null;
}

// Click checkbox in anchor iframe
async function clickCheckbox(driver) {
  const anchor = await findAnchorIframe(driver);
  if (!anchor) { console.log('      ⚠️ hCaptcha checkbox iframe not found'); return false; }
  try {
    await driver.switchTo().frame(anchor);
    await sleep(500);

    // Get body element position for CDP click
    const rect = await driver.executeScript(`
      var el = document.querySelector('#anchor,#checkbox,[role="checkbox"]') || document.body;
      var r = el.getBoundingClientRect();
      return { x: r.left + r.width/2, y: r.top + r.height/2, found: el.id || el.tagName };
    `);

    // Use CDP Input.dispatchMouseEvent — sets isTrusted=true, bypasses bot detection
    try {
      const conn = await driver.createCDPConnection('page');
      const x = rect.x + (Math.random() * 4 - 2);
      const y = rect.y + (Math.random() * 4 - 2);
      await conn.execute('Input.dispatchMouseEvent', { type: 'mouseMoved',   x, y, button: 'none' });
      await sleep(80);
      await conn.execute('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await sleep(80);
      await conn.execute('Input.dispatchMouseEvent', { type: 'mouseReleased',x, y, button: 'left', clickCount: 1 });
      console.log(`      🖱️ CDP click on hCaptcha checkbox (${rect.found})`);
    } catch (_) {
      // Fallback: regular JS click
      await driver.executeScript(`
        var el = document.querySelector('#anchor,#checkbox,[role="checkbox"]') || document.body;
        el.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true, isTrusted:true}));
      `);
      console.log('      🖱️ JS click on hCaptcha checkbox (fallback)');
    }

    await sw(driver);
    return true;
  } catch (e) {
    console.log(`      ⚠️ Checkbox click failed: ${(e.message || '').slice(0, 60)}`);
    await sw(driver);
    return false;
  }
}

// Read task label from challenge iframe
async function getTaskLabel(driver, challengeFrame) {
  try {
    await driver.switchTo().frame(challengeFrame);
    // Exact selector from hcaptcha-solver: h2.prompt-text > span
    const label = await driver.executeScript(`
      var span = document.querySelector('h2.prompt-text span');
      if (span) return span.innerText.trim().toLowerCase();
      var h2 = document.querySelector('h2.prompt-text');
      if (h2) return h2.innerText.trim().toLowerCase();
      return null;
    `);
    await sw(driver);
    return (label || '').replace(/please click (on |each |all )?/i, '').trim();
  } catch (_) {
    await sw(driver);
    return '';
  }
}

// Fetch all tile images as base64 from challenge iframe
async function getTileImages(driver, challengeFrame) {
  try {
    await driver.switchTo().frame(challengeFrame);
    // Extract image URLs from background-image style
    const result = await driver.executeScript(`
      // Find ALL elements with hcaptcha image URLs in style
      var allEls = Array.from(document.querySelectorAll('[style]'));
      var imgEls = allEls.filter(function(e){
        var s = e.getAttribute('style') || '';
        return s.includes('hcaptcha.com') || s.includes('imgs') && s.includes('url(');
      });

      if (imgEls.length >= 3) {
        var urls = imgEls.map(function(e){
          var s = e.getAttribute('style') || '';
          var m = s.match(/url\(["']?(https?:\/\/[^"')\s]+)["']?\)/);
          return m ? m[1] : null;
        }).filter(Boolean);
        if (urls.length >= 3) return { type: 'urls', data: urls };
      }

      // img src fallback
      var imgs = Array.from(document.querySelectorAll('img')).filter(function(i){
        return i.offsetWidth >= 30 && i.src && i.src.startsWith('http');
      });
      if (imgs.length >= 3) return { type: 'urls', data: imgs.map(function(i){ return i.src; }) };
      return { type: 'none', data: [] };
    `);
    await sw(driver);
    return result || { type: 'none', data: [] };
  } catch (_) {
    await sw(driver);
    return { type: 'none', data: [] };
  }
}

// Get clickable tile elements (in same order as images)
async function getTileElements(driver, challengeFrame) {
  try {
    await driver.switchTo().frame(challengeFrame);
    // Exact selector from hcaptcha-solver: div.task-grid div.border-focus
    const els = await driver.executeScript(`
      var els = Array.from(document.querySelectorAll(
        'div.task-grid div.border-focus, .task-grid .border-focus'
      ));
      if (els.length >= 3) return els;
      // Fallback: task-grid image divs
      els = Array.from(document.querySelectorAll(
        'div.task-grid div.image, .task-grid .image'
      ));
      if (els.length >= 3) return els;
      // Last resort: visible imgs
      return Array.from(document.querySelectorAll('img')).filter(function(i){
        return i.offsetWidth >= 30 && i.offsetParent !== null;
      });
    `);
    await sw(driver);
    return els || [];
  } catch (_) {
    await sw(driver);
    return [];
  }
}

// Click a tile element with human-like mouse events
async function clickTile(driver, challengeFrame, tileEl) {
  try {
    await driver.switchTo().frame(challengeFrame);
    const rect = await driver.executeScript(`
      var el = arguments[0];
      el.scrollIntoView({block:'center'});
      var r = el.getBoundingClientRect();
      return { x: r.left + r.width/2, y: r.top + r.height/2 };
    `, tileEl);

    // CDP click — isTrusted=true
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
  } catch (_) {
    await sw(driver);
    return false;
  }
}

// Click the Verify button inside challenge iframe
async function clickVerify(driver, challengeFrame) {
  try {
    await driver.switchTo().frame(challengeFrame);
    // Exact selector from hcaptcha-solver: div.submit.button
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
  } catch (_) {
    await sw(driver);
    return false;
  }
}
async function waitForChallenge(driver, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = await findChallengeIframe(driver);
    if (frame) return frame;
    await sleep(400);
  }
  return null;
}

// Check if challenge shows "new challenge" / refreshed
async function isChallengeRefreshed(driver, challengeFrame, prevLabel) {
  const newLabel = await getTaskLabel(driver, challengeFrame);
  return newLabel && newLabel !== prevLabel;
}

// ── Main hCaptcha solver ──────────────────────────────────────────────────────
// ── SeleniumBase solver process ───────────────────────────────────────────────
let _sbProc  = null;
let _sbReady = false;
let _sbQueue = [];

const SB_PY = require('path').join(__dirname, '..', 'hcaptcha_sb_solver.py');

function getSbProc() {
  if (_sbProc && !_sbProc.killed) return _sbProc;
  console.log('      🔄 Starting SeleniumBase hCaptcha solver...');
  _sbProc  = require('child_process').spawn(PYTHON, [SB_PY], { stdio: ['pipe','pipe','pipe'] });
  _sbReady = false;
  let _buf = '';
  _sbProc.stdout.on('data', chunk => {
    _buf += chunk.toString();
    const lines = _buf.split("\n");
    _buf = lines.pop();
    for (const line of lines) {
      const r = _sbQueue.shift();
      if (r) { clearTimeout(r.timer); r.resolve(line.trim()); }
    }
  });
  _sbProc.stderr.on('data', d => {
    const msg = d.toString().trim();
    if (msg.includes('ready')) _sbReady = true;
    if (msg.includes('✅') || msg.includes('❌') || msg.includes('⚠️'))
      console.log();
  });
  _sbProc.on('exit', () => {
    _sbProc = null; _sbReady = false;
    for (const r of _sbQueue) { clearTimeout(r.timer); r.resolve(''); }
    _sbQueue = [];
  });
  return _sbProc;
}

async function waitSbReady(ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (_sbReady) return true;
    await sleep(300);
  }
  return _sbReady;
}

async function sbSolve(url) {
  getSbProc();
  await waitSbReady();
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      const i = _sbQueue.findIndex(r => r.resolve === resolve);
      if (i !== -1) _sbQueue.splice(i, 1);
      resolve('');
    }, 120000);
    _sbQueue.push({ resolve, timer });
    _sbProc.stdin.write(url + '\n');
  });
}

// ── Main hCaptcha solver ──────────────────────────────────────────────────────
async function solveHcaptcha(driver) {
  console.log('      🤖 Solving hCaptcha with SeleniumBase CDP...');

  // Get current URL to pass to SeleniumBase
  const url = await driver.getCurrentUrl().catch(() => '');
  if (!url) { console.log('      ⚠️ Could not get URL'); return false; }

  // SeleniumBase opens its own browser, solves hCaptcha, returns token
  const token = await sbSolve(url);

  if (!token || token.length < 10) {
    console.log('      ❌ SeleniumBase did not return token');
    return false;
  }

  console.log(`      ✅ Got token (len=${token.length}) — injecting into page...`);

  // Inject token into the page's hCaptcha response fields
  try {
    await driver.executeScript(`
      var token = arguments[0];
      var sels = ['textarea[name="h-captcha-response"]','input[name="h-captcha-response"]','[name="h-captcha-response"]'];
      sels.forEach(function(sel){
        document.querySelectorAll(sel).forEach(function(el){
          el.value = token;
          el.dispatchEvent(new Event('input',{bubbles:true}));
          el.dispatchEvent(new Event('change',{bubbles:true}));
        });
      });
    `, token);
    console.log('      ✅ Token injected into page');
    return true;
  } catch (e) {
    console.log('      ⚠️ Token injection error:', e.message.slice(0, 80));
    return false;
  }
}

// Cleanup on exit
process.on('exit', () => {
  if (_pyProc) try { _pyProc.kill(); } catch (_) {}
});

module.exports = { solveHcaptcha };
