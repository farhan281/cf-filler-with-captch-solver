"""
Persistent SeleniumBase hCaptcha solver server.
Protocol: reads URL from stdin, writes token to stdout (line by line)
"""
from seleniumbase import sb_cdp
import sys, time

sys.stderr.write("🔄 Starting SeleniumBase hCaptcha solver...\n")
sys.stderr.flush()

def solve_hcaptcha(url: str) -> str:
    sb = None
    try:
        sb = sb_cdp.Chrome(url, lang="en")
        sb.sleep(5)
        # Inject hCaptcha script if web component (lazy load)
        sb.evaluate("""
            if (!document.querySelector('iframe[src*="hcaptcha"]')) {
                var s = document.createElement('script');
                s.src = 'https://js.hcaptcha.com/1/api.js';
                s.async = true;
                document.head.appendChild(s);
            }
        """)
        sb.sleep(4)
        try:
            sb.scroll_into_view("h-captcha, .h-captcha, [data-hcaptcha-widget-id]")
            sb.sleep(2)
        except: pass
        try:
            sb.gui_click_captcha()
        except Exception as e:
            sys.stderr.write(f"⚠️ gui_click_captcha: {e}\n")
            sys.stderr.flush()
        # Wait for token (up to 60s)
        for _ in range(30):
            sb.sleep(2)
            try:
                token = sb.evaluate(
                    "document.querySelector(\"[name='h-captcha-response']\")?.value || ''"
                )
                if token and len(token) > 10:
                    sys.stderr.write(f"✅ Token obtained (len={len(token)})\n")
                    sys.stderr.flush()
                    return token
            except: pass
        sys.stderr.write("❌ Token not obtained\n")
        sys.stderr.flush()
        return ""
    except Exception as e:
        sys.stderr.write(f"❌ Error: {e}\n")
        sys.stderr.flush()
        return ""
    finally:
        if sb:
            try: sb.driver.stop()
            except: pass

sys.stderr.write("✅ SeleniumBase hCaptcha solver ready\n")
sys.stderr.flush()

for line in sys.stdin:
    url = line.strip()
    if not url:
        print("", flush=True)
        continue
    sys.stderr.write(f"🌐 Solving for: {url}\n")
    sys.stderr.flush()
    token = solve_hcaptcha(url)
    print(token, flush=True)
