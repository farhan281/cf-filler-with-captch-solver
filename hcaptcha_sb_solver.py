"""
SeleniumBase CDP hCaptcha solver.
Uses find_element + mouse_click (CDP isTrusted=true events).
Protocol: reads URL from stdin, writes token to stdout
"""
import sys, os

sys.stderr.write("🔄 Starting hCaptcha CDP solver...\n")
sys.stderr.flush()

os.environ.setdefault('DISPLAY', ':0')

from seleniumbase import sb_cdp

def solve_hcaptcha(url: str) -> str:
    sb = None
    try:
        sb = sb_cdp.Chrome(url, lang="en")
        sb.sleep(8)

        # Find hCaptcha checkbox iframe
        iframe_el = None
        for sel in [
            'iframe[src*="hcaptcha"][src*="checkbox"]',
            'iframe[title*="hCaptcha"]',
            'iframe[src*="hcaptcha"]',
            '.h-captcha iframe',
            'h-captcha iframe',
        ]:
            try:
                if sb.is_element_present(sel):
                    iframe_el = sb.find_element(sel)
                    sys.stderr.write(f"✅ Found hCaptcha iframe: {sel}\n")
                    sys.stderr.flush()
                    break
            except: pass

        if not iframe_el:
            sys.stderr.write("❌ hCaptcha iframe not found\n")
            sys.stderr.flush()
            return ""

        # Scroll into view and click
        try:
            iframe_el.scroll_into_view()
            sb.sleep(1)
        except: pass

        sys.stderr.write("🖱️ Clicking hCaptcha checkbox via CDP...\n")
        sys.stderr.flush()

        # mouse_click uses CDP Input.dispatchMouseEvent (isTrusted=true)
        try:
            iframe_el.mouse_click()
            sys.stderr.write("✅ mouse_click done\n")
            sys.stderr.flush()
        except Exception as e:
            sys.stderr.write(f"⚠️ mouse_click: {e} — trying click()\n")
            sys.stderr.flush()
            try:
                iframe_el.click()
            except Exception as e2:
                sys.stderr.write(f"⚠️ click: {e2}\n")
                sys.stderr.flush()

        # Wait for token up to 90s
        sys.stderr.write("⏳ Waiting for hCaptcha token...\n")
        sys.stderr.flush()

        for i in range(45):
            sb.sleep(2)
            try:
                token = sb.loop.run_until_complete(sb.page.evaluate("""
                    () => {
                        var el = document.querySelector("[name='h-captcha-response']");
                        if (el && el.value && el.value.length > 10) return el.value;
                        // Also check data-hcaptcha-response attribute
                        var widget = document.querySelector('[data-hcaptcha-response]');
                        if (widget) {
                            var r = widget.getAttribute('data-hcaptcha-response');
                            if (r && r.length > 10) return r;
                        }
                        return '';
                    }
                """))
                if token and len(token) > 10:
                    sys.stderr.write(f"✅ Token obtained (len={len(token)})\n")
                    sys.stderr.flush()
                    return token
            except: pass

            # Re-click every 20s
            if i > 0 and i % 10 == 0:
                try:
                    iframe_el.mouse_click()
                    sys.stderr.write("🔄 Re-clicked hCaptcha\n")
                    sys.stderr.flush()
                except: pass

        sys.stderr.write("❌ Token not obtained after 90s\n")
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
