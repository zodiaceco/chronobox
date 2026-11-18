"""Chronobox logo variants: one sheet, brand/logo-variants/index.html.

Every variant starts from the mark in use ("Horizon dial"): the blue Zodiac horizon,
the path of the sun above it, and the sun. Drawn on a 64 x 64 grid.

    python3 brand/logo-variants/generate.py
"""
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
BLUE, LIGHT = "#469CED", "#B1D3F2"
CX, CY, R = 32, 47.58, 26  # the path of the sun
ARC = "M6.06 45.81A26 26 0 0 1 57.94 45.81"
DOME = "M2 50A44 44 0 0 1 62 50Z"
LOGO_DEG = 123.6  # where the sun sits in the mark in use


def f(x):
    return ("%.2f" % x).rstrip("0").rstrip(".")


def at(deg, r=R):
    a = math.radians(deg)
    return CX + r * math.cos(a), CY - r * math.sin(a)


def arc(a0, a1, sw=5, color="currentColor", opacity=1, cap="butt"):
    """Part of the path, from angle a0 down to a1 (left to right)."""
    x0, y0 = at(a0)
    x1, y1 = at(a1)
    op = "" if opacity == 1 else f' opacity="{opacity}"'
    return (f'<path d="M{f(x0)} {f(y0)}A{R} {R} 0 0 1 {f(x1)} {f(y1)}" fill="none" stroke="{color}" '
            f'stroke-width="{sw}" stroke-linecap="{cap}"{op}/>')


def full_arc(sw=5, color="currentColor", opacity=1):
    op = "" if opacity == 1 else f' opacity="{opacity}"'
    return f'<path d="{ARC}" fill="none" stroke="{color}" stroke-width="{sw}"{op}/>'


def dome(fill=BLUE):
    return f'<path d="{DOME}" fill="{fill}"/>'


def sun(deg=LOGO_DEG, orbit=28.9, r=7.5, fill="currentColor"):
    x, y = at(deg, orbit)
    return f'<circle cx="{f(x)}" cy="{f(y)}" r="{r}" fill="{fill}"/>'


LEFT, RIGHT = 176.1, 3.9  # where the path meets the horizon
_clip = [0]


def v_current():
    return full_arc() + dome() + sun()


def v_progress():
    return full_arc(opacity=0.2) + arc(LEFT, LOGO_DEG) + dome() + sun(orbit=R)


def v_noon():
    return full_arc() + dome() + sun(deg=90)


def v_gap():
    half = math.degrees((7 + 3.2) / R)
    return arc(LEFT, LOGO_DEG + half) + arc(LOGO_DEG - half, RIGHT) + dome() + sun(orbit=R, r=7)


def v_ring():
    half = math.degrees((6 + 2 + 2.6) / R)
    x, y = at(LOGO_DEG)
    ring = f'<circle cx="{f(x)}" cy="{f(y)}" r="6" fill="none" stroke="currentColor" stroke-width="4"/>'
    return arc(LEFT, LOGO_DEG + half) + arc(LOGO_DEG - half, RIGHT) + dome() + ring


def v_ticks():
    out = []
    for deg in range(170, 0, -20):
        if abs(deg - 130) < 1:
            continue
        x0, y0 = at(deg, R - 3.2)
        x1, y1 = at(deg, R + 3.2)
        out.append(f'<path d="M{f(x0)} {f(y0)}L{f(x1)} {f(y1)}" stroke="currentColor" stroke-width="3.4" stroke-linecap="round"/>')
    return "".join(out) + dome() + sun(deg=130, orbit=R, r=6.5)


def v_hand():
    x, y = at(LOGO_DEG, 27)
    hand = f'<path d="M32 46L{f(x)} {f(y)}" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>'
    return full_arc(sw=2.5) + hand + dome() + sun(orbit=27, r=6.5)


def v_blue_sun():
    return full_arc() + dome(fill="currentColor") + sun(fill=BLUE)


def v_sky():
    sky = f'<path d="{ARC}Z" fill="{LIGHT}" opacity="0.55"/>'
    return sky + full_arc() + dome() + sun()


def v_thin():
    return full_arc(sw=3) + dome() + sun(orbit=27.5, r=6)


def v_rise():
    return full_arc() + sun(deg=165, orbit=R, r=6.5) + dome()


def v_box():
    _clip[0] += 1
    cid = f"box{_clip[0]}"
    cx, cy, r = 32, 42, 15.5
    a = math.radians(125)
    sx, sy = cx + (r + 1.2) * math.cos(a), cy - (r + 1.2) * math.sin(a)
    x0, y0 = cx + r * math.cos(math.radians(195)), cy - r * math.sin(math.radians(195))
    x1, y1 = cx + r * math.cos(math.radians(-15)), cy - r * math.sin(math.radians(-15))
    return (
        f'<clipPath id="{cid}"><rect x="7" y="7" width="50" height="50" rx="12.5"/></clipPath>'
        f'<path d="M{f(x0)} {f(y0)}A{r} {r} 0 1 1 {f(x1)} {f(y1)}" fill="none" stroke="currentColor" stroke-width="4"/>'
        f'<g clip-path="url(#{cid})"><circle cx="32" cy="86" r="44" fill="{BLUE}"/></g>'
        f'<circle cx="{f(sx)}" cy="{f(sy)}" r="5.2" fill="currentColor"/>'
        '<rect x="4.75" y="4.75" width="54.5" height="54.5" rx="14.75" fill="none" stroke="currentColor" stroke-width="4.5"/>'
    )


# ---------------------------------------------------------------------------
# Close to the Zodiac logo. The Zodiac icon is a tile with a planet at the bottom
# (its top edge is 55 % down) and a sky that glows at the horizon. The Zodiac
# wordmark is heavy, drawn with one line width, and a horizon cuts its middle letters.
# ---------------------------------------------------------------------------

_uid = [0]


def uid(prefix):
    _uid[0] += 1
    return f"{prefix}{_uid[0]}"


# The Zodiac tile is 356 wide: planet centre (177, 559), radius 362; sky ellipse 617.5 x 588.
def zodiac_geometry(x, y, size):
    k = size / 356
    return x + 177 * k, y + 559 * k, 362 * k, 617.5 * k, 588 * k


BOX_OUT = '<rect x="4.75" y="4.75" width="54.5" height="54.5" rx="14.75" fill="none" stroke="currentColor" stroke-width="4.5"/>'


def box_clip():
    cid = uid("clip")
    return cid, f'<clipPath id="{cid}"><rect x="7" y="7" width="50" height="50" rx="12.5"/></clipPath>'


def small_path(cx=32, cy=40, r=16, sw=4, color="currentColor"):
    x0, y0 = cx + r * math.cos(math.radians(195)), cy - r * math.sin(math.radians(195))
    x1, y1 = cx + r * math.cos(math.radians(-15)), cy - r * math.sin(math.radians(-15))
    return f'<path d="M{f(x0)} {f(y0)}A{r} {r} 0 1 1 {f(x1)} {f(y1)}" fill="none" stroke="{color}" stroke-width="{sw}"/>'


def small_sun(cx=32, cy=40, r=16, deg=125, size=5.2, color="currentColor"):
    a = math.radians(deg)
    return f'<circle cx="{f(cx + (r + 1.2) * math.cos(a))}" cy="{f(cy - (r + 1.2) * math.sin(a))}" r="{size}" fill="{color}"/>'


def z_horizon():
    cid, clip = box_clip()
    px, py, pr, _, _ = zodiac_geometry(7, 7, 50)
    return (clip + small_path() + f'<g clip-path="url(#{cid})"><circle cx="{f(px)}" cy="{f(py)}" r="{f(pr)}" fill="{BLUE}"/></g>'
            + small_sun() + BOX_OUT)


def z_glow():
    cid, clip = box_clip()
    gid = uid("glow")
    px, py, pr, _, _ = zodiac_geometry(7, 7, 50)
    reach = pr + 24
    grad = (f'<radialGradient id="{gid}" gradientUnits="userSpaceOnUse" cx="{f(px)}" cy="{f(py)}" r="{f(reach)}">'
            f'<stop offset="{f(pr / reach)}" stop-color="{BLUE}" stop-opacity="0.75"/>'
            f'<stop offset="{f((pr + 9) / reach)}" stop-color="{LIGHT}" stop-opacity="0.55"/>'
            f'<stop offset="1" stop-color="{LIGHT}" stop-opacity="0"/></radialGradient>')
    return (clip + grad + f'<g clip-path="url(#{cid})"><circle cx="{f(px)}" cy="{f(py)}" r="{f(reach)}" fill="url(#{gid})"/></g>'
            + small_path() + f'<g clip-path="url(#{cid})"><circle cx="{f(px)}" cy="{f(py)}" r="{f(pr)}" fill="{BLUE}"/></g>'
            + small_sun() + BOX_OUT)


def z_sky():
    cid, gid = uid("clip"), uid("sky")
    px, py, pr, rx, ry = zodiac_geometry(2, 2, 60)
    return (f'<clipPath id="{cid}"><rect x="2" y="2" width="60" height="60" rx="15.5"/></clipPath>'
            f'<radialGradient id="{gid}" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" '
            f'gradientTransform="translate({f(px)} {f(py)}) scale({f(rx)} {f(ry)})">'
            f'<stop offset="0.596" stop-color="#B1D3F2"/><stop offset="0.803" stop-color="#469CED"/><stop offset="1" stop-color="#286CB2"/></radialGradient>'
            f'<g clip-path="url(#{cid})"><rect x="2" y="2" width="60" height="60" fill="url(#{gid})"/>'
            + small_path(cy=41, r=17, sw=4.2, color="#fff")
            + f'<circle cx="{f(px)}" cy="{f(py)}" r="{f(pr)}" fill="{BLUE}"/>'
            + small_sun(cy=41, r=17, size=5.6, color="#fff") + '</g>')


def z_night():
    cid = uid("clip")
    px, py, pr, _, _ = zodiac_geometry(2, 2, 60)
    return (f'<clipPath id="{cid}"><rect x="2" y="2" width="60" height="60" rx="15.5"/></clipPath>'
            f'<g clip-path="url(#{cid})"><rect x="2" y="2" width="60" height="60" fill="#0b0b0c"/>'
            + small_path(cy=41, r=17, sw=4.2, color="#fff")
            + f'<circle cx="{f(px)}" cy="{f(py)}" r="{f(pr + 1.6)}" fill="{LIGHT}"/>'
            + f'<circle cx="{f(px)}" cy="{f(py)}" r="{f(pr)}" fill="{BLUE}"/>'
            + small_sun(cy=41, r=17, size=5.6, color="#fff") + '</g>')


def z_orbit():
    cid, clip = box_clip()
    px, py, pr, _, _ = zodiac_geometry(7, 7, 50)
    orbit = pr + 11.5
    a = math.radians(105)
    sx, sy = px + orbit * math.cos(a), py - orbit * math.sin(a)
    return (clip + f'<g clip-path="url(#{cid})"><circle cx="{f(px)}" cy="{f(py)}" r="{f(orbit)}" fill="none" stroke="currentColor" stroke-width="3"/>'
            f'<circle cx="{f(px)}" cy="{f(py)}" r="{f(pr)}" fill="{BLUE}"/></g>'
            f'<circle cx="{f(sx)}" cy="{f(sy)}" r="5.4" fill="currentColor"/>' + BOX_OUT)


def z_box_path():
    # The mark in use, but the path of the sun is a box that stands behind the horizon.
    sx, sy = 24 - 12 * math.cos(math.radians(45)), 24 - 12 * math.sin(math.radians(45))
    return ('<path d="M12 47V24A12 12 0 0 1 24 12H40A12 12 0 0 1 52 24V47" fill="none" stroke="currentColor" stroke-width="5"/>'
            + dome() + f'<circle cx="{f(sx)}" cy="{f(sy)}" r="7" fill="currentColor"/>')


ZODIAC_MARKS = [
    ("Z1", "Zodiac horizon", "The box from F, with the planet of the Zodiac icon: the same curve, at the same height.", z_horizon),
    ("Z2", "Glow", "Z1 with the glow of the Zodiac sky above the horizon.", z_glow),
    ("Z3", "Zodiac sky", "The Zodiac tile itself, with the path and the sun on it. The closest of the set.", z_sky),
    ("Z4", "Night", "A black tile, the Zodiac planet with a bright rim, a white path and sun.", z_night),
    ("Z5", "Orbit", "The path follows the planet, like an orbit. Every curve in the mark comes from the Zodiac icon.", z_orbit),
    ("Z6", "Box on the horizon", "The mark in use, but the path of the sun is a box that stands behind the horizon.", z_box_path),
]

# The wordmark in the letter style of ZODIAC: cap height 318, one line width of 54.
SW = 54.24
TOP, BOTTOM, MID = 5.65, 324.0, 164.8
YT, YB = TOP + SW / 2, BOTTOM - SW / 2


def g_c(x0):
    cx, r = x0 + 159.17, 132.05
    return f'<path d="M{f(cx + 128.5)} {f(YT)}H{f(cx)}A{r} {r} 0 0 0 {f(cx)} {f(YB)}H{f(cx + 128.5)}"/>', 287.7


def g_o(x0):
    return f'<circle cx="{f(x0 + 164.74)}" cy="{MID}" r="137.62"/>', 329.5


def g_h(x0, w=276):
    a, b = x0 + SW / 2, x0 + w - SW / 2
    return f'<path d="M{f(a)} {TOP}V{BOTTOM}M{f(b)} {TOP}V{BOTTOM}M{f(a)} {MID}H{f(b)}"/>', w


def g_r(x0, w=236):
    a, rb = x0 + SW / 2, 78.6
    bx = x0 + w - SW / 2 - rb
    cid = uid("g")
    return (f'<clipPath id="{cid}"><rect x="{f(x0)}" y="{TOP}" width="{w + 20}" height="{BOTTOM - TOP}"/></clipPath>'
            f'<g clip-path="url(#{cid})"><path d="M{f(a)} {TOP}V{BOTTOM}M{f(a)} {f(YT)}H{f(bx)}A{rb} {rb} 0 0 1 {f(bx)} {f(YT + 2 * rb)}H{f(a)}'
            f'M{f(x0 + 108)} 176L{f(x0 + 226)} 342"/></g>'), w + 10


def g_n(x0, w=290):
    a, b = x0 + SW / 2, x0 + w - SW / 2
    cid = uid("g")
    return (f'<clipPath id="{cid}"><rect x="{f(x0)}" y="{TOP}" width="{w}" height="{BOTTOM - TOP}"/></clipPath>'
            f'<g clip-path="url(#{cid})"><path d="M{f(a)} {TOP}V{BOTTOM}M{f(b)} {TOP}V{BOTTOM}M{f(x0 + 20)} -14L{f(x0 + w - 20)} 344"/></g>'), w


def g_b(x0):
    a = x0 + SW / 2
    r1 = (156.97 - YT) / 2
    r2 = (YB - 156.97) / 2
    ux, lx = x0 + 116, x0 + 132
    return (f'<path d="M{f(a)} {TOP}V{BOTTOM}M{f(a)} {f(YT)}H{f(ux)}A{f(r1)} {f(r1)} 0 0 1 {f(ux)} 156.97H{f(a)}'
            f'M{f(a)} 156.97H{f(lx)}A{f(r2)} {f(r2)} 0 0 1 {f(lx)} {f(YB)}H{f(a)}"/>'), 132 + r2 + SW / 2


def g_x(x0, w=292):
    cid = uid("g")
    return (f'<clipPath id="{cid}"><rect x="{f(x0)}" y="{TOP}" width="{w}" height="{BOTTOM - TOP}"/></clipPath>'
            f'<g clip-path="url(#{cid})"><path d="M{f(x0 + 36)} -14L{f(x0 + w - 36)} 344M{f(x0 + w - 36)} -14L{f(x0 + 36)} 344"/></g>'), w


# letter, and the gap after it
WORD = [(g_c, 55), (g_h, 55), (g_r, 14), (g_o, 40), (g_n, 40), (g_o, 40), (g_b, 30), (g_o, 8), (g_x, 0)]


def zodiac_word(cut=False, horizon=False, height=40):
    x, parts = 0.0, []
    for glyph, gap in WORD:
        markup, w = glyph(x)
        parts.append(markup)
        x += w + gap
    width = x
    letters = f'<g fill="none" stroke="currentColor" stroke-width="{SW}">{"".join(parts)}</g>'
    extra = ""
    if cut:
        # Like ZODIAC: a horizon cuts the letters in the middle. The first and the last letter stay whole.
        # ZODIAC is cut at 226 of 330. This name has an R and a B, which need more of their lower half to be read.
        top, reach = 256.0, width / 2 - 318
        radius = (reach ** 2 + (330 - top) ** 2) / (2 * (330 - top))
        mid = uid("m")
        extra = (f'<mask id="{mid}" maskUnits="userSpaceOnUse" x="0" y="-4" width="{f(width)}" height="340">'
                 f'<rect x="0" y="-4" width="{f(width)}" height="340" fill="#fff"/>'
                 f'<circle cx="{f(width / 2)}" cy="{f(top + radius)}" r="{f(radius)}" fill="#000"/></mask>')
        letters = f'<g mask="url(#{mid})">{letters}</g>'
        if horizon:
            letters += (f'<path d="M{f(width / 2 - reach)} 330A{f(radius)} {f(radius)} 0 0 1 {f(width / 2 + reach)} 330Z" fill="{BLUE}"/>')
    w_px = height * width / 334
    return (f'<svg class="zword" viewBox="0 -2 {f(width)} 334" width="{f(w_px)}" height="{height}" role="img" aria-label="Chronobox">'
            f'{extra}{letters}</svg>')


ZODIAC_WORDS = [
    ("ZW1", "Zodiac letters", "The name drawn like ZODIAC: heavy, one line width, round letters as full circles.", dict()),
    ("ZW2", "Horizon cut", "The same, with the horizon that cuts ZODIAC. The cut is lower than in ZODIAC, so that R and B can still be read.", dict(cut=True)),
    ("ZW3", "Blue horizon", "The cut, with the horizon shown in Zodiac blue.", dict(cut=True, horizon=True)),
]


def zword_card(key, name, note, opts):
    def lock(h):
        return f'<span class="lockup zl">{svg(z_horizon(), round(h * 1.7))}{zodiac_word(height=h, **opts)}</span>'
    return f"""<article class="card wide">
  <header><span class="key">{key}</span><h3>{name}</h3></header>
  <p class="note">{note}</p>
  <div class="stage one">
    <div class="pane light short">{lock(38)}</div>
    <div class="pane dark short">{lock(38)}</div>
  </div>
  <div class="row"><span class="lockup zl small">{svg(z_horizon(), 28)}{zodiac_word(height=13, **opts)}</span></div>
</article>"""


def reference_card():
    def inline(name, height):
        raw = open(os.path.join(HERE, "..", "zodiac", name)).read()
        raw = raw[raw.index("<svg"):]
        import re
        raw = re.sub(r'width="\d+" height="\d+"', f'height="{height}"', raw, count=1)
        return raw.replace('fill="black"', 'fill="currentColor"')
    return f"""<article class="card wide ref">
  <header><span class="key">Z</span><h3>The Zodiac logo</h3></header>
  <p class="note">For comparison: the icon and the wordmark.</p>
  <div class="stage one"><div class="pane light zref">{inline("zodiac-icon.svg", 84)}{inline("zodiac-logo-light.svg", 34)}</div></div>
</article>"""


# ---------------------------------------------------------------------------
# Z3 again, so that it reads as sun and moon, not as a ring with a stone.
# A ring is a thick band with a ball on it. So: the band gets thin or dotted,
# and the ball becomes a sun with rays, or a moon.
# ---------------------------------------------------------------------------

W = "#fff"
SKY_C = (32, 41, 17)  # the path on the tile: centre and radius


def sp(deg, rr=None):
    cx, cy, r = SKY_C
    rr = r if rr is None else rr
    a = math.radians(deg)
    return cx + rr * math.cos(a), cy - rr * math.sin(a)


def sky_tile(behind, front=""):
    """The Zodiac tile. `behind` is drawn behind the planet, `front` in front of it."""
    cid, gid = uid("clip"), uid("sky")
    px, py, pr, rx, ry = zodiac_geometry(2, 2, 60)
    return (f'<clipPath id="{cid}"><rect x="2" y="2" width="60" height="60" rx="15.5"/></clipPath>'
            f'<radialGradient id="{gid}" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" '
            f'gradientTransform="translate({f(px)} {f(py)}) scale({f(rx)} {f(ry)})">'
            f'<stop offset="0.596" stop-color="#B1D3F2"/><stop offset="0.803" stop-color="#469CED"/><stop offset="1" stop-color="#286CB2"/></radialGradient>'
            f'<g clip-path="url(#{cid})"><rect x="2" y="2" width="60" height="60" fill="url(#{gid})"/>{behind}'
            f'<circle cx="{f(px)}" cy="{f(py)}" r="{f(pr)}" fill="{BLUE}"/>{front}</g>')


def sky_arc(a0, a1, sw=2.6, dotted=False, dashed=False, opacity=1):
    x0, y0 = sp(a0)
    x1, y1 = sp(a1)
    large = 1 if a0 - a1 > 180 else 0
    dash = ' stroke-dasharray="0 5.4" stroke-linecap="round"' if dotted else ' stroke-dasharray="3.4 2.9"' if dashed else ""
    op = "" if opacity == 1 else f' opacity="{opacity}"'
    return (f'<path d="M{f(x0)} {f(y0)}A{SKY_C[2]} {SKY_C[2]} 0 {large} 1 {f(x1)} {f(y1)}" fill="none" stroke="{W}" '
            f'stroke-width="{sw}"{dash}{op}/>')


def disc(deg, r):
    x, y = sp(deg)
    return f'<circle cx="{f(x)}" cy="{f(y)}" r="{r}" fill="{W}"/>'


def rays(x, y, r, n=8, gap=1.7, length=2.5, sw=1.8, start=0.0, sweep=360.0):
    out = []
    for i in range(n):
        a = math.radians(start + sweep * i / (n if sweep == 360 else n - 1))
        x0, y0 = x + (r + gap) * math.cos(a), y - (r + gap) * math.sin(a)
        x1, y1 = x + (r + gap + length) * math.cos(a), y - (r + gap + length) * math.sin(a)
        out.append(f'M{f(x0)} {f(y0)}L{f(x1)} {f(y1)}')
    return f'<path d="{"".join(out)}" stroke="{W}" stroke-width="{sw}" stroke-linecap="round" fill="none"/>'


def crescent(x, y, r):
    mid = uid("moon")
    return (f'<mask id="{mid}" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">'
            f'<circle cx="{f(x)}" cy="{f(y)}" r="{r}" fill="#fff"/>'
            f'<circle cx="{f(x + r * 0.46)}" cy="{f(y - r * 0.3)}" r="{f(r * 0.86)}" fill="#000"/></mask>'
            f'<rect x="0" y="0" width="64" height="64" fill="{W}" mask="url(#{mid})"/>')


def phase(x, y, r, lit):
    """A moon with the part `lit` (0 to 1) of its face in light, from the right."""
    ring = f'<circle cx="{f(x)}" cy="{f(y)}" r="{f(r - 0.55)}" fill="none" stroke="{W}" stroke-width="1.1"/>'
    if lit <= 0:
        return ring
    if lit >= 1:
        return f'<circle cx="{f(x)}" cy="{f(y)}" r="{r}" fill="{W}"/>'
    top, bottom = f"{f(x)} {f(y - r)}", f"{f(x)} {f(y + r)}"
    if lit < 0.5:
        back = f"A{f(r * (1 - 2 * lit))} {r} 0 0 0 {top}"
    elif lit == 0.5:
        back = "Z"
    else:
        back = f"A{f(r * (2 * lit - 1))} {r} 0 0 1 {top}"
    return ring + f'<path d="M{top}A{r} {r} 0 0 1 {bottom}{back}" fill="{W}"/>'


def gap_for(r):
    return math.degrees((r + 1.6) / SKY_C[2])


def m_thin():
    return sky_tile(sky_arc(195, -15, sw=2.4), disc(118, 6))


def m_rays():
    deg, r = 110, 4.7
    reach = r + 1.5 + 2.2
    x, y = sp(deg)
    g = gap_for(reach)
    return sky_tile(sky_arc(195, deg + g, sw=2.4) + sky_arc(deg - g, -15, sw=2.4), disc(deg, r) + rays(x, y, r, gap=1.5, length=2.2, sw=1.7))


def m_dashed():
    return sky_tile(sky_arc(195, -15, sw=2.6, dashed=True), disc(118, 6))


def m_pale():
    return sky_tile(sky_arc(195, 118, sw=2.6) + sky_arc(118, -15, sw=2.6, opacity=0.45), disc(118, 6))


def s_rays():
    deg, r = 125, 4.6
    reach = r + 1.7 + 2.5
    x, y = sp(deg)
    g = gap_for(reach)
    return sky_tile(sky_arc(195, deg + g) + sky_arc(deg - g, -15), disc(deg, r) + rays(x, y, r))


def s_dotted():
    deg, r = 125, 6
    g = gap_for(r + 1)
    return sky_tile(sky_arc(190, deg + g, sw=2.8, dotted=True) + sky_arc(deg - g, -10, sw=2.8, dotted=True), disc(deg, r))


def s_sun_moon():
    sun_deg, moon_deg, r = 140, 40, 4.3
    sx, sy = sp(sun_deg)
    mx, my = sp(moon_deg)
    return sky_tile(sky_arc(112, 64, sw=2.8, dotted=True),
                    disc(sun_deg, r) + rays(sx, sy, r, gap=1.5, length=2.2, sw=1.7) + crescent(mx, my, 5.4))


def s_phases():
    moons = "".join(phase(*sp(deg), 4.1, lit) for deg, lit in [(157, 0), (123.5, 0.25), (90, 0.5), (56.5, 0.75), (23, 1)])
    return sky_tile(moons)


def s_sunrise():
    x, y, r = 32, 35.4, 9
    return sky_tile(f'<circle cx="{x}" cy="{y}" r="{r}" fill="{W}"/>' + rays(x, y, r, n=5, gap=3.2, length=4.4, sw=2.6, start=30, sweep=120))


def s_crescent():
    deg, r = 125, 6.2
    x, y = sp(deg)
    g = gap_for(r + 0.6)
    return sky_tile(sky_arc(195, deg + g) + sky_arc(deg - g, -15), crescent(x, y, r))


SUN_MOON = [
    ("Z3", "As it was", "For comparison. A thick band with a ball on it: that is how a ring is drawn.", z_sky),
    ("M1", "Thin path", "Only the band changes. It is a line now, so the sun is clearly larger than its path.", m_thin),
    ("M2", "Rays", "The thin path stops before the sun, and the sun has rays.", m_rays),
    ("M3", "Dashed path", "The path is a dashed line, like a route. The sun is as in M1.", m_dashed),
    ("M4", "Path ahead", "The path behind the sun is solid, the path ahead is pale. It shows a wait under way.", m_pale),
]

SUN_MOON_FAR = [
    ("S3", "Sun and moon", "The sun on one side, the moon on the other, and a dotted path between them: one day.", s_sun_moon),
    ("S4", "Moon phases", "The path is the moon itself, from new to full. The wait is a cycle that fills up.", s_phases),
    ("S5", "Sunrise", "The sun comes up behind the Zodiac horizon. No path, so nothing is left of the ring.", s_sunrise),
    ("S6", "Crescent", "The thin path with a moon on it. A crescent cannot be read as a stone.", s_crescent),
]


VARIANTS = [
    ("0", "In use", "The mark as it is now, for comparison.", v_current),
    ("A", "Progress", "The path behind the sun is dark, the path ahead is pale. It shows a wait that is under way.", v_progress),
    ("B", "Gap", "The path stops short of the sun on both sides. The sun reads as its own shape, also at 16 pixels.", v_gap),
    ("C", "Ring", "The sun is a ring. It echoes the three letters O in the name.", v_ring),
    ("D", "Ticks", "The path is a row of marks, like the edge of a watch. This is the most \"chrono\" of the set.", v_ticks),
    ("E", "Hand", "A hand points from the horizon to the sun. Half clock, half sundial.", v_hand),
    ("F", "Box", "The mark sits in a box. It makes the second half of the name visible.", v_box),
    ("G", "Sky", "The space under the path is filled. The mark gets more weight as an icon.", v_sky),
    ("H", "Blue sun", "The colours change places: time is blue, the horizon is dark.", v_blue_sun),
    ("I", "Noon", "The sun is at the top. Calm and even, but it no longer says \"a way to go\".", v_noon),
    ("J", "Sunrise", "The sun has just come up. The whole wait is still ahead.", v_rise),
    ("K", "Light", "Thinner path, smaller sun. Quieter next to a light wordmark.", v_thin),
]


def svg(body, size, cls=""):
    c = f' class="{cls}"' if cls else ""
    return f'<svg{c} viewBox="0 0 64 64" width="{size}" height="{size}" aria-hidden="true">{body}</svg>'


def icon(body, size):
    return (f'<span class="tile" style="width:{size}px;height:{size}px">'
            f'{svg(body, round(size * 0.74))}</span>')


def card(key, name, note, fn):
    return f'''<article class="card{" ref" if key in ("0", "Z3") and name in ("In use", "As it was") else ""}">
  <header><span class="key">{key}</span><h3>{name}</h3></header>
  <p class="note">{note}</p>
  <div class="stage">
    <div class="pane light">{svg(fn(), 132)}</div>
    <div class="pane dark">{svg(fn(), 132)}</div>
  </div>
  <div class="row">
    <span class="lockup">{svg(fn(), 28)}<span class="word">CHRONOBOX</span></span>
    <span class="sizes">{svg(fn(), 32)}{svg(fn(), 20)}{svg(fn(), 16)}{icon(fn(), 44)}</span>
  </div>
</article>'''


def letter_o(kind):
    """An O for the wordmark, 0.72em tall: empty, half or full."""
    ring = '<circle cx="50" cy="50" r="41" fill="none" stroke="currentColor" stroke-width="17"/>'
    if kind == "empty":
        body = ring
    elif kind == "half":
        body = ring + '<path d="M50 9A41 41 0 0 0 50 91Z" fill="currentColor"/>'
    else:
        body = '<circle cx="50" cy="50" r="49.5" fill="currentColor"/>'
    return f'<svg class="o" viewBox="0 0 100 100" aria-hidden="true">{body}</svg>'


WORDS = [
    ("W1", "In use", "Capitals, wide spacing.", '<span class="word big">CHRONOBOX</span>'),
    ("W2", "Lower case", "Softer, closer to an app name than to a label.", '<span class="word big lower">chronobox</span>'),
    ("W3", "Two weights", "\"Chrono\" light, \"box\" heavy. The eye finds the box.", '<span class="word big lower two"><i>chrono</i><b>box</b></span>'),
    ("W4", "Filling up", "The three letters O fill up from left to right, like a wait that passes.",
     f'<span class="word big phases">CHR{letter_o("empty")}N{letter_o("half")}B{letter_o("full")}X</span>'),
]


def word_card(key, name, note, word):
    return f'''<article class="card wide">
  <header><span class="key">{key}</span><h3>{name}</h3></header>
  <p class="note">{note}</p>
  <div class="stage">
    <div class="pane light"><span class="lockup">{svg(v_current(), 44)}{word}</span></div>
    <div class="pane dark"><span class="lockup">{svg(v_current(), 44)}{word}</span></div>
  </div>
</article>'''


PAGE = '''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chronobox logo variants</title>
<style>
:root{--bg:#fff;--fg:#0b0b0c;--muted:#6a6a70;--line:#e5e5e8;--panel:#f5f5f7;--blue:#469ced}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1240px;margin:0 auto;padding:40px 16px 80px}
h1{font-size:2rem;letter-spacing:-.02em;margin:0 0 8px}
h2{font-size:1.25rem;letter-spacing:-.01em;margin:48px 0 16px}
.lead{color:var(--muted);max-width:66ch;margin:0}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:20px}
.grid.words{grid-template-columns:repeat(auto-fill,minmax(480px,1fr))}
.card{border:1px solid var(--line);border-radius:18px;padding:18px;display:grid;gap:12px;align-content:start}
.card.ref{background:var(--panel)}
.card header{display:flex;align-items:center;gap:10px}
.key{display:inline-grid;place-items:center;min-width:30px;height:30px;padding:0 8px;border-radius:999px;background:var(--fg);color:var(--bg);font-weight:600;font-size:.9rem}
.card h3{margin:0;font-size:1.1rem}
.note{margin:0;color:var(--muted);font-size:.925rem;min-height:4.2em;text-wrap:pretty}
.wide .note{min-height:0}
.stage{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.pane{display:grid;place-items:center;min-height:176px;border-radius:12px;border:1px solid var(--line);padding:12px;overflow:hidden}
.pane.light{background:#fff;color:#0b0b0c}
.pane.dark{background:#0b0b0c;color:#fff;border-color:#0b0b0c}
.row{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.lockup{display:inline-flex;align-items:center;gap:9px}
.word{font-size:.95rem;font-weight:600;letter-spacing:.08em}
.word.big{font-size:1.55rem}
.word.lower{letter-spacing:-.01em;font-size:1.8rem}
.word.two i{font-style:normal;font-weight:400}
.word.two b{font-weight:700}
.word.phases{display:inline-flex;align-items:center}
.o{width:.8em;height:.8em;margin:0 .08em 0 .03em;flex:none}
.sizes{display:inline-flex;align-items:center;gap:12px}
.grid.gap{margin-top:20px}
.stage.one{grid-template-columns:1fr}
.pane.short{min-height:124px}
.zword{max-width:100%;height:auto}
.pane.light{--pane:#fff}.pane.dark{--pane:#0b0b0c}
.zref{display:flex;gap:28px;align-items:center;justify-content:center;flex-wrap:wrap}
.lockup.zl{gap:14px}.lockup.zl.small{gap:9px}
.tile{--pane:#0b0b0c}
.tile{display:inline-grid;place-items:center;border-radius:26%;background:#0b0b0c;color:#fff}
svg{display:block;flex:none}
@media (max-width:540px){.grid.words{grid-template-columns:1fr}.word.big{font-size:1.2rem}.word.lower{font-size:1.4rem}}
</style></head><body><main>
<h1>Chronobox logo variants</h1>
<p class="lead">New at the top: four small changes to Z3, so that it reads as a sun on its path and not as a ring. Below them are four versions that go further. Then the marks and wordmarks close to the Zodiac logo. Below them are the eleven earlier variations of the mark and three of the wordmark. Each card shows the mark on white and on black, in the header lockup, at 32, 20 and 16 pixels, and as an app icon.</p>
<h2>Z3, a bit clearer</h2>
<div class="grid">@@SUNMOON@@</div>
<h2>Z3, further away</h2>
<div class="grid">@@SUNFAR@@</div>
<h2>Close to the Zodiac logo</h2>
<div class="grid words">@@ZREF@@</div>
<div class="grid gap">@@ZMARKS@@</div>
<div class="grid words gap">@@ZWORDS@@</div>
<h2>Earlier variants of the mark</h2>
<div class="grid">@@MARKS@@</div>
<h2>Earlier variants of the wordmark</h2>
<div class="grid words">@@WORDS@@</div>
</main></body></html>
'''

if __name__ == "__main__":
    page = PAGE.replace("@@SUNMOON@@", "\n".join(card(*v) for v in SUN_MOON)).replace("@@SUNFAR@@", "\n".join(card(*v) for v in SUN_MOON_FAR)).replace("@@ZREF@@", reference_card()).replace("@@ZMARKS@@", "\n".join(card(*v) for v in ZODIAC_MARKS)).replace("@@ZWORDS@@", "\n".join(zword_card(*w) for w in ZODIAC_WORDS)).replace("@@MARKS@@", "\n".join(card(*v) for v in VARIANTS)).replace("@@WORDS@@", "\n".join(word_card(*w) for w in WORDS))
    out = os.path.join(HERE, "index.html")
    with open(out, "w") as fh:
        fh.write(page)
    print("wrote", out, len(page))
