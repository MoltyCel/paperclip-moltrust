import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import { makePlugin, settingsFrom } from "../src/worker.js";
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
  const plugin = makePlugin({ fetch: mt.fetch, now: () => NOW });
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
