'use strict';

const fs   = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Start autopush in background
const autopush = spawn('node', ['autopush.js'], { cwd: __dirname, stdio: 'ignore', detached: true });
autopush.unref();
console.log('🔄 Autopush started\n');

const CSV_PATH  = path.join(__dirname, 'digital_marketing_data.csv');
const URLS_FILE = path.join(__dirname, 'retry_urls.txt');
const CHECK_INTERVAL = 30000; // check every 30 seconds

fs.mkdirSync(path.join(__dirname, 'form_results'), { recursive: true });

function parseLine(line) {
  const fields = []; let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; }
    else if (c === ',' && !inQ) { fields.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  fields.push(cur.trim());
  return fields.map(f => f.replace(/^"|"$/g, '').trim());
}

function getFilledUrls() {
  const csv = path.join(__dirname, 'form_results', 'contact_results.csv');
  if (!fs.existsSync(csv)) return new Set();
  const filled = new Set();
  fs.readFileSync(csv, 'utf8').split('\n').filter(Boolean).slice(1).forEach(line => {
    const url = line.split(',')[0].replace(/^"|"$/g, '').trim();
    if (url) filled.add(url);
  });
  return filled;
}

function getNewUrls() {
  if (!fs.existsSync(CSV_PATH)) return [];

  const lines = fs.readFileSync(CSV_PATH, 'utf8').split('\n').filter(Boolean);
  if (lines.length < 2) return [];

  const headers = parseLine(lines[0]).map(h => h.toLowerCase());
  const cfIdx = headers.findIndex(h => h.includes('contact form'));
  const awIdx = headers.findIndex(h => h.includes('actual website'));
  const mwIdx = headers.findIndex(h => h.includes('maps website'));

  const filled = getFilledUrls();
  const queued = new Set(
    fs.existsSync(URLS_FILE)
      ? fs.readFileSync(URLS_FILE, 'utf8').split('\n').map(l => l.trim()).filter(Boolean)
      : []
  );
  const seen = new Set([...filled, ...queued]);

  const newUrls = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseLine(lines[i]);
    const url  = (cfIdx >= 0 && cols[cfIdx]) ? cols[cfIdx]
               : (awIdx >= 0 && cols[awIdx]) ? cols[awIdx]
               : (mwIdx >= 0 && cols[mwIdx]) ? cols[mwIdx]
               : '';
    if (url && /^https?:\/\//i.test(url) && !url.includes('google.com/maps') && !seen.has(url)) {
      seen.add(url);
      newUrls.push(url);
    }
  }
  return newUrls;
}

let fillerRunning = false;

function runFiller() {
  if (fillerRunning) return;
  fillerRunning = true;
  console.log('\n🚀 Starting Contact Form Filler...\n');
  const child = spawn('node', ['main.js'], { cwd: __dirname, stdio: 'inherit' });
  child.on('exit', () => {
    fillerRunning = false;
    console.log('\n⏳ Filler done — watching for new URLs...');
  });
}

function tick() {
  const newUrls = getNewUrls();
  if (newUrls.length) {
    fs.appendFileSync(URLS_FILE, newUrls.join('\n') + '\n', 'utf8');
    console.log(`\n➕ ${newUrls.length} new URLs added to queue`);
  }
  // Start filler if there are pending URLs (new or existing)
  const pending = fs.existsSync(URLS_FILE)
    ? fs.readFileSync(URLS_FILE, 'utf8').split('\n').map(l => l.trim()).filter(Boolean)
    : [];
  const filled = getFilledUrls();
  const hasPending = pending.some(u => !filled.has(u));
  if (hasPending) {
    runFiller();
  } else {
    process.stdout.write('.');
  }
}

// Initial run
console.log('👀 Watching for URLs... (Ctrl+C to stop)\n');
if (!fs.existsSync(URLS_FILE)) fs.writeFileSync(URLS_FILE, '', 'utf8');
tick();
setInterval(tick, CHECK_INTERVAL);
