import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import { BACKOFF_BASE_MS, createMoltrust, makePlugin, settingsFrom } from "../src/worker.js";
import { actionDigest, type FetchLike } from "../src/moltrust.js";

const COMPANY = "11111111-2222-3333-4444-555555555555";
const AGENTS = ["a0000000-0000-0000-0000-000000000001", "a0000000-0000-0000-0000-000000000002", "a0000000-0000-0000-0000-000000000003"];
const NOW = new Date("2026-11-06T12:00:00Z");

function fakeMoltrust() {
  const registrations: Array<Record<string, unknown>> = [];
  const checks: Array<Record<string, unknown>> = [];
  const fetch: FetchLike = async (url, init) => {
    if (url.endsWith("/identity/register-challenge")) {
      return Response.json({ challenge: "c.h", pow: { seed: "c", difficulty_bits: 2 } });
    }
    if (url.endsWith("/identity/register-pop")) {
      const body = JSON.parse(String(init?.body));
      registrations.push(body);
      return Response.json({ did: `did:moltrust:${String(body.public_key).slice(0, 16)}` });
    }
    if (url.endsWith("/enforce/check")) {
      const { mandate, transaction } = JSON.parse(String(init?.body));
      checks.push({ mandate, transaction, did: (init?.headers as Record<string, string>)["X-MolTrust-DID"] });
      const binding = actionDigest(transaction.action);
      const grants = (mandate.grants as Array<any>).filter((g) => g.action_binding === binding);
      if (!grants.length) return Response.json({ verdict: "DENY", reason: "unaddressed action", record: { core_digest: "sha256:00" } });
      const ok = grants.some((g) =>
        g.constraints.every((c: any) => Number.isInteger(transaction[c.field]) && c.lo <= c.hi && c.lo <= transaction[c.field] && transaction[c.field] <= c.hi),
      );
      return Response.json(
        ok
          ? { verdict: "PERMIT", reason: "all constraints hold", record: { core_digest: "sha256:11" } }
          : { verdict: "DENY", reason: "no matching grant satisfied its constraints", record: { core_digest: "sha256:22" } },
      );
    }
    return new Response("not found", { status: 404 });
  };
  return { fetch, registrations, checks };
}

async function setup(opts: { config?: Record<string, unknown>; budget?: number } = {}) {
  const mt = fakeMoltrust();
  const harness = createTestHarness({ manifest, config: opts.config ?? {} });
  harness.seed({
    companies: [{ id: COMPANY, name: "Example Co", budgetMonthlyCents: opts.budget ?? 50000, spentMonthlyCents: 0 } as any],
    agents: AGENTS.map((id, i) => ({ id, companyId: COMPANY, name: ["CEO", "Engineer", "Growth"][i], status: "idle" }) as any),
  });
  const plugin = makePlugin({ fetch: mt.fetch, now: () => NOW, startupSweep: false });
  await plugin.definition.setup(harness.ctx);
  return { harness, mt };
}

const run = (agentId: string) => ({ agentId, companyId: COMPANY, runId: "r1", projectId: "" });

describe("registration on hire", () => {
  it("registers exactly one DID per agent, even when events repeat", async () => {
    const { harness, mt } = await setup();
    for (const id of [...AGENTS, ...AGENTS]) {
      await harness.emit("agent.created", {}, { companyId: COMPANY, entityId: id, entityType: "agent" });
    }
    await harness.runJob("reconcile");
    expect(mt.registrations).toHaveLength(3);
    expect(new Set(mt.registrations.map((r) => r.platform))).toEqual(new Set(["paperclip"]));
    for (const id of AGENTS) {
      const s = harness.getState({ scopeKind: "agent", scopeId: id, namespace: "moltrust", stateKey: "identity" }) as any;
      expect(s.did).toMatch(/^did:moltrust:/);
    }
  });

  it("the reconcile job picks up agents that never fired agent.created", async () => {
    const { harness, mt } = await setup();
    await harness.runJob("reconcile");
    expect(mt.registrations).toHaveLength(3);
  });

  it("opt-out: config enabled=false registers nothing and checks nothing", async () => {
    const { harness, mt } = await setup({ config: { enabled: false } });
    await harness.emit("agent.created", {}, { companyId: COMPANY, entityId: AGENTS[0], entityType: "agent" });
    await harness.runJob("reconcile");
    const r = await harness.executeTool<any>("check_spend", { action: "purchase", amountCents: 100 }, run(AGENTS[0]!));
    expect(mt.registrations).toHaveLength(0);
    expect(mt.checks).toHaveLength(0);
    expect(r.data.verdict).toBe("OFF");
  });

  it("per-company platform value is sent with each registration", async () => {
    const { harness, mt } = await setup({ config: { platform: "Test" } });
    await harness.runJob("reconcile");
    expect(mt.registrations.map((r) => r.platform)).toEqual(["test", "test", "test"]);
  });
});

// ------------------------------------------------- many agents, one step

/** A MolTrust stand-in with the production per-IP limit on register-pop. */
function limitedMoltrust(opts: { perWindow?: number; windowMs?: number; retryAfter?: string; clock: { t: number } }) {
  const perWindow = opts.perWindow ?? 30;
  const windowMs = opts.windowMs ?? 3600_000;
  const pops: number[] = [];
  let refused = 0;
  let challenges = 0;
  const fetch: FetchLike = async (url, init) => {
    if (url.endsWith("/identity/register-challenge")) {
      challenges++;
      return Response.json({ challenge: "c.h", pow: { seed: "c", difficulty_bits: 1 } });
    }
    if (url.endsWith("/identity/register-pop")) {
      const windowStart = Math.floor(opts.clock.t / windowMs) * windowMs;
      if (pops.filter((t) => t >= windowStart).length >= perWindow) {
        refused++;
        return new Response(JSON.stringify({ error: "Rate limit exceeded. Try again later." }), {
          status: 429,
          headers: opts.retryAfter ? { "Retry-After": opts.retryAfter } : {},
        });
      }
      pops.push(opts.clock.t);
      const body = JSON.parse(String(init?.body));
      return Response.json({ did: `did:moltrust:${String(body.public_key).slice(0, 16)}` });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetch, pops, refusedCount: () => refused, challengeCount: () => challenges };
}

function seedMany(n: number, opts: { status?: (i: number) => string } = {}) {
  const harness = createTestHarness({ manifest, config: {} });
  const ids = Array.from({ length: n }, (_, i) => `b0000000-0000-0000-0000-${String(i).padStart(12, "0")}`);
  harness.seed({
    companies: [{ id: COMPANY, name: "Example Co", budgetMonthlyCents: 50000, spentMonthlyCents: 0 } as any],
    agents: ids.map((id, i) => ({ id, companyId: COMPANY, name: `Agent ${i}`, status: opts.status?.(i) ?? "idle" }) as any),
  });
  return { harness, ids };
}

const didOf = (harness: ReturnType<typeof createTestHarness>, id: string) =>
  (harness.getState({ scopeKind: "agent", scopeId: id, namespace: "moltrust", stateKey: "identity" }) as any)?.did;

describe("registering all agents of a company in one step", () => {
  it("on worker start registers every existing agent of the company (N=12), without any event", async () => {
    const clock = { t: NOW.getTime() };
    const mt = limitedMoltrust({ clock });
    const { harness, ids } = seedMany(12);
    await makePlugin({ fetch: mt.fetch, now: () => new Date(clock.t) }).definition.setup(harness.ctx);
    await vi.waitFor(() => expect(harness.activity.some((a) => a.message.includes("in one pass"))).toBe(true));
    expect(mt.pops).toHaveLength(12);
    for (const id of ids) expect(didOf(harness, id)).toMatch(/^did:moltrust:/);
    const summary = harness.activity.find((a) => a.message.includes("in one pass"))!;
    expect(summary.message).toBe("MolTrust: 12 agent(s) registered in one pass, 0 already had a DID");
  });

  it("is idempotent: a second pass and a worker restart make no registration call", async () => {
    const clock = { t: NOW.getTime() };
    const mt = limitedMoltrust({ clock });
    const { harness } = seedMany(8);
    const m = createMoltrust(harness.ctx, { fetch: mt.fetch, now: () => new Date(clock.t) });
    const first = await m.registerCompany(COMPANY);
    expect(first).toMatchObject({ agents: 8, registered: 8, known: 0, deferred: 0, rateLimited: false });
    const again = await m.registerCompany(COMPANY);
    expect(again).toMatchObject({ registered: 0, known: 8, deferred: 0 });
    const restarted = createMoltrust(harness.ctx, { fetch: mt.fetch, now: () => new Date(clock.t) });
    await restarted.sweep();
    expect(mt.pops).toHaveLength(8);
    expect(mt.challengeCount()).toBe(8);
  });

  it("skips terminated agents and hires pending approval, and does nothing for a switched-off company", async () => {
    const clock = { t: NOW.getTime() };
    const mt = limitedMoltrust({ clock });
    const { harness } = seedMany(6, { status: (i) => (i === 0 ? "terminated" : i === 1 ? "pending_approval" : "idle") });
    const m = createMoltrust(harness.ctx, { fetch: mt.fetch, now: () => new Date(clock.t) });
    expect(await m.registerCompany(COMPANY)).toMatchObject({ agents: 6, registered: 4, ineligible: 2 });

    const off = createTestHarness({ manifest, config: { enabled: false } });
    off.seed({ companies: [{ id: COMPANY, name: "Off Co" } as any], agents: [{ id: "x1", companyId: COMPANY, name: "A", status: "idle" } as any] });
    const mOff = createMoltrust(off.ctx, { fetch: mt.fetch, now: () => new Date(clock.t) });
    expect(await mOff.registerCompany(COMPANY)).toMatchObject({ agents: 0, registered: 0 });
    expect(mt.pops).toHaveLength(4);
  });

  it("N=40 against the 30/hour limit: stops at the first 429, backs off without calls, finishes later", async () => {
    const clock = { t: Date.parse("2026-11-06T12:00:00Z") };
    const mt = limitedMoltrust({ clock });
    const { harness, ids } = seedMany(40);
    const m = createMoltrust(harness.ctx, { fetch: mt.fetch, now: () => new Date(clock.t) });

    const first = await m.registerCompany(COMPANY);
    expect(first).toMatchObject({ agents: 40, registered: 30, deferred: 10, rateLimited: true });
    expect(mt.refusedCount()).toBe(1); // one 429, not one per remaining agent
    expect(harness.activity.at(-1)!.message).toBe(
      "MolTrust: 30 agent(s) registered in one pass, 0 already had a DID, 10 left for the reconcile job (MolTrust rate limit)",
    );

    // Inside the backoff: the reconcile tick makes no MolTrust call at all.
    clock.t += BACKOFF_BASE_MS / 2;
    const calls = mt.challengeCount();
    expect(await m.sweep()).toMatchObject({ registered: 0, deferred: 10, rateLimited: true });
    expect(mt.challengeCount()).toBe(calls);

    // Backoff over, still the same server window: one more 429, the pause doubles.
    clock.t += BACKOFF_BASE_MS;
    await m.sweep();
    expect(mt.refusedCount()).toBe(2);
    clock.t += BACKOFF_BASE_MS * 1.5;
    expect(m.backoffActive()).toBe(true);

    // Next server window: the rest goes through in one pass.
    clock.t = Date.parse("2026-11-06T13:00:00Z");
    expect(await m.sweep()).toMatchObject({ registered: 10, deferred: 0, rateLimited: false });
    for (const id of ids) expect(didOf(harness, id)).toMatch(/^did:moltrust:/);
    expect(mt.pops).toHaveLength(40);
  });

  it("honours a Retry-After longer than the backoff", async () => {
    const clock = { t: Date.parse("2026-11-06T12:00:00Z") };
    const mt = limitedMoltrust({ clock, perWindow: 2, windowMs: 60_000, retryAfter: "600" });
    const { harness } = seedMany(4);
    const m = createMoltrust(harness.ctx, { fetch: mt.fetch, now: () => new Date(clock.t) });
    expect(await m.registerCompany(COMPANY)).toMatchObject({ registered: 2, deferred: 2, rateLimited: true });
    clock.t += 5 * 60_000;
    expect(await m.registerCompany(COMPANY)).toMatchObject({ registered: 0, deferred: 2 });
    expect(mt.refusedCount()).toBe(1);
    clock.t += 6 * 60_000;
    expect(await m.registerCompany(COMPANY)).toMatchObject({ registered: 2, deferred: 0 });
  });

  it("pages through more than 500 agents", async () => {
    const clock = { t: NOW.getTime() };
    const mt = limitedMoltrust({ clock, perWindow: 1000 });
    const { harness } = seedMany(501);
    const m = createMoltrust(harness.ctx, { fetch: mt.fetch, now: () => new Date(clock.t) });
    expect(await m.registerCompany(COMPANY)).toMatchObject({ agents: 501, registered: 501 });
  });

  it("a hire event during the pass does not register the same agent twice", async () => {
    const clock = { t: NOW.getTime() };
    const mt = limitedMoltrust({ clock });
    const { harness, ids } = seedMany(10);
    const m = createMoltrust(harness.ctx, { fetch: mt.fetch, now: () => new Date(clock.t) });
    await Promise.all([m.registerCompany(COMPANY), ...ids.map((id) => m.ensureAgent(COMPANY, id))]);
    expect(mt.pops).toHaveLength(10);
  });
});

describe("company budget as mandate", () => {
  it("company.created stores a mandate bound to the budget and the lifetime", async () => {
    const { harness } = await setup();
    await harness.emit("company.created", { name: "Example Co" }, { companyId: COMPANY, entityId: COMPANY, entityType: "company" });
    const s = harness.getState({ scopeKind: "company", scopeId: COMPANY, namespace: "moltrust", stateKey: "mandate" }) as any;
    expect(s.budgetCents).toBe(50000);
    expect(s.mandate.grants).toHaveLength(4);
    const now = Math.floor(NOW.getTime() / 1000);
    expect(s.mandate.validity).toEqual({ not_before: now, not_after: now + 31 * 86400 });
  });
});

describe("check_spend", () => {
  it("permits within the budget and denies over it", async () => {
    const { harness, mt } = await setup();
    const ok = await harness.executeTool<any>("check_spend", { action: "ad_spend", amountCents: 20000 }, run(AGENTS[2]!));
    expect(ok.data.verdict).toBe("PERMIT");
    const over = await harness.executeTool<any>("check_spend", { action: "purchase", amountCents: 60000 }, run(AGENTS[0]!));
    expect(over.data.verdict).toBe("DENY");
    expect(over.error).toMatch(/^DENY/);
    expect(mt.checks.every((c) => typeof c.did === "string")).toBe(true);
  });

  it("counts permitted spend, so the running total is capped", async () => {
    const { harness } = await setup();
    const a = await harness.executeTool<any>("check_spend", { action: "purchase", amountCents: 30000 }, run(AGENTS[0]!));
    const b = await harness.executeTool<any>("check_spend", { action: "purchase", amountCents: 30000 }, run(AGENTS[1]!));
    expect(a.data.verdict).toBe("PERMIT");
    expect(b.data.verdict).toBe("DENY");
    expect(b.data.transaction.spent_after_cents).toBe(60000);
  });

  it("denies an action the mandate does not grant", async () => {
    const { harness } = await setup();
    const r = await harness.executeTool<any>("check_spend", { action: "crypto_swap", amountCents: 1 }, run(AGENTS[0]!));
    expect(r.data.verdict).toBe("DENY");
  });

  it("denies bad input without calling the server", async () => {
    const { harness, mt } = await setup();
    const r = await harness.executeTool<any>("check_spend", { action: "purchase", amountCents: 1.5 }, run(AGENTS[0]!));
    expect(r.error).toMatch(/^DENY/);
    expect(mt.checks).toHaveLength(0);
  });

  it("writes every verdict to the activity log", async () => {
    const { harness } = await setup();
    await harness.executeTool("check_spend", { action: "purchase", amountCents: 60000 }, run(AGENTS[0]!));
    expect(harness.activity.some((a) => a.message.startsWith("MolTrust: DENY purchase 60000"))).toBe(true);
  });
});

describe("settings", () => {
  it("defaults to production API and platform paperclip", () => {
    const s = settingsFrom({});
    expect(s).toMatchObject({ enabled: true, apiUrl: "https://api.moltrust.ch", platform: "paperclip", currency: "USD", mandateDays: 31 });
  });
});
