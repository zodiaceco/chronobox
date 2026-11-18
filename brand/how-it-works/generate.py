"""Generate how-it-works options A, B, C and the comparison sheet."""
import math, os

OUT = "/Users/jo/Documents/Zodiac/zodiac-timebox/brand/how-it-works"
BLUE = "#469CED"
LIGHT = "#B1D3F2"
F = lambda v: f"{v:.2f}".rstrip("0").rstrip(".")

STEPS = [
    ("Set up", "Create your Timebox with your wallet."),
    ("Set the delay", "Choose how long every withdrawal must wait."),
    ("Deposit", "Send money to your Timebox."),
    ("Peace of mind", "Nobody can take it in a hurry."),
]
PILLS = '<span class="hiw-pills"><span>1 day</span><span>1 week</span><span aria-label="Custom">+</span></span>'


def svg(vb_w, vb_h, body, w=None, h=None, cls=""):
    w = w or vb_w
    h = h or vb_h
    c = f' class="{cls}"' if cls else ""
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {F(vb_w)} {F(vb_h)}" '
            f'width="{F(w)}" height="{F(h)}"{c} aria-hidden="true" focusable="false">{body}</svg>')


def arc(cx, cy, r, a0, a1, sw=5):
    """Arc from angle a0 to a1 (degrees, 0 = right, counter-clockwise, y up)."""
    p0 = (cx + r * math.cos(math.radians(a0)), cy - r * math.sin(math.radians(a0)))
    p1 = (cx + r * math.cos(math.radians(a1)), cy - r * math.sin(math.radians(a1)))
    large = 1 if abs(a0 - a1) > 180 else 0
    return (f'<path d="M{F(p0[0])} {F(p0[1])}A{F(r)} {F(r)} 0 {large} 1 {F(p1[0])} {F(p1[1])}" '
            f'fill="none" stroke="currentColor" stroke-width="{F(sw)}"/>')


def on(cx, cy, r, a):
    return cx + r * math.cos(math.radians(a)), cy - r * math.sin(math.radians(a))


def dot(x, y, r, fill="currentColor"):
    return f'<circle cx="{F(x)}" cy="{F(y)}" r="{F(r)}" fill="{fill}"/>'


def dome(x0, x1, y, sag, fill=BLUE):
    half = (x1 - x0) / 2
    R = (half * half + sag * sag) / (2 * sag)
    return f'<path d="M{F(x0)} {F(y)}A{F(R)} {F(R)} 0 0 1 {F(x1)} {F(y)}Z" fill="{fill}"/>'


def dome_y(x0, x1, y, sag, x):
    half = (x1 - x0) / 2
    R = (half * half + sag * sag) / (2 * sag)
    cy = y - sag + R
    return cy - math.sqrt(R * R - (x - (x0 + x1) / 2) ** 2)


# ---------------------------------------------------------------- Option A
# Four pictograms on the mark's 64 grid, stroke 5.
MARK_ARC = ('<path d="M6.06 45.81A26 26 0 0 1 57.94 45.81" fill="none" '
            'stroke="currentColor" stroke-width="5"/>')
MARK_DOME = f'<path d="M2 50A44 44 0 0 1 62 50Z" fill="{BLUE}"/>'
MCX, MCY, MR = 32, 47.58, 26


def resting_angle(start, step, r_sun, cx=MCX, cy=MCY, R=MR):
    """Walk along the mark arc until the sun touches the mark dome."""
    a = start
    while True:
        x, y = on(cx, cy, R, a)
        dy = 82.19 - math.sqrt(44 * 44 - (x - 32) ** 2)
        if y + r_sun >= dy - 0.2:
            return a
        a += step


a_rise = resting_angle(110, 0.25, 7.5)
a_set = resting_angle(70, -0.25, 7.5)

A = {}
# 1 Set up: a wallet.
A[1] = (
    '<path d="M15 19L43 9.5L47 19" fill="none" stroke="currentColor" stroke-width="5" stroke-linejoin="round"/>'
    '<rect x="8.5" y="19" width="47" height="35" rx="7" fill="none" stroke="currentColor" stroke-width="5"/>'
    f'<rect x="37" y="29.5" width="21" height="14" rx="7" fill="{BLUE}"/>'
    + dot(44.5, 36.5, 3.5)
)
# 2 Set the delay: the sun starts its path.
A[2] = '<g transform="translate(0 6)">' + MARK_ARC + dot(*on(MCX, MCY, MR, a_rise), 7.5) + MARK_DOME + '</g>'
# 3 Deposit: a coin goes down into a tray.
A[3] = (
    '<path d="M32 3V13M26 8L32 14L38 8" fill="none" stroke="currentColor" stroke-width="5" '
    'stroke-linecap="round" stroke-linejoin="round"/>'
    + dot(32, 29, 9, BLUE)
    + '<path d="M8.5 32V45a9 9 0 0 0 9 9H46.5a9 9 0 0 0 9-9V32" fill="none" stroke="currentColor" stroke-width="5"/>'
)
# 4 Peace of mind: the sun rests on the horizon at the end of its path.
A[4] = '<g transform="translate(0 6)">' + MARK_ARC + dot(*on(MCX, MCY, MR, a_set), 7.5) + MARK_DOME + '</g>'

# ---------------------------------------------------------------- Option B
BW, BH = 680, 200
D_SAG, D_Y = 30, BH  # dome from (0,200) to (680,200), top 170
ST = [85, 255, 425, 595]  # column centres of 4 x 170
hy = dome_y(0, BW, D_Y, D_SAG, ST[0])
top = 22
# Sun path: circle through (85, hy+6) and (595, hy+6) with top at `top`.
half = (ST[3] - ST[0]) / 2
sag = hy + 6 - top
BR = (half * half + sag * sag) / (2 * sag)
BCX, BCY = BW / 2, top + BR
a_end = math.degrees(math.atan2(BCY - (hy + 6), ST[0] - BCX))  # left end, ~>90
B_SW = 6


def b_point_x(x):
    return x, BCY - math.sqrt(BR * BR - (x - BCX) ** 2)


def b_rest(xstart, xstep, r):
    x = xstart
    while True:
        px, py = b_point_x(x)
        if py + r >= dome_y(0, BW, D_Y, D_SAG, px) - 0.5:
            return px, py
        x += xstep


bead_r = 9
sun_r = 17
s1 = b_rest(BCX - 100, -0.25, bead_r)
s4 = b_rest(BCX + 100, 0.25, sun_r)
B_BODY = (
    f'<path d="M{F(s1[0])} {F(s1[1])}A{F(BR)} {F(BR)} 0 0 1 {F(s4[0])} {F(s4[1])}" '
    f'fill="none" stroke="currentColor" stroke-width="{B_SW}"/>'
    + dome(0, BW, D_Y, D_SAG)
    + dot(*s1, bead_r, BLUE)
    + dot(*b_point_x(ST[1]), bead_r, BLUE)
    + dot(*b_point_x(ST[2]), bead_r, BLUE)
    + dot(*s4, sun_r)
)
# Move stations 1 and 4 to the column centres? They rest on the horizon instead;
# report where they ended up so the captions can be checked against them.
print("B station 1", s1, "station 4", s4)

# ---------------------------------------------------------------- Option C
# One box, four states, 64 grid, stroke 5.
C_OPEN = ('<path d="M6.5 14V49.5a10 10 0 0 0 10 10H47.5a10 10 0 0 0 10-10V14" fill="none" '
          'stroke="currentColor" stroke-width="5"/>')
C_CLOSED = ('<rect x="6.5" y="14" width="51" height="45.5" rx="10" fill="none" '
            'stroke="currentColor" stroke-width="5"/>')
CCX, CCY, CR = 32, 51, 16
C_ARC = arc(CCX, CCY, CR, 188, -8)
DM = (13, 51, 55, 8)
C_DOME = dome(*DM)


def c_rest(a, step, r):
    while True:
        x, y = on(CCX, CCY, CR, a)
        if y + r >= dome_y(*DM, x) - 0.2:
            return a
        a += step


c_r = 5.5
c_start = c_rest(100, 0.25, c_r)
C = {}
C[1] = C_OPEN
C[2] = C_OPEN + C_ARC + dot(*on(CCX, CCY, CR, c_start), c_r)
C[3] = (C_OPEN + C_ARC + dot(*on(CCX, CCY, CR, c_start), c_r) + C_DOME
        + dot(32, 9, 6.5, BLUE))
C[4] = C_CLOSED + C_ARC + dot(*on(CCX, CCY, CR, 128), c_r) + C_DOME

# ---------------------------------------------------------------- CSS
BASE_CSS = """
/* Shared. Move into styles.css: the app CSP forbids inline styles. */
.hiw { container-type: inline-size; color: var(--fg, #0b0b0c); font-family: var(--font, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif); }
.hiw ol { list-style: none; margin: 0; padding: 0; }
.hiw svg { display: block; overflow: visible; }
.hiw-title { font-size: 15px; font-weight: 600; line-height: 1.3; margin: 0; }
.hiw-text { font-size: 14px; line-height: 1.4; color: var(--muted, #6a6a70); margin: 2px 0 0; }
.hiw-num { display: inline-grid; place-items: center; min-width: 22px; height: 22px; padding: 0 6px; border-radius: 999px;
  background: var(--blue-wash, #eef6fd); color: var(--blue-text, #1f5fa3); font-size: 13px; font-weight: 600; line-height: 1; }
.hiw-pills { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
.hiw-pills span { display: inline-flex; align-items: center; height: 26px; padding: 0 8px; border-radius: 999px;
  border: 1.5px solid var(--line-strong, #c9c9ce); font-size: 13px; font-weight: 500; color: var(--fg, #0b0b0c); white-space: nowrap; }
"""

A_CSS = """
/* Option A: four glyphs in a row; a list with a rail below 480px. */
.hiw-a ol { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0; }
.hiw-a li { position: relative; display: flex; flex-direction: column; align-items: center; text-align: center; padding: 0 4px; }
.hiw-a .hiw-art { width: 72px; height: 72px; margin-bottom: 14px; }
.hiw-a li + li::before { content: ""; position: absolute; top: 36px; right: calc(50% + 50px); left: calc(-50% + 50px);
  border-top: 2px dotted currentColor; opacity: .35; }
.hiw-a .hiw-copy { display: flex; flex-direction: column; align-items: center; }
.hiw-a .hiw-num { margin-bottom: 6px; }
.hiw-a .hiw-pills { justify-content: center; }
@container (max-width: 480px) {
  .hiw-a ol { grid-template-columns: 1fr; gap: 22px; }
  .hiw-a li { flex-direction: row; align-items: flex-start; gap: 16px; text-align: left; padding: 0; }
  .hiw-a .hiw-art { flex: none; width: 56px; height: 56px; margin: 0; }
  .hiw-a .hiw-copy { align-items: flex-start; }
  .hiw-a li + li::before { top: -19px; height: 16px; left: 27px; right: auto; border-top: 0; border-left: 2px dotted currentColor; }
  .hiw-a .hiw-num { margin-bottom: 4px; }
  .hiw-a .hiw-pills { justify-content: flex-start; }
}
"""

B_CSS = """
/* Option B: one scene; four columns under it, a list below 480px. */
.hiw-b .hiw-scene { width: 100%; height: auto; margin-bottom: 14px; }
.hiw-b ol { display: grid; grid-template-columns: repeat(4, 1fr); }
.hiw-b li { display: flex; flex-direction: column; align-items: center; text-align: center; padding: 0 4px; }
.hiw-b .hiw-copy { display: flex; flex-direction: column; align-items: center; }
.hiw-b .hiw-num { margin-bottom: 6px; }
.hiw-b .hiw-pills { justify-content: center; }
.hiw-b .hiw-marks { display: none; }
@container (max-width: 480px) {
  .hiw-b .hiw-scene { margin-bottom: 6px; }
  .hiw-b .hiw-marks { display: grid; grid-template-columns: repeat(4, 1fr); justify-items: center; margin-bottom: 18px; }
  .hiw-b ol { grid-template-columns: 1fr; gap: 16px; }
  .hiw-b li { align-items: stretch; text-align: left; padding: 0; }
  .hiw-b .hiw-copy { position: relative; display: block; padding-left: 34px; }
  .hiw-b .hiw-copy > .hiw-num { position: absolute; left: 0; top: 0; margin: 0; }
  .hiw-b .hiw-pills { justify-content: flex-start; }
}
"""

C_CSS = """
/* Option C: one box, four states; 2 x 2 cards, one column below 480px. */
.hiw-c ol { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.hiw-c li { display: grid; grid-template-columns: 72px 1fr; column-gap: 16px; align-items: start; padding: 18px;
  border: 1px solid var(--line, #e5e5e8); border-radius: var(--radius, 14px); }
.hiw-c .hiw-art { width: 72px; height: 72px; }
.hiw-c .hiw-copy { display: flex; flex-direction: column; align-items: flex-start; }
.hiw-c .hiw-num { margin-bottom: 6px; }
@container (max-width: 480px) {
  .hiw-c ol { grid-template-columns: 1fr; gap: 10px; }
  .hiw-c li { grid-template-columns: 56px 1fr; column-gap: 14px; padding: 14px; }
  .hiw-c .hiw-art { width: 56px; height: 56px; }
}
"""


def caption(i, num=True):
    t, d = STEPS[i - 1]
    n = f'<span class="hiw-num">{i}</span>' if num else ""
    p = PILLS if i == 2 else ""
    return f'<div class="hiw-copy">{n}<p class="hiw-title">{t}</p><p class="hiw-text">{d}</p>{p}</div>'


def glyph(body):
    return svg(64, 64, body, cls="hiw-art")


def markup(opt):
    if opt == "a":
        lis = "".join(f"<li>{glyph(A[i])}{caption(i)}</li>" for i in range(1, 5))
        return f'<div class="hiw hiw-a"><ol>{lis}</ol></div>'
    if opt == "b":
        scene = svg(BW, BH, B_BODY, cls="hiw-scene")
        marks = '<div class="hiw-marks" aria-hidden="true">' + "".join(
            f'<span class="hiw-num">{i}</span>' for i in range(1, 5)) + "</div>"
        lis = "".join(f"<li>{caption(i)}</li>" for i in range(1, 5))
        return f'<div class="hiw hiw-b">{scene}{marks}<ol>{lis}</ol></div>'
    if opt == "c":
        lis = "".join(f"<li>{glyph(C[i])}{caption(i)}</li>" for i in range(1, 5))
        return f'<div class="hiw hiw-c"><ol>{lis}</ol></div>'


CSS = {"a": A_CSS, "b": B_CSS, "c": C_CSS}
TOKENS = """
:root { --fg:#0b0b0c; --muted:#6a6a70; --line:#e5e5e8; --line-strong:#c9c9ce; --blue-wash:#eef6fd; --blue-text:#1f5fa3; --radius:14px; }
@media (prefers-color-scheme: dark) { :root { --fg:#f4f4f5; --muted:#9a9aa2; --line:#26262a; --line-strong:#3a3a40; --blue-wash:#0f1c2a; --blue-text:#8fc3f5; } }
body { margin:0; padding:32px 16px; background:#fff; color:var(--fg); }
@media (prefers-color-scheme: dark) { body { background:#0b0b0c; } }
.demo { max-width:680px; margin:0 auto; }
"""

NAMES = {"a": "Four glyphs", "b": "One horizon", "c": "The box over time"}

for opt in "abc":
    d = os.path.join(OUT, f"option-{opt}")
    os.makedirs(d, exist_ok=True)
    if opt == "b":
        open(os.path.join(d, "graphic.svg"), "w").write(svg(BW, BH, B_BODY) + "\n")
    else:
        src = A if opt == "a" else C
        for i in range(1, 5):
            open(os.path.join(d, f"step-{i}.svg"), "w").write(svg(64, 64, src[i]) + "\n")
    snippet = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>How it works, option {opt.upper()}</title>
<style>
/* Demo page only: app tokens. In the app these come from styles.css. */{TOKENS}
{BASE_CSS}{CSS[opt]}</style>
</head>
<body>
<div class="demo">
<!-- How it works, option {opt.upper()}: {NAMES[opt]}. Copy and pill labels are HTML. -->
{markup(opt)}
</div>
</body>
</html>
"""
    open(os.path.join(d, "snippet.html"), "w").write(snippet)

# ---------------------------------------------------------------- Sheet
DESC = {
    "a": "Four small pictograms in the mark's vocabulary: a wallet, the sun leaving the horizon, a coin going into a tray, the sun at rest. On a phone they become a list.",
    "b": "One wide scene: the sun's path crosses the Zodiac horizon, the four steps are stations on it, and at step 4 the sun rests on the horizon.",
    "c": "One box in four states: open and empty, the dial set, money in, then closed. The last state is the app icon.",
}


def panels(opt):
    m = markup(opt)
    return f"""
  <div class="label">Desktop, 680 px</div>
  <div class="frame light desk">{m}</div>
  <div class="frame dark desk">{m}</div>
  <div class="label">Phone, 290 px</div>
  <div class="phones">
    <div class="frame light phone">{m}</div>
    <div class="frame dark phone">{m}</div>
  </div>"""


sections = "".join(f"""
<section id="option-{o}">
  <header><h2>Option {o.upper()}. {NAMES[o]}</h2><code>option-{o}/</code></header>
  <p class="idea">{DESC[o]}</p>{panels(o)}
</section>""" for o in "abc")

sheet = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>How it works options</title>
<style>
* {{ box-sizing: border-box; }}
body {{ margin: 0; background: #f4f4f4; color: #0b0b0c; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }}
main {{ max-width: 860px; margin: 0 auto; padding: 56px 16px 96px; }}
h1 {{ font-size: 40px; font-weight: 600; letter-spacing: -0.02em; text-align: center; margin: 0 0 8px; }}
.lede {{ text-align: center; color: #6b6b6b; margin: 0 0 48px; }}
section {{ background: #fff; border-radius: 28px; padding: 32px; margin-bottom: 32px; }}
section header {{ display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }}
h2 {{ font-size: 24px; font-weight: 600; margin: 0; letter-spacing: -0.01em; }}
code {{ color: #6b6b6b; font-size: 13px; }}
.idea {{ margin: 6px 0 8px; color: #333; line-height: 1.5; }}
.label {{ font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .08em; color: #6b6b6b; margin: 24px 0 10px; }}
.frame {{ border-radius: 20px; padding: 32px 18px; margin: 0 auto 12px; }}
.frame.desk {{ width: 718px; max-width: 100%; }}
.frame.phone {{ width: 328px; margin: 0; }}
.phones {{ display: flex; gap: 12px; flex-wrap: wrap; justify-content: center; align-items: flex-start; }}
.light {{ background: #fff; border: 1px solid #e6e6e6;
  --fg:#0b0b0c; --muted:#6a6a70; --line:#e5e5e8; --line-strong:#c9c9ce; --blue-wash:#eef6fd; --blue-text:#1f5fa3; }}
.dark {{ background: #0b0b0c; border: 1px solid #0b0b0c;
  --fg:#f4f4f5; --muted:#9a9aa2; --line:#26262a; --line-strong:#3a3a40; --blue-wash:#0f1c2a; --blue-text:#8fc3f5; }}
.reco {{ background: #0b0b0c; color: #fff; border-radius: 28px; padding: 32px; }}
.reco h2 {{ margin-bottom: 10px; }}
.reco p {{ margin: 0; line-height: 1.5; color: #ddd; }}
.reco b {{ color: #469CED; font-weight: 600; }}
@media (max-width: 760px) {{ section {{ padding: 20px; }} h1 {{ font-size: 30px; }} }}
{BASE_CSS}{A_CSS}{B_CSS}{C_CSS}
</style>
</head>
<body>
<main>
<h1>How it works</h1>
<p class="lede">Three options for the four steps on the Timebox start page. Each on white and on near-black, at 680 px and at 290 px.</p>
{sections}
<section class="reco">
  <h2>Recommendation</h2>
  <p>__RECO__</p>
</section>
</main>
</body>
</html>
"""
RECO = open(os.path.join(os.path.dirname(__file__), "reco.txt")).read().strip() if os.path.exists(
    os.path.join(os.path.dirname(__file__), "reco.txt")) else "TBD"
open(os.path.join(OUT, "index.html"), "w").write(sheet.replace("__RECO__", RECO))
print("ok", a_rise, a_set, c_start)
