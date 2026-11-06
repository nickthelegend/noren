# Noren film: spec

**Length** 180.0 s, 1920×1080, 30 fps. **Order** (Nick's, v2): website 0–15 · Noren Merchant 15–35 · Aubelle 35–63 ·
Noren app 63–98 · three ways to pay 98–167 (USDC on Arc, private by default, then the live cross-chain runs 98–129;
stocks 129–144; pay in 3 + repay + live CCIP 144–167) · live-on-public-testnets card + end card 167–180.

**Look (Noren, not Kabuto).** Linen ground `#efe8db`, navy `#101a3c`, persimmon `#e8643c` for the one accent per line.
Geist for captions (38 px), Geist Mono for chapter tags and network badges (28 px), Instrument Serif italic for the
emphasis word and the titles. The product sits in one 1600×900 window with 22 px corners; under it, a chapter tag
(left), a network badge (right) and one caption line. Navy grounds only for the opening problem card and the tech/end card.

**Voice.** Kokoro `af_heart` (Kabuto used `bm_george`), plain words, problem first. Brand words are spelled for the
model in `vo/*.say.txt` ("Noh-ren", "Oh-bell", "U S D C", "C R E"); `vo/*.txt` is the script as written.

**Sound.** A local MusicGen bed (warm downtempo, koto and felt piano, 96 bpm) at 0.14 under the voice; a click on every
real click the recorder logged, a soft pop when a logged result lands (store created, swap received, CRE approval,
line opened, paid), a whoosh on each chapter cut. Pixabay SFX (`assets/sfx/CREDITS.md`).

**Honesty rules on screen.**
- Every product shot is a live take; speed-ups carry a `▸▸ n×` chip.
- Network badge on every chain shot: "Local fork · …" or "Arc testnet · live · public explorer" (05a explorer cut).
- The Noren Merchant secret key is covered by a visible box labelled "secret key · redacted".
- 05c: World ID is shown as the real IDKit request with "verification pending" unless `record/takes/world.events.json`
  holds a real `world-verified` event; the full ladder comes from the recorded earn demo's fork transactions, labelled.
- The Settle-to-Arc fill, the Robinhood side and CRE are fork/simulator runs and say so. Shown as live (public
  testnets, real explorer pages): the CCTP Arbitrum Sepolia → Arc SHIELD → private invoice payment (docs/PRIVACY.md),
  the Aqua fill of a CCTP order (docs/AQUA-LIVE.md), the CCIP Robinhood testnet → Base hub → Arc pay-on-credit
  (docs/CCIP.md) and Noren Merchant's live view of them. The badge switches per shot (`edl.py`, 7th field).

**Banned:** invented UI, a replayed or re-staged payment, text edited inside a recording, a headline APY, logos redrawn
from memory (the tech card lists names, not logos).
