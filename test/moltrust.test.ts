import { describe, expect, it } from "vitest";
import { createPublicKey, verify } from "node:crypto";
import vectors from "./enforce-vectors.json" with { type: "json" };
import {
  actionDigest,
  buildMandate,
  canonicalize,
  checkSpend,
  mandateDigest,
  RateLimitedError,
  registerAgent,
  retryAfterMs,
  solvePow,
  type FetchLike,
} from "../src/moltrust.js";

describe("canonicalization and digests match the reference server", () => {
  it("rebuilds the pinned mandate byte for byte", () => {
    const m = buildMandate({
      companyId: vectors.mandate.subject.company_id,
      budgetCents: vectors.mandate.budget.amount_cents,
      currency: vectors.mandate.budget.currency,
      allowedActions: ["purchase", "ad_spend"],
      validFrom: vectors.mandate.validity.not_before,
      validUntil: vectors.mandate.validity.not_after,
    });
    expect(m).toEqual(vectors.mandate);
  });

  for (const c of vectors.cases) {
    it(`action and mandate digest: ${c.name}`, () => {
      expect(actionDigest(c.transaction.action)).toBe(c.action_digest);
      expect(mandateDigest(vectors.mandate)).toBe(c.mandate_digest);
    });
  }

  it("sorts keys by UTF-16 code units and refuses non-JSON", () => {
    expect(canonicalize({ b: 1, a: [true, null, "x"] })).toBe('{"a":[true,null,"x"],"b":1}');
    expect(() => canonicalize({ x: Number.NaN })).toThrow();
    expect(() => canonicalize({ x: () => 1 })).toThrow();
  });
});

describe("mandate", () => {
  it("has one grant per action and denies a zero budget by construction", () => {
    const m = buildMandate({ companyId: "c", budgetCents: 0, currency: "USD", allowedActions: ["purchase", "purchase", " "], validFrom: 1, validUntil: 2 });
    expect(m.grants).toHaveLength(1);
    expect(m.grants[0]!.constraints[0]).toEqual({ type: "range", field: "amount_cents", lo: 1, hi: 0 });
  });

  it("rejects a negative budget and an empty action list", () => {
    expect(() => buildMandate({ companyId: "c", budgetCents: -1, currency: "USD", allowedActions: ["x"], validFrom: 1, validUntil: 2 })).toThrow();
    expect(() => buildMandate({ companyId: "c", budgetCents: 1, currency: "USD", allowedActions: [], validFrom: 1, validUntil: 2 })).toThrow();
  });
});

describe("registration", () => {
  it("solves the proof of work", () => {
    const nonce = solvePow("seed", 8);
    expect(nonce).toMatch(/^[0-9a-f]+$/);
  });

  it("sends a valid proof of possession and no Paperclip data in the name", async () => {
    let sent: Record<string, unknown> = {};
    const fake: FetchLike = async (url, init) => {
      if (url.endsWith("/identity/register-challenge")) {
        return Response.json({ challenge: "abc.def", pow: { seed: "abc", difficulty_bits: 4 } });
      }
      sent = JSON.parse(String(init?.body));
      return Response.json({ did: "did:moltrust:1234567890abcdef" });
    };
    const id = await registerAgent({ apiUrl: "https://x", platform: "paperclip", fetch: fake });
    expect(id.did).toBe("did:moltrust:1234567890abcdef");
    expect(sent.platform).toBe("paperclip");
    expect(sent.source).toBe("paperclip-plugin-moltrust");
    expect(sent.display_name).toBe(`paperclip-agent-${id.publicKeyHex.slice(0, 12)}`);
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(id.publicKeyHex, "hex")]);
    const ok = verify(null, Buffer.from("abc.def"), createPublicKey({ key: spki, format: "der", type: "spki" }), Buffer.from(String(sent.signature), "base64url"));
    expect(ok).toBe(true);
  });

  it("throws on a refused registration so the sweep can retry", async () => {
    const fake: FetchLike = async (url) =>
      url.endsWith("/identity/register-challenge")
        ? Response.json({ challenge: "a.b", pow: { seed: "a", difficulty_bits: 0 } })
        : new Response("rate limited", { status: 429 });
    await expect(registerAgent({ apiUrl: "https://x", platform: "paperclip", fetch: fake })).rejects.toThrow(/429/);
  });

  it("a 429 is a RateLimitedError carrying the route and Retry-After", async () => {
    const fake: FetchLike = async (url) =>
      url.endsWith("/identity/register-challenge")
        ? Response.json({ challenge: "a.b", pow: { seed: "a", difficulty_bits: 0 } })
        : new Response("", { status: 429, headers: { "Retry-After": "120" } });
    const err = await registerAgent({ apiUrl: "https://x", platform: "paperclip", fetch: fake }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(err).toMatchObject({ route: "register-pop", retryAfterMs: 120_000 });

    const onChallenge: FetchLike = async () => new Response("", { status: 429 });
    const err2 = await registerAgent({ apiUrl: "https://x", platform: "paperclip", fetch: onChallenge }).catch((e: unknown) => e);
    expect(err2).toMatchObject({ route: "register-challenge", retryAfterMs: null });
  });

  it("reads Retry-After as seconds or as an HTTP date", () => {
    const now = new Date("2026-11-06T12:00:00Z");
    expect(retryAfterMs(new Response("", { headers: { "Retry-After": "30" } }), now)).toBe(30_000);
    expect(retryAfterMs(new Response("", { headers: { "Retry-After": "Fri, 06 Nov 2026 12:05:00 GMT" } }), now)).toBe(300_000);
    expect(retryAfterMs(new Response(""), now)).toBeNull();
    expect(retryAfterMs(new Response("", { headers: { "Retry-After": "soon" } }), now)).toBeNull();
  });
});

describe("checkSpend is fail-closed", () => {
  const mandate = vectors.mandate as Parameters<typeof checkSpend>[0]["mandate"];
  const tx = vectors.cases[0]!.transaction;
  const run = (fake: FetchLike) => checkSpend({ apiUrl: "https://x", did: null, mandate, transaction: tx, fetch: fake });

  it("PERMIT only from a 200 that says PERMIT", async () => {
    const v = await run(async () => Response.json({ verdict: "PERMIT", reason: "ok", record: { core_digest: "sha256:aa" } }));
    expect(v.verdict).toBe("PERMIT");
    expect(v.coreDigest).toBe("sha256:aa");
  });

  it.each([
    ["network error", async () => { throw new Error("ECONNREFUSED"); }],
    ["HTTP 500", async () => new Response("x", { status: 500 })],
    ["not JSON", async () => new Response("<html>", { status: 200 })],
    ["unknown verdict", async () => Response.json({ verdict: "ALLOW" })],
  ] as Array<[string, FetchLike]>)("DENY on %s", async (_n, fake) => {
    const v = await run(fake);
    expect(v.verdict).toBe("DENY");
    expect(v.fromServer).toBe(false);
  });
});
