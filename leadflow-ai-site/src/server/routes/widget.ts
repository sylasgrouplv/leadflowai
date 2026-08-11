/**
 * Public website-widget API (spec §14).
 *
 * These endpoints are intentionally UNAUTHENTICATED — the widget runs on
 * arbitrary customer websites — so security is enforced differently:
 *   - CORS is wide open (the widget is embedded on any domain) but the
 *     endpoints never read cookies and return only widget-scoped data.
 *   - Every request must name the businessId explicitly; every lookup is
 *     tenant-filtered by that id (repo functions all take businessId), so a
 *     request can never touch another business's rows.
 *   - The business must exist and its widget must be enabled.
 *   - Rate-limited per IP (guards.ts rateLimit).
 *   - Inputs are zod-validated (message length capped, businessId must be a
 *     uuid, conversationId optional uuid).
 *   - Only the business's own KB drives replies (engine.handleLeadMessage →
 *     buildAiRequest reads that business's services/knowledge/policies).
 *   - Every engine mutation logs agent_actions rows as usual (safety rule 9).
 *
 * Routes:
 *   GET  /api/widget/config?businessId=…   public config (branding + welcome)
 *   GET  /api/widget/demo-business         public: Smith's HVAC id for /widget-demo
 *   POST /api/widget/chat                  send a message (auto-creates lead +
 *                                          conversation on first message)
 *   GET  /api/widget/settings              auth: owner reads widget settings
 *   PUT  /api/widget/settings              auth: owner saves widget settings
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import * as repo from "../db/repo";
import { attachUser, HttpError, rateLimit, requireOwnerBusiness } from "../auth/guards";
import { handleLeadMessage, startConversation } from "../ai/engine";

const DEFAULT_WELCOME =
  "Hi! Thanks for reaching out — I'm the AI receptionist. How can we help today? Tell me what you need and a little about your situation.";

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const businessIdSchema = z.string().uuid();
const conversationIdSchema = z.string().uuid().optional();
const messageSchema = z.object({
  businessId: z.string().uuid(),
  conversationId: z.string().uuid().optional(),
  message: z.string().trim().min(1, "Message cannot be empty").max(2000),
});

/** Load a business + widget settings; 404/disabled errors as HttpError. */
async function resolveWidgetBusiness(businessId: string) {
  const business = await repo.getBusinessById(businessId);
  if (!business) throw new HttpError(404, "Business not found");
  const settings = await repo.getWidgetSettings(businessId);
  if (!settings.enabled) throw new HttpError(403, "This business's chat widget is disabled.");
  return { business, settings };
}

function widgetPublicConfig(business: NonNullable<Awaited<ReturnType<typeof repo.getBusinessById>>>, settings: repo.WidgetSettings) {
  // welcomeMessage: widget setting wins, else the business's policies
  // welcomeMessage, else a sensible default.
  let welcome = settings.welcomeMessage;
  if (!welcome) {
    try {
      const policies = JSON.parse(business.policiesJson || "{}");
      if (policies.welcomeMessage) welcome = policies.welcomeMessage;
    } catch {
      /* keep default */
    }
  }
  if (!welcome) welcome = DEFAULT_WELCOME;
  return {
    businessId: business.id,
    businessName: business.name,
    enabled: true,
    primaryColor: settings.primaryColor,
    position: settings.position,
    welcomeMessage: welcome,
    logoUrl: settings.logoUrl,
    website: business.website ?? "",
    phone: business.phone ?? "",
  };
}

export const widgetRoutes = new Hono();

// The widget runs on arbitrary customer domains — CORS must allow any origin.
// No credentials are ever sent with these requests, so `origin: "*"` is safe.
widgetRoutes.use("*", cors({ origin: "*", allowMethods: ["GET", "POST", "PUT", "OPTIONS"], allowHeaders: ["Content-Type"], maxAge: 86400 }));

/** Public widget config (branding + welcome). Never returns lead data. */
widgetRoutes.get("/config", rateLimit(120, 60_000), async (c) => {
  const raw = c.req.query("businessId") ?? "";
  const parsed = businessIdSchema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, "businessId (uuid) is required");
  const { business, settings } = await resolveWidgetBusiness(parsed.data);
  return c.json(widgetPublicConfig(business, settings));
});

/** Public: the demo business (Smith's HVAC) for the /widget-demo page. */
widgetRoutes.get("/demo-business", rateLimit(120, 60_000), async (c) => {
  const demo = await repo.getUserByEmail("demo@leadflow.ai");
  if (!demo) throw new HttpError(404, "Demo business not found");
  const business = await repo.getBusinessForUser(demo.id);
  if (!business) throw new HttpError(404, "Demo business not found");
  return c.json({ businessId: business.id, businessName: business.name });
});

/**
 * Public chat endpoint used by the embeddable widget.
 *
 * First message (no conversationId): auto-creates a lead (source
 * "website_widget") + conversation with the business's welcome message, then
 * the message flows through the same engine as the conversation center
 * (persist → qualify → score → KB-grounded AI reply → booking/escalation/opt-out).
 * Returns only the data the widget needs.
 */
widgetRoutes.post("/chat", rateLimit(30, 60_000), async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = messageSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid request");
  const { businessId, message } = parsed.data;
  await resolveWidgetBusiness(businessId);

  let conversationId: string | null = parsed.data.conversationId ?? null;
  if (conversationId) {
    // Tenant-scoped lookup: a conversation from another business 404s here.
    const existing = await repo.getConversationById(businessId, conversationId);
    if (!existing) throw new HttpError(404, "Conversation not found");
    if (existing.status === "closed") {
      // A closed conversation can't be resumed; open a fresh one for the lead.
      const leadId = existing.leadId;
      const bundle = await startConversation(businessId, { leadId: leadId ?? undefined, source: "website_widget" });
      conversationId = bundle.conversation.id;
    }
  } else {
    // First message: create the lead (source website_widget) and open a
    // conversation. The engine persists the business's welcome message too,
    // so the owner sees the full thread in the inbox.
    const lead = await repo.createLead({
      businessId,
      firstName: "Website",
      lastName: "Visitor",
      source: "website_widget",
      notes: "Created by the website chat widget",
    });
    const bundle = await startConversation(businessId, { leadId: lead.id, source: "website_widget" });
    conversationId = bundle.conversation.id;
  }

  const bundle = await handleLeadMessage(businessId, conversationId, message);

  return c.json({
    conversationId: bundle.conversation.id,
    lead: bundle.lead
      ? {
          id: bundle.lead.id,
          firstName: bundle.lead.firstName,
          lastName: bundle.lead.lastName,
          score: bundle.lead.score,
          status: bundle.lead.status,
        }
      : null,
    messages: bundle.messages.map((m) => ({ sender: m.sender, body: m.body, createdAt: m.createdAt })),
    aiActive: bundle.conversation.aiEnabled === 1,
  });
});

// ---------------------------------------------------------------------------
// Owner-facing settings (authenticated)
// ---------------------------------------------------------------------------

const settingsSchema = z.object({
  enabled: z.boolean().optional(),
  primaryColor: z.string().regex(HEX_COLOR, "Primary color must be a hex value like #4f46e5").optional(),
  position: z.enum(["bottom-left", "bottom-right"]).optional(),
  welcomeMessage: z.string().max(500).optional(),
  logoUrl: z.string().max(500).optional(),
});

widgetRoutes.get("/settings", attachUser, async (c) => {
  const { business } = await requireOwnerBusiness(c);
  const settings = await repo.getWidgetSettings(business.id);
  const policies = safeJson<{ welcomeMessage?: string }>(business.policiesJson, {});
  return c.json({
    settings: { ...settings, welcomeFallback: policies.welcomeMessage ?? "" },
    businessName: business.name,
  });
});

widgetRoutes.put("/settings", attachUser, async (c) => {
  const { business } = await requireOwnerBusiness(c);
  const body = await c.req.json().catch(() => null);
  const parsed = settingsSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid settings");
  const patch: Parameters<typeof repo.saveWidgetSettings>[1] = {};
  if (parsed.data.enabled !== undefined) patch.enabled = parsed.data.enabled ? 1 : 0;
  if (parsed.data.primaryColor !== undefined) patch.primaryColor = parsed.data.primaryColor;
  if (parsed.data.position !== undefined) patch.position = parsed.data.position;
  if (parsed.data.welcomeMessage !== undefined) patch.welcomeMessage = parsed.data.welcomeMessage;
  if (parsed.data.logoUrl !== undefined) patch.logoUrl = parsed.data.logoUrl;
  const settings = await repo.saveWidgetSettings(business.id, patch);
  await repo.audit(business.id, null, "widget.settings_updated", "business", business.id, { patch: Object.keys(patch) });
  return c.json({ settings, businessName: business.name });
});

function safeJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
