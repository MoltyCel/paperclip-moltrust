# paperclip-moltrust

MolTrust for [Paperclip](https://github.com/paperclipai/paperclip). Install it once and every company on the instance gets three things with no further setup:

1. **A DID for every agent.** When an agent is created or a hire is approved, the plugin registers a W3C DID for it at MolTrust (Ed25519 key generated locally, proof of possession, the private key stays in your Paperclip instance).
2. **The company budget as an AAE mandate.** The monthly budget becomes an Agent Authorization Envelope: amount limit, lifetime, and the list of actions that may spend money.
3. **A check before every spend.** Agents call the `check_spend` tool before an ad buy, a purchase, a subscription or a transfer. The plugin asks MolTrust `POST /enforce/check` and returns `PERMIT` or `DENY`. Every verdict lands in the Paperclip activity log with a record digest anyone can recompute.

## Quickstart

One command, from the GitHub release, on the machine that runs Paperclip:

```sh
mkdir -p ~/.paperclip/plugin-src/moltrust && curl -fsSL https://github.com/MoltyCel/paperclip-moltrust/releases/download/v0.1.0/paperclip-plugin-moltrust-0.1.0.tgz | tar xz --strip-components=1 -C ~/.paperclip/plugin-src/moltrust && npx paperclipai plugin install --local ~/.paperclip/plugin-src/moltrust
```

The package is a single bundled file with no runtime dependencies, so a local install needs no `npm install`. Requires Paperclip 2026.1023.0 or later and Node 24.11 or later.

## What an agent sees

The plugin registers one tool, `paperclip-plugin-moltrust:check_spend`:

```json
{ "action": "ad_spend", "amountCents": 60000, "counterparty": "meta-ads" }
```

Answer on a company with a 500 USD monthly budget:

```json
{ "error": "DENY: do not execute ad_spend of 60000 cents. no matching grant satisfied its constraints",
  "data": { "verdict": "DENY", "coreDigest": "sha256:…", "transaction": { "amount_cents": 60000, "spent_after_cents": 60000, "…": "…" } } }
```

Put one line into each agent's instructions: *"Before any action that spends money, call `check_spend`. Do not execute on DENY."*

## The mandate

For each company the plugin builds one mandate from the Paperclip budget:

| Mandate part | Source | Kernel check |
|---|---|---|
| One `allow` grant per action | config `allowedActions` (default `ad_spend`, `purchase`, `subscription`, `transfer`) | an action without a grant is denied |
| Single amount | `companies.budget_monthly_cents` | `1 ≤ amount_cents ≤ budget` |
| Running total | Paperclip `spentMonthlyCents` plus spend this plugin permitted in the mandate window | `spent_after_cents ≤ budget` |
| Lifetime | config `mandateDays` (default 31) | `not_before ≤ requested_at ≤ not_after` |

A budget of 0 means no money action is permitted. The mandate is renewed when the budget, the action list or the currency changes, and when it expires. The verdict depends only on mandate and transaction: `moltrust-enforce` recomputes it offline from the `core_digest` in the activity log.

The check is fail-closed: only a readable HTTP 200 that says `PERMIT` permits. Network errors, other statuses and unknown answers are `DENY`.

## Configuration

Per company, in the plugin settings or with `POST /api/plugins/:id/config` (`{companyId, configJson}`):

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` switches MolTrust off for this company |
| `allowedActions` | `["ad_spend","purchase","subscription","transfer"]` | actions that may spend money |
| `mandateDays` | `31` | mandate lifetime |
| `currency` | `USD` | currency of the budget |
| `platform` | `paperclip` | platform value sent with each registration |
| `apiUrl` | `https://api.moltrust.ch` | MolTrust API |

## Opt-out, and what is sent

Nothing here is hidden. You can switch it off at three levels:

- **Whole instance:** `npx paperclipai plugin disable paperclip-plugin-moltrust`, or `uninstall` to remove it.
- **One company:** set `enabled` to `false` in the company's plugin config. No registrations, no checks, `check_spend` answers `OFF`.
- **One agent:** do not tell it to call `check_spend`.

What leaves your instance, to `api.moltrust.ch` only:

- On registration: the agent's public key, a signature over a server challenge, a proof-of-work nonce, the display name `paperclip-agent-<first 12 hex of the public key>`, platform `paperclip`, source `paperclip-plugin-moltrust`. No company name, no agent name, no prompts.
- On a check: the mandate (company id, budget, lifetime, action digests) and the transaction (action, amount, running total, timestamp, the optional `counterparty`), with the agent's DID in `X-MolTrust-DID`.

The DID registry is public: a registered DID, its public key and its display name can be looked up.

## How it hooks into Paperclip

- `company.created` / `company.updated` → mandate.
- `agent.created`, and `approval.decided` when it carries an agent id → DID registration; a reconcile job every 5 minutes registers any agent still without a DID (for example hires approved while the worker was down). Registration is idempotent per agent.
- `check_spend` tool → `/enforce/check`, activity log entry for each verdict.

Paperclip has no synchronous veto hook for plugins, so the check runs where the agent asks for it. For tools that go through Paperclip's MCP tool gateway you can add a `require_approval` policy as a second line.

## Development

```sh
npm ci
npm test          # vitest, including digest parity with the MolTrust reference server
npm run typecheck
npm run build     # dist/worker.js and dist/manifest.js, bundled with esbuild
```

`test/enforce-vectors.json` pins five verdicts and their digests as `POST https://api.moltrust.ch/enforce/check` returned them; the tests rebuild the same mandate byte for byte.

## License

MIT
