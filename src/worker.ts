import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginContext, PluginEvent, ToolResult, ToolRunContext } from "@paperclipai/plugin-sdk";
import {
  DEFAULT_API_URL,
  DEFAULT_PLATFORM,
  buildMandate,
  checkSpend,
  registerAgent,
  type AgentIdentity,
  type CompanyMandate,
  type FetchLike,
} from "./moltrust.js";
import { CHECK_SPEND_TOOL_DECLARATION } from "./tool.js";

export const DEFAULT_ACTIONS = ["ad_spend", "purchase", "subscription", "transfer"];
export const DEFAULT_MANDATE_DAYS = 31;
const NS = "moltrust";

export interface Settings {
  enabled: boolean;
  apiUrl: string;
  platform: string;
  currency: string;
  allowedActions: string[];
  mandateDays: number;
}

export function settingsFrom(raw: Record<string, unknown> | null | undefined): Settings {
  const r = raw ?? {};
  const str = (k: string, d: string) => (typeof r[k] === "string" && (r[k] as string).trim() ? (r[k] as string).trim() : d);
  const actions = Array.isArray(r.allowedActions)
    ? (r.allowedActions as unknown[]).filter((x): x is string => typeof x === "string" && x.trim() !== "")
    : DEFAULT_ACTIONS;
  const days = typeof r.mandateDays === "number" && Number.isInteger(r.mandateDays) && r.mandateDays > 0 ? r.mandateDays : DEFAULT_MANDATE_DAYS;
  return {
    enabled: r.enabled !== false,
    apiUrl: str("apiUrl", DEFAULT_API_URL).replace(/\/+$/, ""),
    platform: str("platform", DEFAULT_PLATFORM).toLowerCase(),
    currency: str("currency", "USD").toUpperCase(),
    allowedActions: actions.length ? actions : DEFAULT_ACTIONS,
    mandateDays: days,
  };
}

interface StoredMandate {
  mandate: CompanyMandate;
  budgetCents: number;
  issuedAt: string;
}

interface Ledger {
  windowStart: number;
  permittedCents: number;
}

export interface Deps {
  fetch: FetchLike;
  now: () => Date;
}

const defaultDeps: Deps = {
  fetch: (url, init) => fetch(url, init),
  now: () => new Date(),
};

export function createMoltrust(ctx: PluginContext, deps: Deps = defaultDeps) {
  const pending = new Map<string, Promise<AgentIdentity | null>>();

  async function settings(companyId: string): Promise<Settings> {
    let raw: Record<string, unknown> = {};
    try {
      raw = (await ctx.config.get(companyId)) ?? {};
    } catch {
      raw = {};
    }
    return settingsFrom(raw);
  }

  async function identityOf(agentId: string): Promise<AgentIdentity | null> {
    const v = await ctx.state.get({ scopeKind: "agent", scopeId: agentId, namespace: NS, stateKey: "identity" });
    return v && typeof v === "object" && typeof (v as AgentIdentity).did === "string" ? (v as AgentIdentity) : null;
  }

  async function ensureAgent(companyId: string, agentId: string): Promise<AgentIdentity | null> {
    const key = `${companyId}/${agentId}`;
    const running = pending.get(key);
    if (running) return running;
    const p = (async (): Promise<AgentIdentity | null> => {
      const s = await settings(companyId);
      if (!s.enabled) return null;
      const known = await identityOf(agentId);
      if (known) return known;
      const agent = await ctx.agents.get(agentId, companyId);
      if (!agent || agent.status === "terminated" || agent.status === "pending_approval") return null;
      const identity = await registerAgent({ apiUrl: s.apiUrl, platform: s.platform, fetch: deps.fetch, now: deps.now });
      await ctx.state.set({ scopeKind: "agent", scopeId: agentId, namespace: NS, stateKey: "identity" }, identity);
      await ctx.activity.log({
        companyId,
        entityType: "agent",
        entityId: agentId,
        message: `MolTrust: registered ${identity.did} for agent ${agent.name}`,
        metadata: { did: identity.did, platform: identity.platform },
      });
      ctx.logger.info("moltrust: agent registered", { agentId, did: identity.did });
      return identity;
    })().catch((err: unknown) => {
      ctx.logger.warn("moltrust: registration failed, will retry on the next sweep", { agentId, error: String(err) });
      return null;
    });
    pending.set(key, p);
    try {
      return await p;
    } finally {
      pending.delete(key);
    }
  }

  async function ensureMandate(companyId: string, force = false): Promise<StoredMandate | null> {
    const s = await settings(companyId);
    if (!s.enabled) return null;
    const company = await ctx.companies.get(companyId);
    if (!company) return null;
    const ref = { scopeKind: "company" as const, scopeId: companyId, namespace: NS, stateKey: "mandate" };
    const stored = (await ctx.state.get(ref)) as StoredMandate | null;
    const nowSec = Math.floor(deps.now().getTime() / 1000);
    const budget = Math.max(0, Math.trunc(company.budgetMonthlyCents ?? 0));
    const fresh =
      stored &&
      !force &&
      stored.budgetCents === budget &&
      stored.mandate.validity.not_after > nowSec &&
      stored.mandate.budget.currency === s.currency &&
      sameActions(stored.mandate, s);
    if (fresh) return stored;
    const mandate = buildMandate({
      companyId,
      budgetCents: budget,
      currency: s.currency,
      allowedActions: s.allowedActions,
      validFrom: nowSec,
      validUntil: nowSec + s.mandateDays * 86400,
    });
    const next: StoredMandate = { mandate, budgetCents: budget, issuedAt: deps.now().toISOString() };
    await ctx.state.set(ref, next);
    await ctx.activity.log({
      companyId,
      entityType: "company",
      entityId: companyId,
      message: `MolTrust: company budget mandate set (${budget} cents ${s.currency}, ${s.mandateDays} days, actions ${mandate.grants.length})`,
      metadata: { budgetCents: budget, notAfter: mandate.validity.not_after, actions: s.allowedActions },
    });
    return next;
  }

  function sameActions(m: CompanyMandate, s: Settings): boolean {
    const want = buildMandate({
      companyId: m.subject.company_id,
      budgetCents: m.budget.amount_cents,
      currency: s.currency,
      allowedActions: s.allowedActions,
      validFrom: m.validity.not_before,
      validUntil: m.validity.not_after,
    });
    return JSON.stringify(want.grants.map((g) => g.action_binding)) === JSON.stringify(m.grants.map((g) => g.action_binding));
  }

  async function ledger(companyId: string, windowStart: number): Promise<Ledger> {
    const v = (await ctx.state.get({ scopeKind: "company", scopeId: companyId, namespace: NS, stateKey: "ledger" })) as Ledger | null;
    if (!v || v.windowStart !== windowStart) return { windowStart, permittedCents: 0 };
    return v;
  }

  async function checkSpendTool(params: unknown, run: ToolRunContext): Promise<ToolResult> {
    const p = (params ?? {}) as Record<string, unknown>;
    const action = typeof p.action === "string" ? p.action.trim() : "";
    const amount = p.amountCents;
    if (!action) return { error: "DENY: parameter 'action' is required" };
    if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0) {
      return { error: "DENY: parameter 'amountCents' must be a positive integer" };
    }
    const s = await settings(run.companyId);
    if (!s.enabled) {
      return { content: "MolTrust is switched off for this company; no check was made.", data: { verdict: "OFF" } };
    }
    const stored = await ensureMandate(run.companyId);
    if (!stored) return { error: "DENY: company not found, no mandate" };
    const identity = await ensureAgent(run.companyId, run.agentId);
    const company = await ctx.companies.get(run.companyId);
    const windowStart = stored.mandate.validity.not_before;
    const led = await ledger(run.companyId, windowStart);
    const spentBefore = Math.max(Math.trunc(company?.spentMonthlyCents ?? 0), 0) + led.permittedCents;
    const transaction = {
      action: { verb: action, currency: s.currency },
      amount_cents: amount,
      spent_after_cents: spentBefore + amount,
      requested_at: Math.floor(deps.now().getTime() / 1000),
      ...(typeof p.counterparty === "string" && p.counterparty ? { counterparty: p.counterparty } : {}),
    };
    const verdict = await checkSpend({
      apiUrl: s.apiUrl,
      did: identity?.did ?? null,
      mandate: stored.mandate,
      transaction,
      fetch: deps.fetch,
    });
    if (verdict.verdict === "PERMIT") {
      await ctx.state.set(
        { scopeKind: "company", scopeId: run.companyId, namespace: NS, stateKey: "ledger" },
        { windowStart, permittedCents: led.permittedCents + amount },
      );
    }
    await ctx.activity.log({
      companyId: run.companyId,
      entityType: "agent",
      entityId: run.agentId,
      message: `MolTrust: ${verdict.verdict} ${action} ${amount} cents ${s.currency} (${verdict.reason})`,
      metadata: {
        verdict: verdict.verdict,
        reason: verdict.reason,
        coreDigest: verdict.coreDigest,
        did: identity?.did ?? null,
        transaction,
      },
    });
    const data = { verdict: verdict.verdict, reason: verdict.reason, coreDigest: verdict.coreDigest, transaction };
    if (verdict.verdict === "PERMIT") {
      return { content: `PERMIT: ${action} of ${amount} cents may go ahead. Record ${verdict.coreDigest}.`, data };
    }
    return { error: `${verdict.verdict}: do not execute ${action} of ${amount} cents. ${verdict.reason}`, data };
  }

  async function sweep(): Promise<{ companies: number; agents: number }> {
    let agents = 0;
    const companies = await ctx.companies.list({ limit: 500 });
    for (const c of companies) {
      const s = await settings(c.id);
      if (!s.enabled) continue;
      await ensureMandate(c.id);
      const list = await ctx.agents.list({ companyId: c.id, limit: 500 });
      for (const a of list) {
        if (await ensureAgent(c.id, a.id)) agents++;
      }
    }
    return { companies: companies.length, agents };
  }

  return { ensureAgent, ensureMandate, checkSpendTool, sweep, identityOf, settings };
}

export function makePlugin(deps: Deps = defaultDeps) {
  return definePlugin({
    async setup(ctx) {
      const mt = createMoltrust(ctx, deps);
      ctx.events.on("company.created", async (e: PluginEvent) => {
        await mt.ensureMandate(e.entityId ?? e.companyId);
      });
      ctx.events.on("company.updated", async (e: PluginEvent) => {
        await mt.ensureMandate(e.entityId ?? e.companyId);
      });
      ctx.events.on("agent.created", async (e: PluginEvent) => {
        if (e.entityId) await mt.ensureAgent(e.companyId, e.entityId);
      });
      ctx.events.on("approval.decided", async (e: PluginEvent) => {
        const payload = (e.payload ?? {}) as Record<string, unknown>;
        const agentId = typeof payload.agentId === "string" ? payload.agentId : null;
        if (agentId) await mt.ensureAgent(e.companyId, agentId);
      });
      ctx.jobs.register("reconcile", async () => {
        const r = await mt.sweep();
        ctx.logger.info("moltrust: reconcile sweep", r);
      });
      ctx.tools.register(CHECK_SPEND_TOOL_DECLARATION.name, CHECK_SPEND_TOOL_DECLARATION, (params, run) => mt.checkSpendTool(params, run));
      ctx.logger.info("moltrust plugin ready");
    },
    async onHealth() {
      return { status: "ok", message: "MolTrust plugin ready" };
    },
  });
}

const plugin = makePlugin();
export default plugin;

if (!process.env.VITEST) runWorker(plugin, import.meta.url);
