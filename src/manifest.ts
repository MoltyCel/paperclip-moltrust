import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { CHECK_SPEND_TOOL_DECLARATION } from "./tool.js";

export const PLUGIN_ID = "paperclip-plugin-moltrust";
export const PLUGIN_VERSION = "0.1.0";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "MolTrust",
  description:
    "Gives every agent a W3C DID on hire, turns the company budget into an AAE mandate, and checks every spend against it before it runs.",
  author: "MolTrust (CryptoKRI GmbH)",
  categories: ["automation"],
  capabilities: [
    "companies.read",
    "agents.read",
    "events.subscribe",
    "jobs.schedule",
    "http.outbound",
    "plugin.state.read",
    "plugin.state.write",
    "activity.log.write",
    "agent.tools.register",
  ],
  entrypoints: { worker: "./dist/worker.js" },
  instanceConfigSchema: {
    type: "object",
    properties: {
      enabled: { type: "boolean", default: true, description: "Switch MolTrust off for this company" },
      apiUrl: { type: "string", default: "https://api.moltrust.ch" },
      platform: { type: "string", default: "paperclip", description: "Platform value sent with each registration" },
      currency: { type: "string", default: "USD" },
      allowedActions: {
        type: "array",
        items: { type: "string" },
        default: ["ad_spend", "purchase", "subscription", "transfer"],
      },
      mandateDays: { type: "integer", minimum: 1, default: 31 },
    },
  },
  jobs: [
    {
      jobKey: "reconcile",
      displayName: "MolTrust reconcile",
      description: "Registers agents that have no DID yet (hires approved later) and renews expired mandates.",
      schedule: "*/5 * * * *",
    },
  ],
  tools: [CHECK_SPEND_TOOL_DECLARATION],
};

export default manifest;
