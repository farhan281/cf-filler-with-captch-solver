"""
SeleniumBase CDP hCaptcha solver.
Uses CDP Input.dispatchMouseEvent (isTrusted=true) to click hCaptcha checkbox.
Protocol: reads URL from stdin, writes token to stdout
"""
import sys, time, asyncio, os

sys.stderr.write("🔄 Starting hCaptcha CDP solver...\n")
sys.stderr.flush()

# Use existing display
if not os.environ.get('DISPLAY'):
    os.environ['DISPLAY'] = ':0'
sys.stderr.write(f"✅ Using display: {os.environ.get('DISPLAY')}\n")
sys.stderr.flush()

from seleniumbase import sb_cdp

def solve_hcaptcha(url: str) -> str:
    sb = None
    try:
        sb = sb_cdp.Chrome(url, lang="en")
        sb.sleep(5)

        # Wait for hCaptcha iframe to load
        for _ in range(10):
            src = sb.get_page_source()
            if 'hcaptcha' in src.lower():
                break
            sb.sleep(1)

        sb.sleep(3)

        # Try to find and click hCaptcha checkbox iframe
        # hCaptcha has two iframes: checkbox iframe and challenge iframe
        clicked = False

        # Method 1: CDP click on hCaptcha checkbox iframe
        try:
            # Get iframe position using CDP
            result = sb.loop.run_until_complete(
                sb.page.evaluate("""
                    () => {
                        var iframes = Array.from(document.querySelectorAll('iframe'));
                        for (var f of iframes) {
                            var src = f.src || '';
                            if (src.includes('hcaptcha') && src.includes('checkbox')) {
                                var r = f.getBoundingClientRect();
                                return {x: r.left + r.width/2, y: r.top + r.height/2, found: true};
                            }
                        }
                        // Try any hcaptcha iframe
                        for (var f of iframes) {
                            var src = f.src || '';
                            if (src.includes('hcaptcha')) {
                                var r = f.getBoundingClientRect();
                                return {x: r.left + r.width/2, y: r.top + r.height/2, found: true};
                            }
                        }
                        // Try h-captcha element
                        var el = document.querySelector('.h-captcha, h-captcha, [data-hcaptcha-widget-id]');
                        if (el) {
                            var r = el.getBoundingClientRect();
                            return {x: r.left + 30, y: r.top + 30, found: true};
                        }
                        return {found: false};
                    }
                """)
            )
            if result and result.get('found'):
                x, y = result['x'], result['y']
                sys.stderr.write(f"🖱️ Clicking hCaptcha at ({x:.0f}, {y:.0f})\n")
                sys.stderr.flush()
                # Use CDP to dispatch mouse events (isTrusted=true)
                sb.loop.run_until_complete(sb.page.mouse.move(x, y))
                sb.sleep(0.5)
                sb.loop.run_until_complete(sb.page.mouse.click(x, y))
                clicked = True
                sys.stderr.write("✅ CDP click dispatched\n")
                sys.stderr.flush()
        except Exception as e:
            sys.stderr.write(f"⚠️ CDP click: {e}\n")
            sys.stderr.flush()

        # Method 2: PyAutoGUI click as fallback
        if not clicked:
            try:
                import pyautogui
                pyautogui.FAILSAFE = False
                # Find iframe position via JS
                pos = sb.loop.run_until_complete(
                    sb.page.evaluate("""
                        () => {
                            var f = document.querySelector('iframe[src*="hcaptcha"]');
                            if (!f) return null;
                            var r = f.getBoundingClientRect();
                            return {x: Math.round(r.left + 24), y: Math.round(r.top + 24)};
                        }
                    """)
                )
                if pos:
                    pyautogui.moveTo(pos['x'], pos['y'], duration=0.3)
                    pyautogui.click()
                    clicked = True
                    sys.stderr.write(f"✅ PyAutoGUI click at ({pos['x']}, {pos['y']})\n")
                    sys.stderr.flush()
            except Exception as e:
                sys.stderr.write(f"⚠️ PyAutoGUI: {e}\n")
                sys.stderr.flush()

        if not clicked:
            sys.stderr.write("❌ Could not click hCaptcha\n")
            sys.stderr.flush()
            return ""

        # Wait for token up to 90s
        sys.stderr.write("⏳ Waiting for hCaptcha token...\n")
        sys.stderr.flush()
        for i in range(45):
            sb.sleep(2)
            try:
                token = sb.loop.run_until_complete(
                    sb.page.evaluate(
                        "document.querySelector(\"[name='h-captcha-response']\")?.value || ''"
                    )
                )
                if token and len(token) > 10:
                    sys.stderr.write(f"✅ Token obtained (len={len(token)})\n")
                    sys.stderr.flush()
                    return token
            except: pass

            # Re-click every 20s if no token
            if i > 0 and i % 10 == 0 and clicked:
                try:
                    if result and result.get('found'):
                        sb.loop.run_until_complete(sb.page.mouse.click(result['x'], result['y']))
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
