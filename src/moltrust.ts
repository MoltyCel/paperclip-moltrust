import { createHash, generateKeyPairSync, sign, createPrivateKey, KeyObject } from "node:crypto";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const DEFAULT_API_URL = "https://api.moltrust.ch";
export const DEFAULT_PLATFORM = "paperclip";
export const SOURCE = "paperclip-plugin-moltrust";
export const MANDATE_PROFILE = "paperclip-company-budget/v1";

const TAG_ACTION = "aae:enforce-action:v1\u0000";
const TAG_MANDATE = "aae:enforce-mandate:v1\u0000";
const HEX_RE = /^[0-9a-f]+$/;

/** RFC 8785 JSON canonicalization for the JSON values a mandate and a transaction carry. */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined);
    keys.sort((a, b) => {
      const ua = utf16(a);
      const ub = utf16(b);
      for (let i = 0; i < Math.min(ua.length, ub.length); i++) {
        if (ua[i] !== ub[i]) return ua[i]! - ub[i]!;
      }
      return ua.length - ub.length;
    });
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
  }
  throw new Error(`value of type ${typeof value} is not JSON`);
}

function utf16(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
  return out;
}

function taggedDigest(tag: string, value: unknown): string {
  const h = createHash("sha256");
  h.update(Buffer.from(tag, "utf8"));
  h.update(Buffer.from(canonicalize(value), "utf8"));
  return "sha256:" + h.digest("hex");
}

/** `sha256:<hex>` over the domain tag and JCS(action), as `action_digest` in moltrust-enforce. */
export function actionDigest(action: Record<string, unknown>): string {
  return taggedDigest(TAG_ACTION, action);
}

/** `mandate_digest` as the enforce record carries it. */
export function mandateDigest(mandate: unknown): string {
  return taggedDigest(TAG_MANDATE, mandate);
}

// ----------------------------------------------------------------- registration

export interface AgentIdentity {
  did: string;
  publicKeyHex: string;
  /** PKCS#8 DER, base64. Stays in the Paperclip instance. */
  privateKeyPkcs8: string;
  platform: string;
  registeredAt: string;
}

function leadingZeroBits(digest: Buffer): number {
  let n = 0;
  for (const byte of digest) {
    if (byte === 0) {
      n += 8;
      continue;
    }
    return n + Math.clz32(byte) - 24;
  }
  return n;
}

export function solvePow(seed: string, bits: number): string {
  for (let i = 0; ; i++) {
    const nonce = i.toString(16);
    const d = createHash("sha256").update(seed + nonce, "ascii").digest();
    if (leadingZeroBits(d) >= bits) return nonce;
  }
}

function rawPublicKeyHex(pub: KeyObject): string {
  const der = pub.export({ format: "der", type: "spki" });
  return Buffer.from(der.subarray(der.length - 32)).toString("hex");
}

export interface RegisterOptions {
  apiUrl: string;
  platform: string;
  fetch: FetchLike;
  now?: () => Date;
}

/**
 * Register one DID through the keyless proof-of-possession route:
 * GET /identity/register-challenge, then POST /identity/register-pop.
 * The private key never leaves this process. The display name carries no
 * Paperclip data (company or agent names), only part of the public key.
 */
export async function registerAgent(opts: RegisterOptions): Promise<AgentIdentity> {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = rawPublicKeyHex(publicKey);
  const chRes = await opts.fetch(`${opts.apiUrl}/identity/register-challenge`);
  if (!chRes.ok) throw new Error(`register-challenge answered HTTP ${chRes.status}`);
  const ch = (await chRes.json()) as { challenge: string; pow?: { seed?: string; difficulty_bits?: number } };
  const seed = ch.pow?.seed ?? ch.challenge.split(".", 1)[0]!;
  const nonce = solvePow(seed, Number(ch.pow?.difficulty_bits ?? 0));
  const signature = sign(null, Buffer.from(ch.challenge, "ascii"), privateKey).toString("base64url");
  const body = {
    public_key: pub,
    challenge: ch.challenge,
    signature,
    pow_nonce: nonce,
    display_name: `paperclip-agent-${pub.slice(0, 12)}`,
    platform: opts.platform,
    source: SOURCE,
    framework: "paperclip",
  };
  const res = await opts.fetch(`${opts.apiUrl}/identity/register-pop`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": `${SOURCE}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`register-pop answered HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const doc = (await res.json()) as { did?: string };
  if (!doc.did) throw new Error("register-pop answered without a DID");
  return {
    did: doc.did,
    publicKeyHex: pub,
    privateKeyPkcs8: Buffer.from(privateKey.export({ format: "der", type: "pkcs8" })).toString("base64"),
    platform: opts.platform,
    registeredAt: (opts.now ?? (() => new Date()))().toISOString(),
  };
}

/** Load a stored key, for callers that sign later requests with the agent's key. */
export function privateKeyFrom(identity: AgentIdentity): KeyObject {
  return createPrivateKey({ key: Buffer.from(identity.privateKeyPkcs8, "base64"), format: "der", type: "pkcs8" });
}

export function isHex(s: string): boolean {
  return HEX_RE.test(s);
}

// --------------------------------------------------------------------- mandate

export interface MandateInput {
  companyId: string;
  budgetCents: number;
  currency: string;
  allowedActions: string[];
  validFrom: number;
  validUntil: number;
}

export interface CompanyMandate {
  profile: string;
  subject: { platform: "paperclip"; company_id: string };
  budget: { amount_cents: number; currency: string };
  validity: { not_before: number; not_after: number };
  grants: Array<{
    action_binding: string;
    type_fields: string[];
    disposition: "allow";
    constraints: Array<{ type: "range"; field: string; lo: number; hi: number }>;
  }>;
}

/**
 * The company budget as an AAE mandate: one allow grant per permitted action,
 * each bound by three closed integer ranges the kernel checks without a clock:
 * the single amount, the running total after this spend, and the time of the
 * request inside the mandate's lifetime. An action without a grant is denied.
 */
export function buildMandate(input: MandateInput): CompanyMandate {
  if (!Number.isInteger(input.budgetCents) || input.budgetCents < 0) {
    throw new Error("budgetCents must be a non-negative integer");
  }
  const verbs = [...new Set(input.allowedActions.map((v) => v.trim()).filter(Boolean))].sort();
  if (verbs.length === 0) throw new Error("allowedActions is empty");
  const constraints = [
    { type: "range" as const, field: "amount_cents", lo: 1, hi: input.budgetCents },
    { type: "range" as const, field: "spent_after_cents", lo: 0, hi: input.budgetCents },
    { type: "range" as const, field: "requested_at", lo: input.validFrom, hi: input.validUntil },
  ];
  return {
    profile: MANDATE_PROFILE,
    subject: { platform: "paperclip", company_id: input.companyId },
    budget: { amount_cents: input.budgetCents, currency: input.currency },
    validity: { not_before: input.validFrom, not_after: input.validUntil },
    grants: verbs.map((verb) => ({
      action_binding: actionDigest({ verb, currency: input.currency }),
      type_fields: ["verb", "currency"],
      disposition: "allow" as const,
      constraints,
    })),
  };
}

export interface SpendTransaction {
  action: { verb: string; currency: string };
  amount_cents: number;
  spent_after_cents: number;
  requested_at: number;
  counterparty?: string;
}

// ----------------------------------------------------------------------- check

export interface Verdict {
  verdict: "PERMIT" | "DENY" | "PENDING";
  reason: string;
  coreDigest: string | null;
  fromServer: boolean;
  trace?: unknown;
}

/**
 * POST /enforce/check. Fail-closed like moltrust-enforce: only a 200 that was
 * read and says PERMIT is a PERMIT; transport errors, other statuses, a wrong
 * shape or an unknown verdict are DENY.
 */
export async function checkSpend(opts: {
  apiUrl: string;
  did: string | null;
  mandate: CompanyMandate;
  transaction: SpendTransaction;
  fetch: FetchLike;
}): Promise<Verdict> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.did) headers["X-MolTrust-DID"] = opts.did;
  let res: Response;
  try {
    res = await opts.fetch(`${opts.apiUrl}/enforce/check`, {
      method: "POST",
      headers,
      body: JSON.stringify({ mandate: opts.mandate, transaction: opts.transaction }),
    });
  } catch (err) {
    return { verdict: "DENY", reason: `enforce check unreachable: ${String(err)}`, coreDigest: null, fromServer: false };
  }
  if (res.status !== 200) {
    return { verdict: "DENY", reason: `enforce check answered HTTP ${res.status}`, coreDigest: null, fromServer: false };
  }
  let body: { verdict?: unknown; reason?: unknown; trace?: unknown; record?: { core_digest?: unknown } };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    return { verdict: "DENY", reason: "enforce check answered no JSON", coreDigest: null, fromServer: false };
  }
  const v = body?.verdict;
  if (v !== "PERMIT" && v !== "DENY" && v !== "PENDING") {
    return { verdict: "DENY", reason: "enforce check answered an unknown verdict", coreDigest: null, fromServer: false };
  }
  return {
    verdict: v,
    reason: typeof body.reason === "string" ? body.reason : "",
    coreDigest: typeof body.record?.core_digest === "string" ? body.record.core_digest : null,
    fromServer: true,
    trace: body.trace,
  };
}
