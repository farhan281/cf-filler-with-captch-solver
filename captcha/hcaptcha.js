'use strict';
const { spawn } = require('child_process');
const path = require('path');
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const PYTHON = process.env.PYTHON || '/usr/bin/python3';
const SB_PY  = path.join(__dirname, '..', 'hcaptcha_sb_solver.py');

let _sbProc  = null;
let _sbReady = false;
let _sbQueue = [];

function getSbProc() {
  if (_sbProc && !_sbProc.killed) return _sbProc;
  console.log('      🔄 Starting SeleniumBase hCaptcha solver...');
  _sbProc  = spawn(PYTHON, [SB_PY], { stdio: ['pipe','pipe','pipe'] });
  _sbReady = false;
  let _buf = '';
  _sbProc.stdout.on('data', chunk => {
    _buf += chunk.toString();
    const lines = _buf.split('\n');
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
      console.log(`      [sb] ${msg}`);
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

async function solveHcaptcha(driver) {
  console.log('      🤖 Solving hCaptcha with SeleniumBase CDP...');
  const url = await driver.getCurrentUrl().catch(() => '');
  if (!url) return false;

  const token = await sbSolve(url);
  if (!token || token.length < 10) {
    console.log('      ❌ No token received');
    return false;
  }

  console.log(`      ✅ Token received (len=${token.length}) — injecting...`);
  try {
    await driver.executeScript(`
      var token = arguments[0];
      ['textarea[name="h-captcha-response"]','input[name="h-captcha-response"]']
        .forEach(function(sel){
          document.querySelectorAll(sel).forEach(function(el){
            el.value = token;
            el.dispatchEvent(new Event('input',{bubbles:true}));
            el.dispatchEvent(new Event('change',{bubbles:true}));
          });
        });
    `, token);
    console.log('      ✅ Token injected');
    return true;
  } catch (e) {
    console.log('      ⚠️ Inject error:', e.message.slice(0,80));
    return false;
  }
}

process.on('exit', () => { if (_sbProc) try { _sbProc.kill(); } catch(_) {} });
module.exports = { solveHcaptcha };
