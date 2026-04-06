// driver_setup.js
'use strict';

const { Builder }  = require('selenium-webdriver');
const chrome       = require('selenium-webdriver/chrome');
const fs           = require('fs');
const path         = require('path');
const os           = require('os');
const { execSync } = require('child_process');
const { PAGE_LOAD_TIMEOUT } = require('./config');

const USE_PROXY = process.env.USE_PROXY === '1';
let _rotator = null;
function getRotator() {
  if (!_rotator) {
    try { _rotator = require('./ip_rotator').rotator; } catch(_) {}
  }
  return _rotator;
}

const CHROME_CANDIDATES = [
  '/opt/google/chrome/chrome',
  '/opt/google/chrome/google-chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
];

const WDM_BASE = path.join(os.homedir(), '.wdm', 'drivers', 'chromedriver', 'linux64');

let _profileDir = null;

function findBrowserBinary() {
  for (const p of CHROME_CANDIDATES) {
    try {
      const real = fs.realpathSync(p);
      if (fs.existsSync(real) && fs.accessSync(real, fs.constants.X_OK) === undefined) return real;
    } catch (_) {
      try {
        fs.accessSync(p, fs.constants.X_OK);
        return p;
      } catch (_2) { /* skip */ }
    }
  }
  return null;
}

function findChromedriverBinary() {
  // Prefer wdm real binaries over snap stubs
  if (fs.existsSync(WDM_BASE)) {
    const versions = fs.readdirSync(WDM_BASE).sort().reverse();
    for (const ver of versions) {
      const p = path.join(WDM_BASE, ver, 'chromedriver-linux64', 'chromedriver');
      try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (_) {}
    }
  }
  // Fall back to .driver-cache (copied by Python side)
  const cached = path.join(process.cwd(), '..', '.driver-cache', 'chromedriver');
  try { fs.accessSync(cached, fs.constants.X_OK); return cached; } catch (_) {}
  return null;
}

function freshProfileDir() {
  if (_profileDir && fs.existsSync(_profileDir)) {
    try { fs.rmSync(_profileDir, { recursive: true, force: true }); } catch (_) {}
  }
  _profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome_js_profile_'));
  return _profileDir;
}

const HCAPTCHA_EXT = path.join(__dirname, 'hcaptcha_models', 'ext');

async function makeDriver() {
  const binary     = findBrowserBinary();
  const driverPath = findChromedriverBinary();
  const headless   = ['1','true','True'].includes(process.env.HEADLESS || '0');
  const profileDir = freshProfileDir();

  const opts = new chrome.Options();
  if (binary) {
    opts.setChromeBinaryPath(binary);
    console.log(`   🧩 Browser binary: ${binary}`);
  }
  opts.addArguments(
    '--disable-notifications',
    '--disable-blink-features=AutomationControlled',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--window-size=960,1080',
    '--window-position=0,0',
    `--user-data-dir=${profileDir}`,
  );

  // Load hektCaptcha extension for auto hCaptcha solving
  if (fs.existsSync(HCAPTCHA_EXT)) {
    opts.addArguments(`--load-extension=${HCAPTCHA_EXT}`);
    console.log('   🧩 hektCaptcha extension loaded');
  }

  if (headless) opts.addArguments('--headless=new', '--disable-gpu');

  // IP rotation — get proxy before building driver
  if (USE_PROXY) {
    const rotator = getRotator();
    if (rotator) {
      const proxy = await rotator.nextProxy();
      if (proxy) {
        opts.addArguments(`--proxy-server=http://${proxy}`);
        opts.addArguments('--proxy-bypass-list=<-loopback>');
        console.log(`   🌐 Using proxy: ${proxy}`);
      } else {
        console.log('   🌐 No proxy available — using direct IP');
      }
    }
  }

  // Exclude automation switches to avoid detection
  opts.excludeSwitches(['enable-automation']);
  opts.addArguments('--disable-infobars');

  const svc = driverPath
    ? new chrome.ServiceBuilder(driverPath)
    : new chrome.ServiceBuilder();

  console.log(`   🧩 ChromeDriver: ${driverPath || 'system'}`);

  const driver = await new Builder()
    .forBrowser('chrome')
    .setChromeOptions(opts)
    .setChromeService(svc)
    .build();

  await driver.manage().setTimeouts({ pageLoad: PAGE_LOAD_TIMEOUT });
  return driver;
}

async function isDriverAlive(driver) {
  try { await driver.getTitle(); return true; } catch (_) { return false; }
}

async function restartDriver(driver) {
  console.log('   🔄 Chrome restarting...');
  try { await driver.quit(); } catch (_) {}
  await sleep(2000);
  const d = await makeDriver();
  console.log('   ✅ Chrome restarted');
  return d;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { makeDriver, isDriverAlive, restartDriver };
