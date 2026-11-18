"""Generate Zodiac Timebox logo concepts into brand/."""
import math, os, re

OUT = "/Users/jo/Documents/Zodiac/zodiac-timebox/brand"
BLUE, LIGHT, DARK = "#469CED", "#B1D3F2", "#286CB2"
FONT = 'ui-sans-serif, system-ui, -apple-system, &quot;Segoe UI&quot;, sans-serif'
NS = 'xmlns="http://www.w3.org/2000/svg"'


def f(x):
    return ("%.2f" % x).rstrip("0").rstrip(".")


def pt(cx, cy, r, deg):
    a = math.radians(deg)
    return cx + r * math.cos(a), cy - r * math.sin(a)


# ---------- marks: drawn on a 64 x 64 grid, centred ----------
# Each returns SVG markup. fg = main colour, ac = accent colour.

def rise_angle(cx, cy, r, dcx, dcy, R, tuck=4):
    """Angle (deg, 90..180) where the sun path meets the horizon on the left, plus a tuck."""
    lo, hi = 90.0, 180.0
    for _ in range(60):
        mid = (lo + hi) / 2
        x, y = pt(cx, cy, r, mid)
        if math.hypot(x - dcx, y - dcy) > R:
            lo = mid
        else:
            hi = mid
    return lo + tuck


def sun_path(cx, cy, r, dcx, dcy, R, sw, color, tuck=4):
    a = rise_angle(cx, cy, r, dcx, dcy, R, tuck)
    x0, y0 = pt(cx, cy, r, a)
    x1, y1 = pt(cx, cy, r, 180 - a)
    return (f'<path d="M{f(x0)} {f(y0)}A{f(r)} {f(r)} 0 0 1 {f(x1)} {f(y1)}" '
            f'fill="none" stroke="{color}" stroke-width="{sw}"/>')


def horizon_dial(fg, ac):
    # horizon: chord y=50 from x=2..62, radius 44 (shallow, like the Zodiac horizon)
    # sun path: circle centre (32,44) r 26, rising out of the horizon; sun a third of the way
    R = 44
    dcy = 50 + math.sqrt(R * R - 30 * 30)
    sx, sy = pt(32, 44, 26, 128)
    return (
        sun_path(32, 44, 26, 32, dcy, R, 5, fg)
        + f'<path d="M2 50A44 44 0 0 1 62 50Z" fill="{ac}"/>'
        f'<circle cx="{f(sx)}" cy="{f(sy)}" r="7.5" fill="{fg}"/>'
    )


def box_hand(fg, ac):
    # box outline as a timer ring: the blue part is time already waited
    # rounded square 8..56, rx 14, path starts at top centre, clockwise
    ring = "M32 8H42A14 14 0 0 1 56 22V42A14 14 0 0 1 42 56H22A14 14 0 0 1 8 42V22A14 14 0 0 1 22 8Z"
    return (
        f'<path d="{ring}" fill="none" stroke="{fg}" stroke-width="6"/>'
        f'<path d="{ring}" pathLength="100" stroke-dasharray="17 83" fill="none" stroke="{ac}" stroke-width="6" stroke-linecap="butt"/>'
        f'<path d="M32 32L42.4 26" stroke="{fg}" stroke-width="5" stroke-linecap="round"/>'
        f'<circle cx="32" cy="32" r="5.5" fill="{fg}"/>'
    )


def hourglass(fg, ac):
    # two horizons: a dome hanging from the top (sand still waiting)
    # and a dome rising from the bottom (sand that has run)
    return (
        f'<path d="M9 7H55A23 23 0 0 1 32 30A23 23 0 0 1 9 7Z" fill="none" stroke="{fg}" stroke-width="5" stroke-linejoin="round"/>'
        f'<path d="M6.5 57A25.5 25.5 0 0 1 57.5 57Z" fill="{ac}"/>'
    )


def timelock(fg, ac):
    # padlock: the shackle is a timer; the blue part is time already waited
    shackle = "M19 32V23A13 13 0 0 1 45 23V32"
    return (
        f'<path d="{shackle}" fill="none" stroke="{fg}" stroke-width="6"/>'
        f'<path d="{shackle}" pathLength="100" stroke-dasharray="45 55" fill="none" stroke="{ac}" stroke-width="6"/>'
        f'<rect x="10" y="30" width="44" height="30" rx="9" fill="{fg}"/>'
    )


CONCEPTS = [
    dict(slug="horizon-dial", name="Horizon dial", fn=horizon_dial,
         idea="The Zodiac horizon, and the path of the sun above it. The sun has a way to go before the box opens.",
         word="TIMEBOX", pairing="wordmark"),
    dict(slug="box-and-hand", name="Box and hand", fn=box_hand,
         idea="The box is the clock. Its outline fills like a timer, and one hand counts the wait.",
         word="Timebox", pairing="tile"),
    dict(slug="hourglass-horizons", name="Two horizons", fn=hourglass,
         idea="The Zodiac horizon, mirrored. The two domes make an hourglass: sand waits above, sand has run below.",
         word="TIMEBOX", pairing="wordmark"),
    dict(slug="timelock", name="Timelock", fn=timelock,
         idea="A padlock whose shackle is a timer. It opens when the timer has run. Plain to read as a vault, even at 16 px.",
         word="Timebox", pairing="endorsed"),
]

# ---------- Zodiac assets (copied, not redrawn) ----------
ZDIR = os.path.join(OUT, "zodiac")
wordmark_src = open(os.path.join(ZDIR, "zodiac-logo-light.svg")).read()
WORD_PATHS = "".join(re.findall(r'<path d="[^"]+"', wordmark_src))
WORD_PATHS = WORD_PATHS.replace('<path d=', '<path d=').replace('"<path', '"/><path') + "/>"
# rebuild cleanly: every path, fill inherited
WORD_PATHS = "".join(f'<path d="{d}"/>' for d in re.findall(r'<path d="([^"]+)"', wordmark_src))
WORD_W, WORD_H = 1808, 324

icon_src = open(os.path.join(ZDIR, "zodiac-icon.svg")).read()


def zodiac_icon(x, y, size, uid):
    inner = re.search(r"<svg[^>]*>(.*)</svg>", icon_src, re.S).group(1)
    inner = inner.replace("_12524_39640", "_" + uid)
    inner = re.sub(r"\s+", " ", inner).replace("> <", "><").strip()
    return f'<svg x="{f(x)}" y="{f(y)}" width="{f(size)}" height="{f(size)}" viewBox="0 0 356 356">{inner}</svg>'


def wordmark(x, y, h):
    s = h / WORD_H
    return f'<g transform="translate({f(x)} {f(y)}) scale({f(s)})" fill="currentColor">{WORD_PATHS}</g>'


# ---------- text ----------
def tb_text(word, x, baseline, size, length):
    if word.isupper():
        style = f'font-family="{FONT}" font-weight="600" font-size="{size}"'
    else:
        style = f'font-family="{FONT}" font-weight="600" font-size="{size}" letter-spacing="-0.5"'
    return (f'<text x="{f(x)}" y="{f(baseline)}" {style} fill="currentColor" '
            f'textLength="{f(length)}" lengthAdjust="spacingAndGlyphs">{word}</text>')


def word_len(word, size):
    # widths tuned to system UI semibold; textLength pins them across fonts
    return size * (4.85 if word.isupper() else 3.72)


def svg(w, h, body, extra=""):
    return f'<svg {NS} viewBox="0 0 {f(w)} {f(h)}" width="{f(w)}" height="{f(h)}"{extra}>{body}</svg>\n'


def mark_at(c, x, y, size, fg="currentColor", ac=BLUE):
    s = size / 64
    return f'<g transform="translate({f(x)} {f(y)}) scale({f(s)})">{c["fn"](fg, ac)}</g>'


# ---------- app icons ----------
def app_icon(c):
    if c["slug"] == "horizon-dial":
        # bespoke: the horizon rises from the tile edge, as on the Zodiac icon
        sx, sy = pt(256, 400, 180, 128)
        body = (
            '<clipPath id="t"><rect width="512" height="512" rx="132"/></clipPath>'
            '<rect width="512" height="512" rx="132" fill="#000"/>'
            '<g clip-path="url(#t)">'
            + sun_path(256, 400, 180, 256, 870, 530, 30, "#fff", tuck=6)
            + f'<circle cx="256" cy="870" r="530" fill="{BLUE}"/>'
            f'<circle cx="{f(sx)}" cy="{f(sy)}" r="50" fill="#fff"/>'
            '</g>'
        )
        return svg(512, 512, body)
    body = '<rect width="512" height="512" rx="132" fill="#000"/>' + mark_at(c, 80, 80, 352, "#fff", BLUE)
    return svg(512, 512, body)


# ---------- lockups ----------
H = 64  # mark height in lockups
TS = 40  # text size


def lockup(c):
    L = word_len(c["word"], TS)
    w = H + 20 + L + 4
    body = mark_at(c, 0, 0, H) + tb_text(c["word"], H + 20, 46, TS, L)
    return svg(w, H, body)


def lockup_wordmark(c):
    # (b) real Zodiac wordmark, thin divider, mark + Timebox
    wh = 31  # wordmark height so its caps match Timebox caps
    ww = WORD_W * wh / WORD_H
    y0 = 46 - wh * 0.98
    L = word_len(c["word"], TS)
    dx = ww + 26
    mx = dx + 1.5 + 26
    w = mx + H + 20 + L + 4
    body = (wordmark(0, y0, wh)
            + f'<rect x="{f(dx)}" y="8" width="1.5" height="48" fill="currentColor" opacity=".35"/>'
            + mark_at(c, mx, 0, H)
            + tb_text(c["word"], mx + H + 20, 46, TS, L))
    return svg(w, H, body)


def lockup_tile(c):
    # (a) Zodiac icon tile + "Zodiac Timebox" set as text
    L1 = 40 * 2.62
    L2 = word_len("Timebox", 40)
    body = (zodiac_icon(0, 0, H, "zt")
            + f'<text x="84" y="46" font-family="{FONT}" font-weight="600" font-size="40" letter-spacing="-0.5" fill="currentColor" textLength="{f(L1)}" lengthAdjust="spacingAndGlyphs">Zodiac</text>'
            + f'<text x="{f(84 + L1 + 11)}" y="46" font-family="{FONT}" font-weight="400" font-size="40" letter-spacing="-0.5" fill="currentColor" textLength="{f(L2)}" lengthAdjust="spacingAndGlyphs">Timebox</text>')
    return svg(84 + L1 + 11 + L2 + 4, H, body)


def lockup_endorsed(c):
    L = word_len(c["word"], TS)
    wh = 9.5
    ww = WORD_W * wh / WORD_H
    bx = H + 20
    body = (mark_at(c, 0, 0, H)
            + tb_text(c["word"], bx, 38, TS, L)
            + f'<text x="{f(bx + 1)}" y="59" font-family="{FONT}" font-weight="500" font-size="11" fill="currentColor" opacity=".6">by</text>'
            + f'<g opacity=".6">{wordmark(bx + 17, 59 - wh * 0.98, wh)}</g>')
    return svg(max(bx + L + 4, bx + 17 + ww + 2), H, body)


PAIRING = {"wordmark": lockup_wordmark, "tile": lockup_tile, "endorsed": lockup_endorsed}
PAIRING_NOTE = {
    "wordmark": "Paired: Zodiac wordmark, divider, Timebox.",
    "tile": "Paired: Zodiac icon tile with Zodiac Timebox set as text.",
    "endorsed": "Paired: endorsed, Timebox with a small by Zodiac line.",
}

files = {}
for c in CONCEPTS:
    d = os.path.join(OUT, c["slug"])
    os.makedirs(d, exist_ok=True)
    files[c["slug"]] = {
        "mark.svg": svg(64, 64, c["fn"]("currentColor", BLUE)),
        "app-icon.svg": app_icon(c),
        "lockup.svg": lockup(c),
        "lockup-zodiac.svg": PAIRING[c["pairing"]](c),
        "lockup-endorsed.svg": lockup_endorsed(c),
    }
    for name, content in files[c["slug"]].items():
        open(os.path.join(d, name), "w").write(content)


# ---------- concepts.html ----------
def inline(s, uid):
    s = s.replace('id="t"', f'id="t-{uid}"').replace("url(#t)", f"url(#t-{uid})")
    s = s.replace('id="tl-body"', f'id="tl-{uid}"').replace("url(#tl-body)", f"url(#tl-{uid})")
    s = re.sub(r'(clip[01]_|paint0_radial_)zt', lambda m: m.group(1) + "zt" + uid, s)
    s = s.replace("_zt\"", f"_zt{uid}\"").replace("_zt)", f"_zt{uid})")
    return s.strip()


n = [0]


def uid():
    n[0] += 1
    return f"u{n[0]}"


def panels(svgtext, cls=""):
    return (f'<div class="pair {cls}"><div class="panel light">{inline(svgtext, uid())}</div>'
            f'<div class="panel dark">{inline(svgtext, uid())}</div></div>')


sections = []
for c in CONCEPTS:
    s = c["slug"]
    F = files[s]
    sizes = "".join(
        f'<figure><img src="{s}/app-icon.svg" width="{px}" height="{px}" alt=""><figcaption>{px}</figcaption></figure>'
        for px in (512, 64, 32, 16))
    small = "".join(
        f'<figure><div class="m" style="width:{px}px;height:{px}px">{inline(F["mark.svg"], uid())}</div><figcaption>{px}</figcaption></figure>'
        for px in (64, 32, 16)) + "".join(
        f'<figure><div class="m" style="width:{px}px;height:{px}px">{inline(svg(64, 64, c["fn"]("currentColor", "currentColor")), uid())}</div><figcaption>{px} mono</figcaption></figure>'
        for px in (64, 16))
    sections.append(f"""
<section>
  <header><h2>{c['name']}</h2><code>{s}/</code></header>
  <p class="idea">{c['idea']}</p>
  <h3>App icon</h3>
  <div class="sizes">{sizes}</div>
  <h3>Mark, with accent and in one colour</h3>
  <div class="pair marks"><div class="panel light row">{small}</div><div class="panel dark row">{small}</div></div>
  <h3>Lockup</h3>
  {panels(F['lockup.svg'])}
  <h3>{PAIRING_NOTE[c['pairing']]}</h3>
  {panels(F['lockup-zodiac.svg'])}
  {'' if c['pairing']=='endorsed' else '<h3>Endorsed</h3>' + panels(F['lockup-endorsed.svg'])}
</section>""")

RECO = open(os.path.join(os.path.dirname(__file__), "reco.txt")).read().strip() if os.path.exists(
    os.path.join(os.path.dirname(__file__), "reco.txt")) else "TBD"

html = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Timebox logo concepts</title>
<style>
  :root {{ --ink:#0b0b0b; --paper:#fff; --muted:#6b6b6b; --line:#e6e6e6; --night:#0e0e0e; }}
  * {{ box-sizing:border-box; }}
  body {{ margin:0; background:#f4f4f4; color:var(--ink); font-family:ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }}
  main {{ max-width:1180px; margin:0 auto; padding:56px 16px 96px; }}
  h1 {{ font-size:44px; font-weight:600; letter-spacing:-0.02em; text-align:center; margin:0 0 8px; }}
  .lede {{ text-align:center; color:var(--muted); margin:0 0 56px; }}
  section {{ background:var(--paper); border-radius:28px; padding:32px; margin-bottom:32px; }}
  section header {{ display:flex; align-items:baseline; gap:12px; }}
  h2 {{ font-size:26px; font-weight:600; margin:0; letter-spacing:-0.01em; }}
  code {{ color:var(--muted); font-size:13px; }}
  .idea {{ margin:6px 0 24px; color:#333; }}
  h3 {{ font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); margin:28px 0 10px; }}
  .sizes {{ display:flex; align-items:flex-end; gap:28px; flex-wrap:wrap; }}
  figure {{ margin:0; display:flex; flex-direction:column; align-items:center; gap:6px; }}
  .sizes figure:first-child img {{ max-width:100%; height:auto; }}
  figcaption {{ font-size:11px; color:var(--muted); }}
  .pair {{ display:grid; grid-template-columns:1fr 1fr; gap:12px; }}
  .panel {{ border-radius:20px; padding:36px 28px; display:flex; align-items:center; justify-content:center; min-height:150px; }}
  .panel svg {{ max-width:100%; height:auto; }}
  .light {{ background:#fff; color:var(--ink); border:1px solid var(--line); }}
  .dark {{ background:var(--night); color:#fff; }}
  .row {{ gap:28px; align-items:flex-end; min-height:110px; }}
  .dark figcaption {{ color:#8a8a8a; }}
  .m svg {{ width:100%; height:100%; display:block; }}
  .reco {{ background:var(--ink); color:#fff; border-radius:28px; padding:32px; }}
  .reco h2 {{ margin-bottom:10px; }}
  .reco p {{ margin:0; max-width:760px; line-height:1.5; color:#ddd; }}
  .reco b {{ color:{BLUE}; font-weight:600; }}
  @media (max-width:760px) {{ .pair {{ grid-template-columns:1fr; }} section {{ padding:20px; }} h1 {{ font-size:32px; }} }}
</style>
</head>
<body>
<main>
<h1>Timebox logo concepts</h1>
<p class="lede">Four marks for Zodiac Timebox. Each shown as app icon, in one colour, alone and with Zodiac.</p>
{''.join(sections)}
<div class="reco"><h2>Recommendation</h2><p>{RECO}</p></div>
</main>
</body>
</html>
"""
open(os.path.join(OUT, "concepts.html"), "w").write(html)
print("ok")
