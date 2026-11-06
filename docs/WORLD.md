# World ID in Noren: credit for a real human

In the Noren app, a customer proves with World ID that they are a unique human, without saying who they are. That proof opens a small **starter credit line** on Arc with no collateral (25 USDC for 30 days), on top of the stock-backed credit line. Each human gets one, whatever wallet they use. Noren never learns their identity.

Code: [`packages/world-id`](../packages/world-id). Status: built and tested offline (43 tests). The live run is **BLOCKED** until a World Developer Portal app exists (see [Setup](#setup-blocked-until-nick-creates-the-app)).

## The event that needs trust

Noren's other credit line is backed by Stock Tokens locked on Robinhood Chain: if the customer doesn't repay, the collateral covers the debt. The starter line has **no collateral**. Noren's Arc pool pays the merchant upfront and the customer repays later.

Without collateral, the risk is that one person opens a line from each of a thousand wallets, spends them all and walks away. That is a sybil attack. A credit score doesn't stop it, because each fresh wallet looks like a new customer. What Noren needs to know is narrow: **is this a person who hasn't already taken a starter line?** It doesn't need their name, age, country or document.

## Why Selfie Check is the minimum that works

| Credential | What it proves | Fit for a 25 USDC starter line |
|---|---|---|
| **Selfie Check** (default) | A live person whose face matches their World ID enrollment. Medium assurance, works on a phone camera, and needs no Orb or passport. | **Enough.** It gives us uniqueness, which is the one thing we need. Anyone with the World ID app can complete it, including users in India, where the Orb is paused. |
| Proof of Human (Orb) | A unique human, checked by the Orb's biometrics. The highest assurance. | Stronger than this risk needs, and out of reach for users who can't get to an Orb. |
| Passport (NFC) | The person holds a valid passport. | Proves a document we don't need, and adds friction (an NFC scan) for no gain in uniqueness. |

The loss limit is what makes medium assurance enough. If someone beats Selfie Check once, Noren loses at most 25 USDC. A larger unsecured limit would justify Proof of Human, and the server would then use `WORLD_CREDENTIAL=proof_of_human`. The server accepts **exactly one** credential type per deployment, never `any()` of several. The docs don't say whether nullifiers are per account or per credential, and if they are per credential, accepting two types could give one person two lines.

We don't use `sybil_score` in the decision. Selfie Check returns it, but the docs don't define its scale, so we can't base a credit policy on it. Noren doesn't store it either.

## Starter limit: 25 USDC for 30 days

- **Small enough to survive abuse.** 25 USDC is the most a fake or non-paying human can cost. The pool's worst case is 25 × the number of verified humans, which the operator can watch and cap by funding.
- **Big enough to be useful.** It covers a few everyday Noren checkouts (a meal, a ticket, a subscription), so a new customer can try "Pay later" before locking any stock.
- **A starting point.** Customers who want more lock Stock Tokens for the collateralised line, whose limit follows Chainlink prices and their Robinhood Chain history.
- The ceiling is enforced in code. `NOREN_STARTER_LIMIT_USDC6` can be lowered, but the server refuses anything above 100 USDC, and the Arc contract is asked to enforce its own cap (see [Bridge contract](#what-the-bridge-contract-must-accept)).

## How it works

```
Noren app (VerifyHuman)          Noren server (createWorldIdHandler)                World
──────────────────────          ───────────────────────────────────                ─────
POST /world-id/request {wallet} ─▶ RP-sign request (WORLD_RP_SIGNING_KEY, action
                                   noren-credit, 300 s), remember nonce→wallet
◀── app_id, rp_context, signal=wallet
IDKitRequestWidget (selfieCheck({signal: wallet})) ─────────────────────────────▶ World App: Selfie Check
◀────────────────────────────────────────────────────────────────── IDKit result (ZK proof + nullifier)
POST /world-id/verify {idkitResponse} ─▶ local checks (below), then forward unchanged:
                                   POST developer.world.org/api/v4/verify/{rp_id} ─▶ success + environment
                                   claim (action, nullifier) once; one line per wallet
                                   human-starter report ─▶ CRE workflow ─▶ forwarder ─▶ NorenCreditLine.onReport (Arc)
◀── verified + starter line (lineId, 25 USDC, expiry, tx)
```

Before calling World, the server checks the following. Each failed check returns `invalid` with a code, and World is never called.

| Check | Code |
|---|---|
| `protocol_version` is `4.0` (legacy 3.0 proofs are refused) | `protocol_version` |
| The proof is a one-time uniqueness proof, not a session proof | `session_proof` |
| `action` is `noren-credit` | `wrong_action` |
| `environment` is the server's environment (a staging proof can never reach a production check) | `wrong_environment` |
| The nonce is one this server signed. Each request can be used once and expires 300 s after signing. | `unknown_request`, `request_already_used`, `expired` |
| There is exactly one response, and it is the configured credential | `wrong_credential` |
| `signal_hash` equals `hashSignal(wallet)`. The proof is bound to the wallet that asked, so a proof can't be redirected to another wallet. | `signal_mismatch` |
| The nullifier parses as a field element | `bad_nullifier` |

The server then makes two more checks:
- If the nullifier is already in the registry, it returns `already_used` without calling World.
- If World returns success, it must be `success: true` with the expected `environment`, and any nullifier World returns must match the one sent. Otherwise the result is `environment_mismatch` or `nullifier_mismatch`.

World's own rejection is passed through as `invalid`, with World's code. World's `nullifier_replayed` and `max_verifications_reached` are returned as `already_used`. A network failure is returned as `error: verifier_unreachable`, never as a rejection.

### Result type

`VerifyHumanResult` (in `packages/world-id/src/types.ts`) has these statuses:

| Status | Comes from | HTTP |
|---|---|---|
| `verified` | server | 200 |
| `already_used` | server | 409 |
| `invalid` | server | 400 |
| `expired` | server | 410 |
| `setup_required` | server | 503 |
| `error` | server | 502 |
| `cancelled` | the app only (IDKit `user_rejected` or `cancelled`) | – |
| `unavailable` | the app only (IDKit `credential_unavailable` or `world_id_4_not_available`) | – |

A `verified` result carries `starter`, which says where the Arc write stands:
- `submitted`, with the tx hash.
- `setup_required`: no bridge workflow is configured yet.
- `failed`: the write failed. The human stays verified and can retry with `POST /world-id/retry`. Retries have a 30 s cooldown.

## Privacy model

**What Noren stores** in `data/world-id-nullifiers.json`. The `data/` directory is gitignored and the file is written with mode 600. Each verified human is one row:

| Field | Why |
|---|---|
| `nullifier` (stored as a decimal number) | The one-line-per-human check. It is unique per (human, Noren app, `noren-credit`) and is a different number in every other app or action, so it can't be linked to the person or to their activity elsewhere. |
| `wallet` | The wallet the proof was bound to. It becomes the public borrower of the line on Arc anyway, and it enforces one line per wallet. |
| `action`, `credential` type, `verifiedAt` | Housekeeping. |
| Starter line status | `lineId`, limit, expiry and tx hash, so a failed write can be retried. |

**What Noren never stores or sees:** the person's name, face, date of birth, document, phone number or World ID account. The proof itself, the `sybil_score` and the device integrity bundle are forwarded to World and then dropped. The RP signing key never leaves the server, and the tests check that it never appears in a response.

**What is public on Arc:** the borrower wallet, `lineId = keccak256(abi.encode(kind, nullifierHash))` and the report calldata, which includes the nullifier. That tells an observer "this wallet belongs to a human who verified for Noren", but not who that human is. Spending on credit isn't private either, which the Noren app already says on its credit line. Private payments still go through the shielded balance.

## Both paths (demo)

1. **Success.** The customer taps *Verify with World ID* and completes Selfie Check in World App. The server verifies the proof and the app shows *Verified human · 25 USDC · line 0x…*. The bridge's CRE workflow opens the line on Arc.
2. **Already-used human (the meaningful alternative).** The same person tries again from a second wallet. World ID gives the same nullifier for `noren-credit`, so the server answers 409 `already_used` and the app shows *Already used: this human already opened a Noren starter credit line*. No second line is opened. Covered by the tests `refuses the same human on a second wallet…` and `lets only one of two simultaneous proofs…`.
3. Also handled:
   - **Cancelled.** The customer closes World ID. The real IDKit widget was closed in the harness and the app showed *Cancelled · Try again*.
   - **Unavailable.** The customer's World ID has no Selfie Check credential.
   - **Expired.** A request older than 300 s.
   - **Rejected.** World says the proof is invalid.

## Setup (BLOCKED until Nick creates the app)

Agents may not create accounts, so these steps are Nick's:

1. Sign in at **https://developer.world.org** and create an app of type **external / IDKit** (not a mini app).
2. Enable **World ID 4.0** for the app ("Configure World ID"). Copy the `app_id` and `rp_id`. The **signing key** is shown only once: paste it straight into the `.env`.
3. Create the action **`noren-credit`** in **production** (real phones, Selfie Check). For the World ID Simulator, also create a **staging** action `noren-credit`. The simulator may only offer Proof of Human; in that case use `WORLD_CREDENTIAL=proof_of_human` with `WORLD_ENVIRONMENT=staging`.
4. Wait until the app's World ID registration shows **registered**.
5. In the main checkout's gitignored `.env` (`/Volumes/Extreme SSD/Projects/grokbot/projects/noren/.env`), set these by name: `WORLD_APP_ID`, `WORLD_RP_ID`, `WORLD_RP_SIGNING_KEY`, and optionally `WORLD_ENVIRONMENT` and `WORLD_CREDENTIAL`. All names are listed in `packages/world-id/env.example`.
6. Run `pnpm --filter @noren/world-id live`. Both lines should say `PASS`.
7. Run `pnpm --filter @noren/world-id harness`, open http://127.0.0.1:8750/react and complete a Selfie Check. Then try a second wallet to see `already_used`.

## What the bridge contract must accept

`NorenCreditLine` (Arc) belongs to the bridge agent. The world-id package sends the **human starter report** to it:

```
report = abi.encode(bytes32 kind, address borrower, bytes32 nullifierHash, uint256 limitUsdc6, uint64 expiry)
kind   = keccak256("noren.human-starter.v1")   // 160 bytes; the stock report stays 128 bytes
lineId = keccak256(abi.encode(kind, nullifierHash))
```

`onReport` must handle it as follows:
- Open the line only if `humanLine[nullifierHash]` is unset. Otherwise revert `HumanAlreadyHasLine`.
- Revert if `limitUsdc6 > HUMAN_STARTER_MAX_USDC6`. The cap is 25 USDC and owner-settable, never above 100 USDC.
- Never let a 128-byte stock report touch a human line.
- Emit `HumanStarterLineOpened(lineId, borrower, nullifierHash, limitUsdc6, expiry)`.

`payInvoice` and `repay` stay as they are. The relay from `Drawn`/`Repaid` back to Robinhood must **skip human lines**, because they have no `NorenCredit` line behind them.

The CRE workflow needs an **HTTP trigger** that takes `{kind, borrower, nullifierHash, lineId, limitUsdc6, expiry}` (built by `httpTriggerPayload`). It re-checks the fields, encodes the report above and writes it through the forwarder. The server runs it with `cre workflow simulate <workflow> -R <project> -T local-fork --non-interactive --trigger-index N --http-payload <json> --broadcast`, configured by `NOREN_STARTER_CRE_*`. It reads the tx hash from the simulator's `... updated on arc-testnet: tx 0x…` line.

## Integration debrief

- **Time to first success:**
  - **Live: not reached.** It's BLOCKED on a Developer Portal app, because agents can't create accounts.
  - About 10 minutes from opening the docs to server-side verification passing against the documented response shapes, offline.
  - About 12 minutes to the first real IDKit request being accepted by World's staging bridge. The harness got a `connectorURI` back from `staging.world.org`.
  - The real `POST /api/v4/verify` answered our fake proof with a real rejection.
- **Friction:**
  1. Signing an unregistered RP ID like `rp_noren_…` fails in IDKit with "must start with 'rp_'", even though it does start with `rp_`. The real rule is `rp_` plus at most 16 hex digits, and we only found it by reading the bundle.
  2. The verify endpoint answers an RP that doesn't exist with HTTP 400 `app_not_migrated`, not "unknown RP". A typo looks like a migration problem.
  3. The docs don't say whether a World ID 4.0 nullifier is per account or per credential. That decides whether `any(selfie, proof_of_human)` is safe for one-per-human limits, so we had to restrict to one credential.
  4. `sybil_score` is called a "risk signal", but its scale and thresholds aren't documented, so it can't drive a policy.
  5. Uniqueness proofs are one-time per action at the protocol level. The docs don't say whether a user can prove again after the backend fails mid-way (verifier timeout, DB error). That's why we claim the nullifier right after a World success and make the Arc write retryable, rather than asking the user to prove again.
  6. Testing Selfie Check needs Sandbox access through TestFlight or a private Play link, and the Simulator's Selfie Check coverage isn't stated. The Orb is paused in India, so Proof of Human can't be tested with a real phone here.
  7. Every live step needs a Portal account, and the Portal MCP needs a team API key, so an agent can't get from zero to a working app without the account owner.
- **Missing docs:**
  - The RP ID format.
  - The verify error codes. The error-codes page covers IDKit client codes, not the full `/api/v4/verify` code list.
  - Nullifier scope across credentials.
  - The `sybil_score` scale.
  - Retry semantics after a backend failure.
- **The single highest-impact improvement:** a public **staging "dev RP"**: a published `app_id`, `rp_id` and signing key that work only with the Simulator, ideally with Selfie Check support. Integrators could reach a real end-to-end success, including the verify call and the nullifier, before creating an account. Every other gap above is cheap to work around once that first success exists.

## Tests and commands

| Command | What it runs |
|---|---|
| `pnpm --filter @noren/world-id test` | 43 offline tests. Signing (spec test vectors, signer recovery, action binding, key never echoed), registry (decimal storage, concurrent claims, restart, per-wallet), service (success, nullifier reuse, invalid proofs, expiry, verifier env/nullifier mismatch, unreachable verifier, failed Arc write and retry), HTTP routes, and starter report encoding. The verify endpoint is a labelled local stand-in (`test/standin.ts`) that returns the Portal's documented response shapes. Production code always calls developer.world.org. |
| `pnpm --filter @noren/world-id live` | The real verify endpoint. PASSes on the rejection today; the RP check reports BLOCKED until the `WORLD_*` settings exist. |
| `pnpm --filter @noren/world-id harness` | http://127.0.0.1:8750: `/` is a plain IDKit page and `/react` is the `VerifyHuman` component, mounted on the same handler. |
| `pnpm --filter @noren/world-id typecheck` | TypeScript check. |
