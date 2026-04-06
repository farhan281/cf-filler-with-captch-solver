"""
SeleniumBase CDP hCaptcha solver — CDP mouse events only (no PyAutoGUI).
Protocol: reads URL from stdin, writes token to stdout
"""
import sys, os, time

sys.stderr.write("🔄 Starting hCaptcha CDP solver...\n")
sys.stderr.flush()

os.environ.setdefault('DISPLAY', ':0')

from seleniumbase import sb_cdp

def solve_hcaptcha(url: str) -> str:
    sb = None
    try:
        sb = sb_cdp.Chrome(url, lang="en")
        sb.sleep(6)

        # Wait for hCaptcha to load
        for _ in range(10):
            src = sb.get_page_source()
            if 'hcaptcha' in src.lower():
                break
            sb.sleep(1)
        sb.sleep(3)

        # Get hCaptcha iframe/element position via CDP evaluate
        pos = None
        try:
            pos = sb.loop.run_until_complete(sb.page.evaluate("""
                () => {
                    // Try checkbox iframe first
                    var iframes = Array.from(document.querySelectorAll('iframe'));
                    for (var f of iframes) {
                        var s = f.src || '';
                        if (s.includes('hcaptcha') && (s.includes('checkbox') || s.includes('anchor'))) {
                            var r = f.getBoundingClientRect();
                            if (r.width > 0) return {x: r.left + 24, y: r.top + 24};
                        }
                    }
                    // Any hcaptcha iframe
                    for (var f of iframes) {
                        if ((f.src||'').includes('hcaptcha')) {
                            var r = f.getBoundingClientRect();
                            if (r.width > 0) return {x: r.left + 24, y: r.top + 24};
                        }
                    }
                    // h-captcha element
                    var el = document.querySelector('.h-captcha, h-captcha, [data-hcaptcha-widget-id]');
                    if (el) {
                        var r = el.getBoundingClientRect();
                        return {x: r.left + 24, y: r.top + 24};
                    }
                    return null;
                }
            """))
        except Exception as e:
            sys.stderr.write(f"⚠️ Position detect: {e}\n")
            sys.stderr.flush()

        if not pos:
            sys.stderr.write("❌ hCaptcha element not found\n")
            sys.stderr.flush()
            return ""

        x, y = pos['x'], pos['y']
        sys.stderr.write(f"🖱️ CDP clicking hCaptcha at ({x:.0f}, {y:.0f})\n")
        sys.stderr.flush()

        # CDP mouse move + click (isTrusted=true)
        try:
            sb.loop.run_until_complete(sb.page.mouse.move(x, y))
            sb.sleep(0.3)
            sb.loop.run_until_complete(sb.page.mouse.click(x, y))
            sys.stderr.write("✅ CDP click done\n")
            sys.stderr.flush()
        except Exception as e:
            sys.stderr.write(f"⚠️ CDP mouse: {e}\n")
            sys.stderr.flush()
            return ""

        # Wait for token up to 90s
        sys.stderr.write("⏳ Waiting for token...\n")
        sys.stderr.flush()
        for i in range(45):
            sb.sleep(2)
            try:
                token = sb.loop.run_until_complete(sb.page.evaluate(
                    "document.querySelector(\"[name='h-captcha-response']\")?.value || ''"
                ))
                if token and len(token) > 10:
                    sys.stderr.write(f"✅ Token obtained (len={len(token)})\n")
                    sys.stderr.flush()
                    return token
            except: pass

            # Re-click every 20s
            if i > 0 and i % 10 == 0:
                try:
                    sb.loop.run_until_complete(sb.page.mouse.click(x, y))
                    sys.stderr.write("🔄 Re-clicked\n")
                    sys.stderr.flush()
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

sys.stderr.write("✅ hCaptcha CDP solver ready\n")
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
