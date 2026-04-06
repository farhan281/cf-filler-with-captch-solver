// captcha/handler.js
'use strict';

const { detectCaptchaState, captchaSolved } = require('./detector');
const { solveRecaptchaAudio }               = require('./recaptcha');
const { waitForTurnstileAutoClear }         = require('./turnstile');
const { solveImageCaptcha }                 = require('./image_captcha');
const { solveHcaptcha }                     = require('./hcaptcha');
const { CAPTCHA_POLICY, CAPTCHA_WAIT_TIMEOUT } = require('../config');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function handleCaptcha(driver, record, stage, formContext, timeout) {
  timeout = timeout || CAPTCHA_WAIT_TIMEOUT;
  const state = await detectCaptchaState(driver, formContext);
  if (!state.present) return 'clear';

  const reason = state.reason || 'CAPTCHA challenge';
  const isImageCaptcha = reason.toLowerCase().includes('image');

  // Image CAPTCHA (securimage, text-in-image) — always try OCR regardless of policy
  if (isImageCaptcha) {
    console.log(`   🖼️ Image CAPTCHA detected — trying OCR solver...`);
    if (await solveImageCaptcha(driver, formContext)) {
      record.captcha_status = `Auto-solved at ${stage}: ${reason}`;
      return 'clear';
    }
    console.log(`   ⚠️ Image OCR failed — skipping`);
    record.captcha_status = `Image OCR failed at ${stage}`;
    return 'blocked';
  }

  if (CAPTCHA_POLICY === 'block') {
    console.log(`   🛑 CAPTCHA blocked at ${stage}: ${reason}`);
    record.status         = 'CaptchaBlocked';
    record.details        = `Blocked by ${reason} at ${stage}`;
    record.captcha_status = `Blocked at ${stage}: ${reason}`;
    return 'blocked';
  }

  if (CAPTCHA_POLICY === 'auto') {
    console.log(`   🤖 Auto-solving CAPTCHA at ${stage}: ${reason}`);
    const isCF        = ['turnstile','cloudflare','cf '].some(w => reason.toLowerCase().includes(w));
    const isRecaptcha = reason.toLowerCase().includes('recaptcha');
    const isHcaptcha  = ['hcaptcha','h-captcha'].some(w => reason.toLowerCase().includes(w));

    if (isCF) {
      // First check if Turnstile is already solved (token present)
      const alreadySolved = await driver.executeScript(function() {
        var inp = document.querySelector('input[name="cf-turnstile-response"]');
        return inp && (inp.value || '').length > 10;
      }).catch(() => false);
      if (alreadySolved) {
        console.log('      ✅ Turnstile already solved (token present)');
        record.captcha_status = `Auto-cleared at ${stage}: ${reason}`;
        return 'clear';
      }
      if (await waitForTurnstileAutoClear(driver, formContext)) {
        record.captcha_status = `Auto-cleared at ${stage}: ${reason}`;
        return 'clear';
      }
      console.log(`   ⚠️ Turnstile not solved — retrying with fresh browser`);
      record.details        = `${reason} not solved at ${stage}`;
      record.captcha_status = `Not solved at ${stage}: ${reason}`;
      return 'retry';
    }

    if (isHcaptcha) {
      console.log(`   🤖 hCaptcha detected at ${stage} — waiting for manual solve (${timeout/1000}s)...`);
      // hCaptcha image challenge cannot be auto-solved without paid API
      // Wait for manual solve
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const solved = await captchaSolved(driver);
        if (solved) {
          console.log('      ✅ hCaptcha solved!');
          record.captcha_status = `Solved at ${stage}: ${reason}`;
          return 'clear';
        }
        await sleep(2000);
      }
      console.log(`   ⏭️ hCaptcha not solved in time — skipping`);
      record.status = 'Skipped';
      record.details = `hCaptcha not solved within ${timeout/1000}s`;
      record.captcha_status = `Not solved at ${stage}: ${reason}`;
      return 'blocked';
    }

    if (isRecaptcha) {
      if (await solveRecaptchaAudio(driver)) {
        record.captcha_status = `Auto-solved at ${stage}: ${reason}`;
        return 'clear';
      }
      console.log(`   ⚠️ reCAPTCHA not solved at ${stage} (likely rate-limited), skipping`);
      record.status         = 'Skipped';
      record.details        = `${reason} rate-limited at ${stage}`;
      record.captcha_status = `Rate-limited at ${stage}: ${reason}`;
      return 'blocked';
    }

    // Image CAPTCHA — try for any non-CF/non-reCAPTCHA reason
    console.log(`   🖼️ Trying image CAPTCHA solver...`);
    if (await solveImageCaptcha(driver, formContext)) {
      record.captcha_status = `Auto-solved at ${stage}: ${reason}`;
      return 'clear';
    }

    console.log(`   ⚠️ Auto-solve failed at ${stage}, falling back to manual wait`);
  }

  // Manual wait
  console.log(`   🔐 CAPTCHA at ${stage}: ${reason}. Waiting up to ${timeout/1000}s...`);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await captchaSolved(driver)) {
      console.log('      ✅ CAPTCHA solved');
      record.captcha_status = `Solved manually at ${stage}: ${reason}`;
      return 'clear';
    }
    await sleep(2000);
  }

  console.log('   ⏭️ CAPTCHA not solved in time, skipping');
  record.details        = `${reason} not solved within ${timeout/1000}s at ${stage}`;
  record.captcha_status = `Not solved within ${timeout/1000}s at ${stage}: ${reason}`;
  return 'retry';
}

module.exports = { handleCaptcha };
