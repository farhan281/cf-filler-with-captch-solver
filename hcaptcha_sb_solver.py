"""
SeleniumBase CDP hCaptcha solver.
Finds hCaptcha checkbox iframe and clicks it using CDP mouse events.
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
        sb.sleep(8)

        # Find hCaptcha iframe position from page source
        pos = None
        try:
            pos = sb.loop.run_until_complete(sb.page.evaluate("""
                () => {
                    // Search all elements including shadow DOM
                    function findHcaptcha(root) {
                        var all = root.querySelectorAll('*');
                        for (var el of all) {
                            // Check iframe src
                            if (el.tagName === 'IFRAME') {
                                var src = el.src || el.getAttribute('src') || '';
                                if (src.includes('hcaptcha') && src.includes('checkbox')) {
                                    var r = el.getBoundingClientRect();
                                    if (r.width > 0 && r.height > 0)
                                        return {x: r.left + r.width/2, y: r.top + r.height/2, type: 'iframe'};
                                }
                            }
                            // Check data attributes
                            var attrs = el.getAttributeNames ? el.getAttributeNames() : [];
                            for (var a of attrs) {
                                var v = el.getAttribute(a) || '';
                                if (v.includes('hcaptcha') || a.includes('hcaptcha')) {
                                    var r = el.getBoundingClientRect();
                                    if (r.width > 0 && r.height > 0)
                                        return {x: r.left + r.width/2, y: r.top + r.height/2, type: 'element'};
                                }
                            }
                            // Check shadow root
                            if (el.shadowRoot) {
                                var res = findHcaptcha(el.shadowRoot);
                                if (res) return res;
                            }
                        }
                        return null;
                    }
                    return findHcaptcha(document);
                }
            """))
        except Exception as e:
            sys.stderr.write(f"⚠️ Find element: {e}\n")
            sys.stderr.flush()

        if not pos:
            # Fallback: search all iframes via CDP
            try:
                iframes = sb.loop.run_until_complete(sb.page.evaluate("""
                    () => Array.from(document.querySelectorAll('iframe')).map(f => ({
                        src: f.src || '',
                        rect: f.getBoundingClientRect()
                    }))
                """))
                sys.stderr.write(f"All iframes: {iframes}\n")
                sys.stderr.flush()
            except: pass
            sys.stderr.write("❌ hCaptcha element not found on page\n")
            sys.stderr.flush()
            return ""

        x, y = pos['x'], pos['y']
        sys.stderr.write(f"🖱️ Clicking hCaptcha ({pos['type']}) at ({x:.0f}, {y:.0f})\n")
        sys.stderr.flush()

        # CDP mouse click (isTrusted=true, bypasses bot detection)
        sb.loop.run_until_complete(sb.page.mouse.move(x, y))
        sb.sleep(0.5)
        sb.loop.run_until_complete(sb.page.mouse.click(x, y))
        sys.stderr.write("✅ CDP click dispatched\n")
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
                        return el ? el.value : '';
                    }
                """))
                if token and len(token) > 10:
                    sys.stderr.write(f"✅ Token obtained (len={len(token)})\n")
                    sys.stderr.flush()
                    return token
            except: pass

            # Re-click every 20s if no token yet
            if i > 0 and i % 10 == 0:
                try:
                    sb.loop.run_until_complete(sb.page.mouse.click(x, y))
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
