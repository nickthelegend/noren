"""
Builds the Noren film from edl.py:
  1. cuts each segment out of its live take (record/takes/<take>.mp4) at its speed -> assets/footage/<scene>-<n>.mp4
  2. writes one scene composition per chapter (compositions/<scene>.html) and the root index.html
  3. places sound: voice-over, the music bed, a click on every real click in the takes, a whoosh on each chapter cut

  python3 edit/build.py            (from film/; add --no-cut to keep existing footage cuts)
"""
import json, os, subprocess, sys, html
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
import edl

FILM = Path(__file__).resolve().parent.parent
TAKES = FILM / "record" / "takes"
FOOT = FILM / "assets" / "footage"
COMP = FILM / "compositions"
FOOT.mkdir(parents=True, exist_ok=True); COMP.mkdir(exist_ok=True)
CUT = "--no-cut" not in sys.argv

NAVY, LINEN, PERSIMMON, INK, MUTED = "#101a3c", "#efe8db", "#e8643c", "#101a3c", "#5d6480"
WIN = dict(x=160, y=24, w=1600, h=900)       # the product window on the linen ground
K = WIN["w"] / 1920                           # take pixels -> window pixels

scenes = {s[0]: dict(id=s[0], start=s[1], dur=s[2], tag=s[3], net=s[4], segs=[]) for s in edl.SCENES}
order = [s[0] for s in edl.SCENES]

def dur_of(seg):
    return round((seg[3] - seg[2]) / seg[4], 3)

# ---- lay segments end to end inside their scenes
cursor = {k: edl.OFFSET.get(k, 0.0) for k in scenes}
for i, seg in enumerate(edl.SEGMENTS):
    sc, take, tin, tout, rate, zoom = seg
    d = dur_of(seg)
    n = len(scenes[sc]["segs"])
    scenes[sc]["segs"].append(dict(take=take, tin=tin, tout=tout, rate=rate, zoom=zoom, at=round(cursor[sc], 3), dur=d, file=f"{sc}-{n}.mp4", n=n))
    cursor[sc] += d
for k, s in scenes.items():
    if s["segs"]:
        end = s["segs"][-1]["at"] + s["segs"][-1]["dur"]
        if end > s["dur"] + 0.05:
            sys.exit(f"scene {k}: footage runs {end:.2f}s, slot is {s['dur']}s")

# ---- 1. cut footage (exact frame count, constant 30 fps, no audio)
def cut(seg):
    out = FOOT / seg["file"]
    frames = max(1, round(seg["dur"] * edl.FPS))
    vf = f"setpts=(PTS-STARTPTS)/{seg['rate']},fps={edl.FPS},format=yuv420p"
    cmd = ["ffmpeg", "-v", "error", "-y", "-ss", f"{seg['tin']}", "-t", f"{seg['tout'] - seg['tin'] + 0.5}", "-i", str(TAKES / f"{seg['take']}.mp4"),
           "-vf", vf, "-frames:v", str(frames), "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-movflags", "+faststart", str(out)]
    subprocess.run(cmd, check=True)
if CUT:
    for s in scenes.values():
        for seg in s["segs"]:
            if seg["take"].startswith("@"): continue
            cut(seg); print("cut", seg["file"], seg["dur"], "s")

# ---- 2. scene compositions
FONTS = """
    @font-face { font-family: "Geist"; src: url("assets/fonts/Geist.woff2") format("woff2"); font-weight: 100 900; }
    @font-face { font-family: "Geist Mono"; src: url("assets/fonts/GeistMono.woff2") format("woff2"); font-weight: 100 900; }
    @font-face { font-family: "Instrument Serif"; src: url("assets/fonts/InstrumentSerif.woff2") format("woff2"); }
    @font-face { font-family: "Instrument Serif"; src: url("assets/fonts/InstrumentSerif-Italic.woff2") format("woff2"); font-style: italic; }"""

def base_css(dark=False):
    ground, ink, sub = (NAVY, LINEN, "#aab0c8") if dark else (LINEN, INK, MUTED)
    return FONTS + f"""
    #root {{ position: absolute; inset: 0; background: {ground}; overflow: hidden; font-family: "Geist", sans-serif; color: {ink}; }}
    .win {{ position: absolute; left: {WIN['x']}px; top: {WIN['y']}px; width: {WIN['w']}px; height: {WIN['h']}px; border-radius: 22px; overflow: hidden;
            background: #fff; box-shadow: 0 34px 90px rgba(16,26,60,.28), 0 0 0 1px rgba(16,26,60,.14); }}
    .cam {{ position: absolute; left: 0; top: 0; width: {WIN['w']}px; height: {WIN['h']}px; }}
    .cam video {{ position: absolute; left: 0; top: 0; width: {WIN['w']}px; height: {WIN['h']}px; object-fit: cover; }}
    .bar {{ position: absolute; left: {WIN['x']}px; width: {WIN['w']}px; top: 938px; height: 130px; }}
    .tag {{ position: absolute; left: 0; top: 6px; font: 600 28px/1 "Geist Mono", monospace; letter-spacing: .03em; color: {ink}; white-space: nowrap; }}
    .tag i {{ display: inline-block; width: 12px; height: 12px; border-radius: 50%; background: {PERSIMMON}; margin-right: 12px; vertical-align: 3px; font-style: normal; }}
    .cap {{ position: absolute; left: 0; right: 0; top: 54px; height: 62px; display: flex; align-items: center; justify-content: center; text-align: center; }}
    .cap .in {{ display: block; font: 500 38px/1.1 "Geist", sans-serif; color: {ink}; letter-spacing: -.01em; white-space: nowrap; }}
    .cap em {{ font: italic 400 44px/1 "Instrument Serif", serif; color: {PERSIMMON if dark else "#b8411b"}; letter-spacing: 0; }}
    .net {{ position: absolute; right: 0; top: 0; font: 500 28px/1 "Geist Mono", monospace; color: {sub}; padding: 6px 14px; border-radius: 999px; border: 1.5px solid {"rgba(239,232,219,.3)" if dark else "rgba(16,26,60,.22)"}; white-space: nowrap; }}
    .net.live {{ color: #0f6b40; border-color: rgba(18,122,74,.55); background: rgba(31,164,99,.08); }}
    .net.live b {{ display: inline-block; width: 12px; height: 12px; border-radius: 50%; background: #1fa463; margin-right: 10px; vertical-align: 2px; }}
    .spd {{ position: absolute; right: 18px; bottom: 18px; font: 700 28px/1 "Geist Mono", monospace; color: {LINEN}; background: #101a3c; padding: 10px 14px; border-radius: 10px; }}
    .spd .in {{ display: inline-block; }}
    .wid {{ font: 600 28px/1 "Geist Mono", monospace; color: {LINEN}; background: {NAVY}; padding: 10px 14px; border-radius: 10px; }}
    .card {{ position: absolute; inset: 0; background: {NAVY}; padding: 70px 110px; color: {LINEN}; }}
    .card h3 {{ font: italic 400 64px/1 "Instrument Serif", serif; color: {LINEN}; margin-bottom: 40px; }}
    .crow {{ display: grid; grid-template-columns: 520px 120px 230px 1fr; align-items: baseline; padding: 22px 0; border-bottom: 1px solid rgba(239,232,219,.16); }}
    .crow b {{ font: 600 38px/1 "Geist", sans-serif; }}
    .crow span {{ font: 500 32px/1 "Geist Mono", monospace; color: #aab0c8; }}
    .crow strong {{ font: 600 40px/1 "Geist", sans-serif; color: {PERSIMMON}; }}
    .crow code {{ font: 500 28px/1 "Geist Mono", monospace; color: #aab0c8; text-align: right; }}
    .card p {{ position: absolute; left: 110px; bottom: 56px; font: 500 28px/1 "Geist Mono", monospace; color: #8f96b2; }}
    .redact {{ position: absolute; background: {NAVY}; border: 3px solid {PERSIMMON}; border-radius: 6px; display: flex; align-items: center; justify-content: center; }}
    .redact span {{ font: 600 28px/1 "Geist Mono", monospace; color: {LINEN}; letter-spacing: .02em; }}
"""

def cap_div(sid, i, local, d, text):
    return f'<div id="{sid}-c{i}" class="cap clip" data-start="{local:.3f}" data-duration="{d:.3f}" data-track-index="3"><span class="in">{text}</span></div>'

def zoom_of(z):
    if z is None: return None
    if isinstance(z[0], tuple): return z
    return (z, z)

def scene_html(s):
    sid, segs = s["id"], s["segs"]
    vids, tl, extra = [], [], []
    for seg in segs:
        cid, vid = f"{sid}-cam{seg['n']}", f"{sid}-v{seg['n']}"
        if seg["take"].startswith("@"):
            c = edl.CARDS[seg["take"][1:]]
            rows = "".join(f'<div class="crow" id="{sid}-k{seg["n"]}r{j}"><b>{html.escape(a)}</b><span>{html.escape(b)}</span><strong>{html.escape(cc)}</strong><code>{html.escape(d)}</code></div>' for j, (a, b, cc, d) in enumerate(c["rows"]))
            vids.append(f'<div id="{sid}-k{seg["n"]}" class="clip" data-start="{seg["at"]:.3f}" data-duration="{seg["dur"]:.3f}" data-track-index="1" style="position:absolute;inset:0"><div class="card"><h3>{html.escape(c["title"])}</h3>{rows}<p>{html.escape(c["source"])}</p></div></div>')
            for j in range(len(c["rows"])):
                tl.append(f'tl.fromTo("#{sid}-k{seg["n"]}r{j}", {{ x: -24, opacity: 0 }}, {{ x: 0, opacity: 1, duration: 0.3, ease: "power3.out" }}, {seg["at"] + 0.15 + j * 0.22:.3f});')
            continue
        vids.append(f'<div class="cam" id="{cid}"><video id="{vid}" class="clip" data-start="{seg["at"]:.3f}" data-duration="{seg["dur"]:.3f}" data-track-index="1" src="assets/footage/{seg["file"]}" muted playsinline></video></div>')
        z = zoom_of(seg["zoom"])
        if z:
            (s0, x0, y0), (s1, x1, y1) = z
            tl.append(f'tl.set("#{cid}", {{ transformOrigin: "{x0}% {y0}%", scale: {s0} }}, 0);')
            if (s0, x0, y0) != (s1, x1, y1):
                tl.append(f'tl.fromTo("#{cid}", {{ scale: {s0}, transformOrigin: "{x0}% {y0}%" }}, {{ scale: {s1}, transformOrigin: "{x1}% {y1}%", duration: {max(0.6, seg["dur"] - 0.4):.2f}, ease: "power1.inOut" }}, {seg["at"] + 0.2:.3f});')
        if seg["take"] == "world":
            extra.append(f'<div id="{sid}-wl{seg["n"]}" class="clip" data-start="{seg["at"]:.3f}" data-duration="{seg["dur"]:.3f}" data-track-index="4" style="position:absolute;left:18px;top:18px"><div class="wid">World ID · production · World App</div></div>')
        if seg["rate"] > 1.25:
            extra.append(f'<div id="{sid}-s{seg["n"]}" class="spd clip" data-start="{seg["at"]:.3f}" data-duration="{seg["dur"]:.3f}" data-track-index="4"><span class="in">▸▸ {seg["rate"]:.1f}×</span></div>')
    # redaction over the secret key (only where the onboard take is shown)
    red = []
    for seg in segs:
        if seg["take"] != edl.REDACT_TAKE: continue
        R = edl.REDACT
        t_from = max(0.0, (R["from"] - seg["tin"]) / seg["rate"]) + seg["at"]
        if t_from >= seg["at"] + seg["dur"]: continue
        for j, (x, y, w, h) in enumerate(R["boxes"]):
            rid = f"{sid}-r{seg['n']}{j}"
            label = '<span>secret key · redacted</span>' if j == 0 else ""
            red.append(f'<div id="{rid}" class="clip" data-start="{t_from:.3f}" data-duration="{seg["at"] + seg["dur"] - t_from:.3f}" data-track-index="5" style="position:absolute;left:0;top:0;width:{WIN["w"]}px;height:{WIN["h"]}px" data-layout-allow-overlap data-layout-allow-occlusion><div class="redact" id="{rid}b" style="left:{x*K:.1f}px;top:{y*K:.1f}px;width:{w*K:.1f}px;height:{h*K:.1f}px">{label}</div></div>')
            prev = None
            for (tt, dy) in R["shift"]:
                lt = (tt - seg["tin"]) / seg["rate"] + seg["at"]
                if prev is None:
                    tl.append(f'tl.set("#{rid}b", {{ y: {dy*K:.1f} }}, {max(t_from, lt):.3f});')
                else:
                    pt, pdy = prev
                    tl.append(f'tl.fromTo("#{rid}b", {{ y: {pdy*K:.1f} }}, {{ y: {dy*K:.1f}, duration: {lt - pt:.3f}, ease: "none" }}, {pt:.3f});')
                prev = (lt, dy)
    caps = []
    for i, (a, d, text) in enumerate(c for c in edl.CAPTIONS if s["start"] <= c[0] < s["start"] + s["dur"]):
        local = a - s["start"]
        d = min(d, s["dur"] - local)
        caps.append(cap_div(sid, i, local, d, text))
        tl.append(f'tl.fromTo("#{sid}-c{i} .in", {{ y: 18, opacity: 0 }}, {{ y: 0, opacity: 1, duration: 0.35, ease: "power3.out" }}, {local + 0.02:.3f});')
        tl.append(f'tl.to("#{sid}-c{i} .in", {{ opacity: 0, duration: 0.25, ease: "power2.in" }}, {local + d - 0.3:.3f});')
    net = ""
    if s["net"]:
        live = s["net"].startswith("Arc testnet · live")
        net = f'<div class="net{" live" if live else ""}" id="{sid}-net">{"<b></b>" if live else ""}{html.escape(s["net"])}</div>'
    # the 05a live explorer shots switch the network label while they play
    if sid == "private":
        ex = [sg for sg in segs if sg["take"] == "explorer"]
        a, b = ex[0]["at"], ex[-1]["at"] + ex[-1]["dur"]
        net = (f'<div id="{sid}-netf" class="clip" data-start="0" data-duration="{a:.3f}" data-track-index="6"><div class="net">{html.escape(edl.ARC_FORK)}</div></div>'
               f'<div id="{sid}-netl" class="clip" data-start="{a:.3f}" data-duration="{b - a:.3f}" data-track-index="6"><div class="net live"><b></b>{html.escape(edl.LIVE)}</div></div>')
    tl.insert(0, f'tl.fromTo("#{sid}-win", {{ y: 24, opacity: 0.0 }}, {{ y: 0, opacity: 1, duration: 0.45, ease: "power3.out" }}, {segs[0]["at"] if segs else 0:.3f});')
    tl.insert(0, f'tl.fromTo("#{sid}-tag", {{ x: -16, opacity: 0 }}, {{ x: 0, opacity: 1, duration: 0.4, ease: "power3.out" }}, 0.05);')
    body = f"""<template>
  <style>{base_css()}
  </style>
  <div id="root" data-composition-id="{sid}" data-width="1920" data-height="1080">
    <div class="win" id="{sid}-win">
      {chr(10).join("      " + v for v in vids).strip()}
      {chr(10).join("      " + r for r in red).strip()}
      {chr(10).join("      " + e for e in extra).strip()}
    </div>
    <div class="bar">
      <div class="tag" id="{sid}-tag"><i></i>{html.escape(s["tag"])}</div>
      {chr(10).join("      " + c for c in caps).strip()}
      {net}
    </div>
  </div>
  <script>
    const tl = gsap.timeline({{ paused: true }});
    {chr(10).join("    " + t for t in tl).strip()}
    window.__timelines["{sid}"] = tl;
  </script>
</template>
"""
    return body

for k in order:
    if k in ("intro", "tech"): continue
    (COMP / f"{k}.html").write_text(scene_html(scenes[k]))
    print("wrote", f"compositions/{k}.html")

# intro and tech are hand-written (compositions/intro.html, compositions/tech.html); the intro's landing cut is listed here
intro = scenes["intro"]["segs"][0]
json.dump({"intro_landing": intro}, open(FILM / "edit" / "intro-cut.json", "w"), indent=1)

# ---- 3. sound + root
def dur_wav(p):
    return float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(p)], capture_output=True, text=True).stdout)

audio = []
for v, at in edl.VO:
    p = FILM / "assets" / "vo" / f"{v}.wav"
    if not p.exists(): print("missing VO", v); continue
    audio.append(f'<audio id="vo-{v}" class="clip" data-start="{at:.2f}" data-duration="{dur_wav(p):.2f}" data-track-index="10" data-volume="1" src="assets/vo/{v}.wav"></audio>')

# clicks: every real click in the takes that survives the cut, at its place in the film
clicks, last = [], -9
for k in order:
    s = scenes[k]
    for seg in s["segs"]:
        if seg["take"].startswith("@"): continue
        ev = json.load(open(TAKES / f"{seg['take']}.events.json"))
        for e in ev["events"]:
            if e["type"] != "click" or not (seg["tin"] <= e["t"] < seg["tout"]): continue
            t = s["start"] + seg["at"] + (e["t"] + 0.07 - seg["tin"]) / seg["rate"]   # mouse-up lands 70 ms after the logged press
            if t - last < 0.32: continue
            clicks.append(t); last = t
for i, t in enumerate(clicks):
    src = "click-soft" if i % 2 else "click"
    audio.append(f'<audio id="sx-k{i}" class="clip" data-start="{t:.2f}" data-duration="0.36" data-track-index="11" data-volume="0.55" src="assets/sfx/{src}.mp3"></audio>')
for i, k in enumerate(order[1:]):
    t = scenes[k]["start"] - 0.12
    audio.append(f'<audio id="sx-w{i}" class="clip" data-start="{t:.2f}" data-duration="0.57" data-track-index="12" data-volume="0.35" src="assets/sfx/{"whoosh-short" if i % 2 else "whoosh"}.mp3"></audio>')
# a soft pop where a real result lands on screen (the take logged it the moment it appeared)
POP_LABELS = {"store", "swap", "bridge", "credit open", "stock paid", "private paid", "credit paid", "repaid", "deposit", "borrow", "lock"}
pops = list(edl.POPS)
for k in order:
    s = scenes[k]
    for seg in s["segs"]:
        if seg["take"].startswith("@"): continue
        ev = json.load(open(TAKES / f"{seg['take']}.events.json"))
        for e in ev["events"]:
            if e["type"] == "result" and e["label"] in POP_LABELS and seg["tin"] <= e["t"] < seg["tout"]:
                pops.append(s["start"] + seg["at"] + (e["t"] - seg["tin"]) / seg["rate"] + 0.05)
for i, t in enumerate(sorted(pops)):
    audio.append(f'<audio id="sx-p{i}" class="clip" data-start="{t:.2f}" data-duration="0.72" data-track-index="13" data-volume="0.4" src="assets/sfx/pop.mp3"></audio>')
music = FILM / "assets" / "music" / "bed.wav"
if music.exists():
    audio.append(f'<audio id="music" class="clip" data-start="0" data-duration="{edl.TOTAL:.2f}" data-track-index="14" data-volume="0.14" data-fade-in="0.8" data-fade-out="2.5" src="assets/music/bed.wav"></audio>')
else:
    print("no music bed yet (assets/music/bed.wav)")

hosts = "\n".join(f'      <div id="{k}" data-composition-id="{k}" data-composition-src="compositions/{k}.html" data-start="{scenes[k]["start"]:.2f}" data-duration="{scenes[k]["dur"]:.2f}" data-track-index="1" data-track-kind="graphics" data-width="1920" data-height="1080"></div>' for k in order)
index = f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1920, height=1080" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/gsap.min.js"></script>
    <style>
      * {{ margin: 0; padding: 0; box-sizing: border-box; }}
      html, body {{ margin: 0; width: 1920px; height: 1080px; overflow: hidden; background: {NAVY}; }}
      #root {{ width: 100%; height: 100%; background: {NAVY}; }}
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="{edl.TOTAL:.2f}" data-width="1920" data-height="1080">
{hosts}
      {chr(10).join("      " + a for a in audio).strip()}
    </div>
    <script>
      const tl = gsap.timeline({{ paused: true }});
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
"""
(FILM / "index.html").write_text(index)
print("wrote index.html:", len(clicks), "clicks,", len(audio), "audio clips")
