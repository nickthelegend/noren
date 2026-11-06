# Noren demo film (3:00)

A [HyperFrames](https://hyperframes.heygen.com) project. Every product shot is a cut of a live recording of the real
Noren UI (`record/record.mjs`, Playwright + the Chrome DevTools screencast at 1920×1080) against `pnpm dev:all`, plus the
public Arc testnet explorer for the live payment and refund. Nothing is replayed, re-staged or text-edited: speed-ups are
labelled on screen (`▸▸ 2.2×`), the Noren Merchant secret key is covered by a visible "redacted" box, and every chain
shot says whether it is a local fork or Arc testnet (live).

| Path | What |
| --- | --- |
| `record/record.mjs` | the recorder: one take per flow (`landing`, `onboard`, `app`, `credit`, `shop`, `order`, `private`, `explorer`, `later`, `world`) |
| `record/retake-world.sh` | re-takes the World ID shot and re-renders (below) |
| `edit/edl.py` | the edit: which take, which seconds, how fast, captions, voice-over placement |
| `edit/build.py` | cuts the footage, writes `compositions/*.html` and `index.html`, places clicks/pops from the takes' own event logs |
| `edit/render.sh` | check + render `renders/noren-demo.mp4` and the ≤20 MB `renders/noren-demo-web.mp4` |
| `compositions/intro.html`, `compositions/tech.html` | the hand-made title, tech list and end card |
| `vo/*.txt` | the narration (Kokoro `af_heart`, `npx hyperframes tts`); `assets/vo/*.wav` |
| `assets/music/bed.wav` | the music bed (generated locally with MusicGen, see `SPEC.md`) |

Takes, browser state and renders are gitignored (`record/takes/`, `record/state/`, `renders/`).

## Re-take the World ID shot

World ID is production: a real verification needs a person to scan the IDKit request with World App. With
`pnpm dev:all` and `pnpm --filter @noren/web dev` running, one command opens the request, waits for the scan, records the
shot and, once verified, re-renders the film with it:

```sh
sh film/record/retake-world.sh        # WORLD_WAIT_MIN=30 by default
```

It writes the current World App link (decoded from the QR) to `film/record/state/world-link.txt` on every refresh, for a
phone that can't scan its own screen. Until a verification lands, section 05c shows the real request with
"verification pending" and the ladder from the recorded earn demo's fork transactions; a verified state is never drawn.

## Render

```sh
cd film && sh edit/render.sh          # NO_CUT=1 reuses the existing footage cuts
```
