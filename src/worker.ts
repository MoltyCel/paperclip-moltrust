import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginContext, PluginEvent, ToolResult, ToolRunContext } from "@paperclipai/plugin-sdk";
import {
  DEFAULT_API_URL,
  DEFAULT_PLATFORM,
  buildMandate,
  checkSpend,
  registerAgent,
  RateLimitedError,
  type AgentIdentity,
  type CompanyMandate,
  type FetchLike,
} from "./moltrust.js";
import { CHECK_SPEND_TOOL_DECLARATION } from "./tool.js";

export const DEFAULT_ACTIONS = ["ad_spend", "purchase", "subscription", "transfer"];
export const DEFAULT_MANDATE_DAYS = 31;
/** First pause after a 429, doubled on each further 429 in a row, capped. */
export const BACKOFF_BASE_MS = 60_000;
export const BACKOFF_MAX_MS = 60 * 60_000;
const PAGE = 500;
const NS = "moltrust";

/** Result of registering every agent of one company in one pass. */
export interface CompanyRegistration {
  companyId: string;
  /** Agents seen (all statuses). */
  agents: number;
  /** DIDs registered in this pass. */
  registered: number;
  /** Agents that already had a DID. */
  known: number;
  /** Agents not eligible yet: terminated or pending approval. */
  ineligible: number;
  /** Agents left for a later pass: rate limit or a failed call. */
  deferred: number;
  /** True when the pass stopped early on a 429. */
  rateLimited: boolean;
}

export interface SweepResult {
  companies: number;
  agents: number;
  registered: number;
  deferred: number;
  rateLimited: boolean;
}

type AgentOutcome =
  | { kind: "registered" | "known"; identity: AgentIdentity }
  | { kind: "off" | "ineligible" | "failed" | "rate_limited" };

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
  /** Run one sweep over all companies when the worker starts. Default true. */
  startupSweep?: boolean;
}

const defaultDeps: Deps = {
  fetch: (url, init) => fetch(url, init),
  now: () => new Date(),
  startupSweep: true,
};

export function createMoltrust(ctx: PluginContext, deps: Deps = defaultDeps) {
  const pending = new Map<string, Promise<AgentOutcome>>();

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

  // Rate-limit backoff, worker-wide: the MolTrust limit is per source IP, so
  // every company on this instance draws from the same budget.
  let blockedUntil = 0;
  let strikes = 0;

  function backoffActive(): boolean {
    return deps.now().getTime() < blockedUntil;
  }

  function noteRateLimit(err: RateLimitedError) {
    strikes++;
    const exp = Math.min(BACKOFF_BASE_MS * 2 ** (strikes - 1), BACKOFF_MAX_MS);
    const wait = Math.max(exp, Math.min(err.retryAfterMs ?? 0, BACKOFF_MAX_MS));
    blockedUntil = deps.now().getTime() + wait;
    ctx.logger.warn("moltrust: registration rate limited, pausing registrations", {
      route: err.route,
      pauseMs: wait,
      until: new Date(blockedUntil).toISOString(),
    });
  }

  async function registerOne(companyId: string, agentId: string): Promise<AgentOutcome> {
    const key = `${companyId}/${agentId}`;
    const running = pending.get(key);
    if (running) return running;
    const p = (async (): Promise<AgentOutcome> => {
      const s = await settings(companyId);
      if (!s.enabled) return { kind: "off" };
      const known = await identityOf(agentId);
      if (known) return { kind: "known", identity: known };
      const agent = await ctx.agents.get(agentId, companyId);
      if (!agent || agent.status === "terminated" || agent.status === "pending_approval") return { kind: "ineligible" };
      if (backoffActive()) return { kind: "rate_limited" };
      const identity = await registerAgent({ apiUrl: s.apiUrl, platform: s.platform, fetch: deps.fetch, now: deps.now });
      strikes = 0;
      await ctx.state.set({ scopeKind: "agent", scopeId: agentId, namespace: NS, stateKey: "identity" }, identity);
      await ctx.activity.log({
        companyId,
        entityType: "agent",
        entityId: agentId,
        message: `MolTrust: registered ${identity.did} for agent ${agent.name}`,
        metadata: { did: identity.did, platform: identity.platform },
      });
      ctx.logger.info("moltrust: agent registered", { agentId, did: identity.did });
      return { kind: "registered", identity };
    })().catch((err: unknown): AgentOutcome => {
      if (err instanceof RateLimitedError) {
        noteRateLimit(err);
        return { kind: "rate_limited" };
      }
      ctx.logger.warn("moltrust: registration failed, will retry on the next sweep", { agentId, error: String(err) });
      return { kind: "failed" };
    });
    pending.set(key, p);
    try {
      return await p;
    } finally {
      pending.delete(key);
    }
  }

  async function ensureAgent(companyId: string, agentId: string): Promise<AgentIdentity | null> {
    const r = await registerOne(companyId, agentId);
    return r.kind === "registered" || r.kind === "known" ? r.identity : null;
  }

  async function listAll<T>(page: (offset: number) => Promise<T[]>): Promise<T[]> {
    const out: T[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const batch = await page(offset);
      out.push(...batch);
      if (batch.length < PAGE) return out;
    }
  }

  /**
   * Register every agent of one company in one pass: all agents without a DID,
   * one after the other, idempotent (agents with a stored DID cost no call).
   * Stops at the first 429 and leaves the rest to a later pass; while the
   * backoff runs, no registration call is made at all.
   */
  async function registerCompany(companyId: string): Promise<CompanyRegistration> {
    const r: CompanyRegistration = { companyId, agents: 0, registered: 0, known: 0, ineligible: 0, deferred: 0, rateLimited: false };
    const s = await settings(companyId);
    if (!s.enabled) return r;
    await ensureMandate(companyId);
    const agents = await listAll((offset) => ctx.agents.list({ companyId, limit: PAGE, offset }));
    r.agents = agents.length;
    for (const a of agents) {
      if (r.rateLimited) {
        // Agents with a DID still count as known; the rest wait for the next pass.
        if (await identityOf(a.id)) r.known++;
        else if (a.status === "terminated" || a.status === "pending_approval") r.ineligible++;
        else r.deferred++;
        continue;
      }
      const o = await registerOne(companyId, a.id);
      if (o.kind === "registered") r.registered++;
      else if (o.kind === "known") r.known++;
      else if (o.kind === "ineligible" || o.kind === "off") r.ineligible++;
      else if (o.kind === "rate_limited") {
        r.deferred++;
        r.rateLimited = true;
      } else r.deferred++;
    }
    if (r.registered > 0 || r.deferred > 0) {
      await ctx.activity.log({
        companyId,
        entityType: "company",
        entityId: companyId,
        message:
          `MolTrust: ${r.registered} agent(s) registered in one pass, ${r.known} already had a DID` +
          (r.deferred ? `, ${r.deferred} left for the reconcile job${r.rateLimited ? " (MolTrust rate limit)" : ""}` : ""),
        metadata: { ...r },
      });
    }
    return r;
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

  let sweeping: Promise<SweepResult> | null = null;

  /** registerCompany for every company on the instance; one sweep at a time. */
  function sweep(): Promise<SweepResult> {
    if (sweeping) return sweeping;
    sweeping = (async (): Promise<SweepResult> => {
      const out: SweepResult = { companies: 0, agents: 0, registered: 0, deferred: 0, rateLimited: false };
      const companies = await listAll((offset) => ctx.companies.list({ limit: PAGE, offset }));
      out.companies = companies.length;
      for (const c of companies) {
        const r = await registerCompany(c.id);
        out.agents += r.registered + r.known;
        out.registered += r.registered;
        out.deferred += r.deferred;
        out.rateLimited ||= r.rateLimited;
      }
      return out;
    })().finally(() => {
      sweeping = null;
    });
    return sweeping;
  }

  return { ensureAgent, ensureMandate, registerCompany, checkSpendTool, sweep, identityOf, settings, backoffActive };
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
        ctx.logger.info("moltrust: reconcile sweep", { ...r });
      });
      ctx.tools.register(CHECK_SPEND_TOOL_DECLARATION.name, CHECK_SPEND_TOOL_DECLARATION, (params, run) => mt.checkSpendTool(params, run));
      ctx.logger.info("moltrust plugin ready");
      // One pass over every company right away, so agents that existed before
      // the install are registered in one step instead of waiting for the
      // first reconcile tick. The host restarts the worker on a config change
      // (no onConfigChanged here), so switching a company on runs this too.
      if (deps.startupSweep !== false) void mt.sweep().then(
        (r) => ctx.logger.info("moltrust: startup sweep", { ...r }),
        (err: unknown) => ctx.logger.warn("moltrust: startup sweep failed, the reconcile job retries", { error: String(err) }),
      );
    },
    async onHealth() {
      return { status: "ok", message: "MolTrust plugin ready" };
    },
  });
}

const plugin = makePlugin();
export default plugin;

if (!process.env.VITEST) runWorker(plugin, import.meta.url);
