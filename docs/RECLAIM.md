# Reclaim Protocol: prove off-chain facts, raise your limit

Noren's Credit page lists tasks that raise a credit limit. One of them proves facts from websites you already use (a
credit score, exchange KYC, a balance, an identity) with [Reclaim Protocol](https://docs.reclaimprotocol.org) zkTLS,
without sharing the account or the page with Noren.

**Status (Nov 6 2026):** live with Nick's Reclaim app. `RECLAIM_APP_ID` and `RECLAIM_APP_SECRET` are set in the
gitignored Noren `.env`; provider IDs are public and live in code (`packages/server/src/reclaim-providers.ts`). Real
proof requests are created and their QR codes, request links and status URLs answer. **A completed proof needs a
person's phone and their login at the provider**; none has been completed from here, and none is faked. Without the
app values the routes answer `503 Setup required: <only the missing variable>`.

## Providers and boosts

Reclaim's current console doesn't attach providers to an app, so any public provider ID works with Nick's app ID.
Each verified proof adds its group's points to the history underwriter's score, **capped at 20 in total**:

| Group | Provider (label) | Provider ID | Points | What Noren keeps |
|---|---|---|---|---|
| Credit score | Credit Score - Bank Bazaar, Experian India (`credit_score_bankbazaar`, the default) | `047db3af-9f36-4e73-bb93-ed762b9e2094` | 15 | `credit score ≥ X` (rounded down to 50) |
| Credit score | Experian credit score US (`credit_score_experian_us`) | `8149b711-aff6-4882-a98e-036253d52129` | 15 | same |
| Credit score | Credit Karma (`credit_karma`) | `add9a3cc-a13e-4572-818d-62446bcae8ef` | 15 | same |
| Exchange KYC | Binance KYC (`binance_kyc`) | `2b22db5c-78d9-4d82-84f0-a9e0a4ed0470` | 8 | `KYC level ≥ 1` |
| Exchange KYC | Coinbase KYC (`coinbase_kyc`) | `285a345c-c6a6-4b9f-9e1e-23432082c0a8` | 8 | same |
| Balances | Coinbase assets (`coinbase_assets`) | `f7a26442-ba57-416d-a303-18baec555b13` | 8 | `balance ≥ 10^n` |
| Balances | Binance balance (`binance_balance`) | `aeeb5c0e-a9df-4eed-ab68-87e127c9dd1b` | 8 | same |
| Balances | Bank of America balance (`bofa_balance`) | `831f6210-015d-458a-b0aa-accf9b76694c` | 8 | same |
| Balances | Wise balance (`wise_balance`) | `fbe865ee-ad0d-4e59-88bc-10352dcc0427` | 8 | same |
| Identity | GitHub account (`github`) | `6d3f6753-7ee6-49ee-a545-62f1b1822ae5` | 3 | `account exists` |

`RECLAIM_PROVIDER_ID` picks the provider shown first; `RECLAIM_PROVIDER_IDS="label:id,…"` replaces an ID per label.

## How it works

1. The app calls `POST /reclaim/request {address, provider: label}` on the Noren server.
2. The server runs `ReclaimProofRequest.init(APP_ID, APP_SECRET, providerId)` (`@reclaimprotocol/js-sdk` 5.8.3,
   server-side only; the secret never reaches the browser), binds the wallet with `setContext(address, …)`, and returns
   the request URL (QR code, **Copy link**, **Open on this phone**) and Reclaim's status URL. The server polls the
   session itself (`startSession`); the modal polls `GET /reclaim/session/:id` every 3 s and updates live.
3. On the phone the person logs in to the provider's site inside Reclaim's verifier; Reclaim's attestors sign the claim
   over the TLS session.
4. The server accepts proofs only if the context names this wallet and this session, the proof ID is new (replay), and
   the SDK's `verifyProof` passes (attestor list, recovered signers, provider hashes for the session's provider version).
5. It stores the minimal claim, then records the proof **type** on-chain (below).

Code: `packages/server/src/reclaim.ts` (routes, `startReclaimRequest`, `verifyAndRecord`), `reclaim-providers.ts`
(catalogue, points, statements), `reclaim-onchain.ts`; mounted on the Noren server by `scripts/dev-all.ts`.

## Routes

| Route | Answer |
|---|---|
| `GET /reclaim/status?address=0x…` | `{ configured, missing[], error?, providers[{label,id,name,group,points}], maxPoints: 20, points, verified[{proofId, provider, points, claim:{statement, parameters, provedAt}, verifiedAt, onchain}] }` |
| `POST /reclaim/request {address, provider?}` | `{ sessionId, requestUrl, statusUrl, provider, expiresAt }`; `503 Setup required: RECLAIM_APP_ID…` naming only what is missing; `400` for an unknown provider label |
| `GET /reclaim/session/:sessionId` | `{ status: "pending" \| "verified" \| "failed", error?, verified? }`; sessions expire after 10 minutes |

## What Noren stores

`data/reclaim-proofs.json` (gitignored, mode 0600), one row per wallet and provider: the lowercased address, the proof
identifier, the session ID, the provider (ID, name, label, group), the points, the **names** of the extracted
parameters and one coarse statement computed in memory from the values: `credit score ≥ 700`, `KYC level ≥ 1`,
`balance ≥ 1,000`, `account exists`. Never names, dates of birth, exact scores or balances; the raw proof is discarded
after verification. The row also keeps the salt of the on-chain commitment (never returned by the API).

## On-chain, private

After verification the server records `NorenReputation.recordAttestation(borrower, kind, commitment, 10000)` with the
attester key (NorenCredit's underwriter; fork: Anvil's published key #9): kind 1 credit score, 2 KYC, 3 balance,
4 identity; `commitment = keccak256(abi.encode(uint8 kind, bytes32 proofId, bytes32 salt))`, the salt kept off-chain.
Every kind uses the same public weight (10,000 bps = 25 points), so the chain learns only the proof type. Each kind is
recorded once per wallet. The UI shows "Recorded on-chain: proof type only, no personal data" with the tx. See
docs/CREDIT.md for how kinds move the LTV ladder.

## Effect on the credit limit (contracts unchanged)

1. The history underwriter (`packages/robinhood/underwriter`) reads the store and adds the factor **"Off-chain facts
   proved with Reclaim (zkTLS)"** (`offchainProof`, the sum of the proofs' points, at most 20).
2. The score sets the tier the underwriter signs into the EIP-712 `CreditAttestation` that `NorenCredit` verifies: a
   better tier means a higher limit and a lower collateral ratio on the stock-backed credit line (150% → 140% → 130% →
   125%, i.e. 67% → 80% of the stock's value). The NorenReputation multiplier still applies on top.
3. `GET /score/:address` returns `reclaim: { verified, provider?, points, maxPoints, decidedBy, ifVerified: { score,
   tier, limitUsdg, collateralRatioBps } }` ("if" = one more credit-score proof), so the app shows before and after.

Each recorded kind also adds 25 points on NorenReputation, which moves the 66 → 80% LTV ladder (docs/CREDIT.md). When the 0G credit check is configured (`ZG_PC_API_KEY`), the sealed 0G model sets the signed
terms and does not read the proofs yet; `reclaim.decidedBy` says which path applies.

## A proof from Nick's phone

```
pnpm exec tsx scripts/live/reclaim-request.ts github            # or any label above; optional 2nd arg: wallet
```
It prints only the request URL (open it on the phone) and the status, waits up to 30 minutes, verifies the proof, stores
the statement and records it on the local Robinhood fork when `pnpm dev:all` is running. GitHub is the default: the
easiest phone login. In the app the same flow is Credit → Raise your limit → Prove with Reclaim → pick a provider.

## Live checks (Nov 6 2026, Nick's app)

- `ReclaimProofRequest.init` with the Experian India provider (`cf6dd149-…`) and later with GitHub returned a request URL
  on `portal.reclaimprotocol.org` and a status URL on `api.reclaimprotocol.org` that answered HTTP 200 "Session fetched
  successfully".
- In the app (dev:all, Credit → Prove GitHub account) the modal showed the QR for a real session, Copy link and
  Open on this phone, and "Waiting for the proof from your phone…".
- `scripts/live/reclaim-request.ts github` printed the request URL and "Status: pending" for a real session.
- No proof was completed: that needs a phone.

## Tests

- `packages/server/src/reclaim.test.ts` (offline, 9): Setup required naming only the missing variables, the provider
  catalogue in four groups and env overrides, unknown labels rejected, the secret never echoed, coarse statements
  (score rounded to 50, balance to a power of ten, no names or DOB), salted commitments, and proofs bound to another
  wallet or session or malformed rejected with nothing stored.
- `packages/server/src/reclaim.live.test.ts` (live, 4): the real attestor list, then the real `verifyProof` rejects a
  proof signed by a non-attestor and a tampered claim, and `verifyAndRecord` stores nothing. No Reclaim API or SDK mock.
- `packages/server/src/reclaim-onchain.fork.test.ts` (fork, 1): against the deployed NorenReputation, records an identity
  attestation (kind 4, salted commitment, 10,000 bps), reads it back with `attestationsOf`, and a second one of the same
  kind is refused (`KindAlreadyRecorded`).
- `packages/robinhood/underwriter/test/score.test.ts`: the factor adds the proofs' points, is capped at 20, can move a
  wallet from tier 0 to tier 1, and never lifts the score above 100.
