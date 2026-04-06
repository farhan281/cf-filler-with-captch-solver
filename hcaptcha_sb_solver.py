"""
Persistent SeleniumBase hCaptcha solver server.
Protocol: reads URL from stdin, writes token to stdout (line by line)
"""
import sys, os, time

sys.stderr.write("🔄 Starting SeleniumBase hCaptcha solver...\n")
sys.stderr.flush()

# Virtual display for headless environments
try:
    from sbvirtualdisplay import Display
    _display = Display(visible=0, size=(1920, 1080))
    _display.start()
    sys.stderr.write("✅ Virtual display started\n")
    sys.stderr.flush()
except Exception as e:
    sys.stderr.write(f"⚠️ No virtual display: {e}\n")
    sys.stderr.flush()

from seleniumbase import sb_cdp

def solve_hcaptcha(url: str) -> str:
    sb = None
    try:
        sb = sb_cdp.Chrome(url, lang="en", headless=False)
        sb.sleep(6)

        # Inject hCaptcha script if not loaded
        sb.evaluate("""
            if (!document.querySelector('iframe[src*="hcaptcha"]')) {
                var s = document.createElement('script');
                s.src = 'https://js.hcaptcha.com/1/api.js';
                s.async = true;
                document.head.appendChild(s);
            }
        """)
        sb.sleep(5)

        # Scroll to captcha
        try:
            sb.scroll_into_view("h-captcha, .h-captcha, [data-hcaptcha-widget-id], iframe[src*='hcaptcha']")
            sb.sleep(2)
        except: pass

        # Try gui_click_captcha
        try:
            sb.gui_click_captcha()
            sys.stderr.write("✅ gui_click_captcha called\n")
            sys.stderr.flush()
        except Exception as e:
            sys.stderr.write(f"⚠️ gui_click_captcha: {e}\n")
            sys.stderr.flush()

        # Wait for token up to 90s
        for i in range(45):
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

            # Every 10s try clicking again
            if i > 0 and i % 5 == 0:
                try:
                    sb.gui_click_captcha()
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
