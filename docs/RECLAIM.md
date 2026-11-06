# Reclaim Protocol: prove an off-chain fact, raise your limit

Noren's Credit page lists tasks that raise a credit limit. One of them proves a fact from a website you already use
(for example your credit score or an exchange KYC status) with [Reclaim Protocol](https://docs.reclaimprotocol.org)
zkTLS, without sharing the account or the page with Noren.

Status: **Setup required** until Nick creates the Reclaim app (steps below). Without `RECLAIM_APP_ID`,
`RECLAIM_APP_SECRET` and `RECLAIM_PROVIDER_ID` the routes answer `503 Setup required: …`; nothing is faked.

## How it works

1. The app calls `POST /reclaim/request {address}` on the Noren server.
2. The server runs `ReclaimProofRequest.init(APP_ID, APP_SECRET, PROVIDER_ID)` (`@reclaimprotocol/js-sdk` 5.8.3;
   server-side only, the secret never reaches the browser), binds the wallet with `setContext(address, …)`, and
   returns the request URL (shown as a QR code) and Reclaim's status URL. The server then polls the session itself
   (`startSession`).
3. The customer scans the QR with their phone and logs in to the provider's site inside Reclaim's verifier. Reclaim's
   attestors sign the claim over the TLS session.
4. When proofs arrive, the server accepts them only if:
   - the proof context names this wallet and this Reclaim session;
   - the proof identifier was not used before (replay);
   - the SDK's `verifyProof` passes: it fetches Reclaim's attestor list, recovers the signers and checks the
     provider's request hashes for the provider version used in the session.
5. The app polls `GET /reclaim/session/:sessionId` (`pending | verified | failed`) and shows the verified state.

Code: `packages/server/src/reclaim.ts`; mounted on the Noren server by `scripts/dev-all.ts`.

## Routes

| Route | Answer |
|---|---|
| `GET /reclaim/status?address=0x…` | `{ configured, missing[], error?, provider: {id,name} \| null, verified: {proofId, provider, claim, verifiedAt} \| null }` |
| `POST /reclaim/request {address}` | `{ sessionId, requestUrl, statusUrl, provider, expiresAt }`; `503 {error:"Setup required: RECLAIM_APP_ID, …"}` without credentials |
| `GET /reclaim/session/:sessionId` | `{ status: "pending" \| "verified" \| "failed", error?, verified? }`; sessions expire after 10 minutes |

## What Noren stores

`data/reclaim-proofs.json` (gitignored, mode 0600), one row per wallet: the lowercased address, the proof identifier,
the session ID, the provider ID and name, and `claim: { proved: true, parameters: [names], provedAt }`. Only the
**names** of the extracted parameters are kept (for example `latestScore`), never their values, and no other
personal data. The raw proof is discarded after verification.

## Effect on the credit limit (contracts unchanged)

A verified proof feeds the existing credit-attestation path, so no contract changes:

1. The history underwriter (`packages/robinhood/underwriter`) reads the proof store and adds the factor
   **"Off-chain fact proved with Reclaim (zkTLS)"** (`offchainProof`, +10 points) to the wallet's score.
2. The score sets the tier and limit, which the underwriter signs as the EIP-712 `CreditAttestation` that
   `NorenCredit` already verifies when a credit line opens; the NorenReputation multiplier still applies on top.
3. `GET /score/:address` also returns `reclaim: { verified, provider?, proofId?, points: 10, decidedBy, ifVerified:
   { score, tier, limitUsdg } }`, so the app shows the limit before and after the task.

Honest limit: when the 0G credit check is configured (`ZG_PC_API_KEY`), the sealed 0G model sets the signed terms
and its inputs do not include the Reclaim fact; the factor then shows in the score but does not change those terms.
`reclaim.decidedBy` says which path applies (`0g` or `deterministic-score`).

## Setup (Nick)

1. Open https://dev.reclaimprotocol.org and sign in.
2. **Create an application.** Copy its **App ID** and **App Secret** (the secret is shown once).
3. **Add a provider** to the application. Recommended: **`Experian - RW Credit Score`**
   (provider ID `cf6dd149-8444-49de-9851-63ed3a4f8832`, in Reclaim's verified provider list on Nov 6 2026). It
   logs in to consumer.experian.in and extracts a single parameter, `latestScore`, which is the most
   credit-relevant fact with the least personal data. Alternative for an exchange account:
   **`Binance KYC Status`** (`7d43d323-2c24-4f4c-9cce-dd4aa57301fb`; it also reads name and date of birth, which
   Noren does not store).
4. Copy the **Provider ID** from the application.
5. Put the values in `/Volumes/Extreme SSD/Projects/grokbot/projects/noren/.env` (gitignored; names in
   `packages/server/env.example`):
   ```
   RECLAIM_APP_ID=…
   RECLAIM_APP_SECRET=…
   RECLAIM_PROVIDER_ID=cf6dd149-8444-49de-9851-63ed3a4f8832
   RECLAIM_PROVIDER_NAME=Experian - RW Credit Score
   ```
6. Restart `pnpm dev:all`; the "Setup required: Reclaim …" line disappears from the startup summary.

## Tests

- `packages/server/src/reclaim.test.ts` (offline, 6): 503 Setup required naming each missing variable,
  `configured:false`, the secret never echoed, bad addresses and unknown sessions, and proofs bound to another
  wallet or session or malformed are rejected with nothing stored.
- `packages/server/src/reclaim.live.test.ts` (live, 4; `pnpm exec vitest run packages/server/src/reclaim.live.test.ts`):
  fetches the real attestor list (fails if Reclaim is unreachable), then the real `verifyProof` rejects a
  well-formed proof signed by a non-attestor and a tampered claim, and `verifyAndRecord` throws
  `ReclaimProofRejected` and stores nothing. No Reclaim API or SDK is mocked.
- `packages/robinhood/underwriter/test/score.test.ts`: the `offchainProof` factor adds 10 points, can move a wallet
  from tier 0 to tier 1, and never lifts the score above 100.
