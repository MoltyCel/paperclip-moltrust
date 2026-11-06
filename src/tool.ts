export const CHECK_SPEND_TOOL_DECLARATION = {
  name: "check_spend",
  displayName: "MolTrust: check spend",
  description:
    "Call before any action that spends company money (ads, purchases, subscriptions, transfers). Returns PERMIT or DENY against the company's budget mandate. Do not execute on DENY.",
  parametersSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: "Kind of spend, e.g. ad_spend, purchase, subscription, transfer" },
      amountCents: { type: "integer", minimum: 1, description: "Amount in cents" },
      counterparty: { type: "string", description: "Who receives the money (optional)" },
      description: { type: "string", description: "What the money is for (optional)" },
    },
    required: ["action", "amountCents"],
  },
};
