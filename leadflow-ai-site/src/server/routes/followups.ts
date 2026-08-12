/**
 * Follow-up routes.
 *
 *   GET    /api/follow-ups                  list (lead, step, due date, channel, status)
 *   GET    /api/follow-ups/config           sequence config (default 1/3/7/14 days)
 *   PUT    /api/follow-ups/config           save config (owner only)
 *   POST   /api/follow-ups                  create a manual one-off follow-up
 *   POST   /api/follow-ups/start            start the sequence for a lead
 *   POST   /api/follow-ups/stop-sequence    manual stop for a lead (stop rule)
 *   POST   /api/follow-ups/opt-out          lead opted out (stop rule)
 *   PATCH  /api/follow-ups/:id              reschedule (scheduledFor) | pause/resume (status)
 *   POST   /api/follow-ups/:id/stop         cancel a single row
 *   POST   /api/follow-ups/:id/done         mark done (sent) without sending
 *
 * Owners: everything. Employees: read-only list + stop/done/reschedule on rows
 * for leads assigned to them; config editing is owner-only.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import * as repo from "../db/repo";
import { attachUser, HttpError, requireUser, resolveBusiness, requireOwnerBusiness } from "../auth/guards";
import { optOutLead, startSequence, stopSequence } from "../followups/engine";

const createSchema = z.object({
  leadId: z.string().uuid(),
  type: z.enum(["sms", "email"]),
  scheduledFor: z.number().int().positive(),
});

const updateSchema = z.object({
  scheduledFor: z.number().int().positive().optional(),
  status: z.enum(["pending", "paused", "cancelled", "sent", "skipped"]).optional(),
});

const configSchema = z.object({
  steps: z
    .array(
      z.object({
        step: z.number().int().min(1).max(10),
        days: z.number().int().min(0).max(90),
        type: z.enum(["sms", "email"]),
        enabled: z.boolean(),
        templateKey: z.string().min(1).max(40),
      })
    )
    .min(1)
    .max(10),
});

export const followUpRoutes = new Hono();
followUpRoutes.use("*", attachUser);

function stepLabel(templateKey: string | null): { step: number | null; label: string } {
  const m = /^(?:seq_|sales_)(\d+)$/.exec(templateKey ?? "");
  if (m) return { step: Number(m[1]), label: `Step ${m[1]}` };
  if (templateKey === "manual") return { step: null, label: "Manual" };
  if (templateKey === "appointment_reminder") return { step: null, label: "Reminder" };
  return { step: null, label: "One-off" };
}

async function assertFollowUpAccess(c: Context, businessId: string, leadId: string | null) {
  const user = await requireUser(c);
  if (user.role !== "employee" || !leadId) return;
  const lead = await repo.getLeadById(businessId, leadId);
  if (!lead || lead.assignedTo !== user.id) {
    throw new HttpError(403, "You can only manage follow-ups for leads assigned to you.");
  }
}

followUpRoutes.get("/", async (c) => {
  const business = await resolveBusiness(c);
  const user = await requireUser(c);
  let rows = await repo.listFollowUpsWithLead(business.id);
  if (user.role === "employee") {
    rows = rows.filter((r) => r.lead?.assignedTo === user.id);
  }
  const config = await repo.getFollowUpConfig(business.id);
  return c.json({
    followUps: rows.map((r) => ({
      ...r.followUp,
      lead: r.lead,
      stepInfo: stepLabel(r.followUp.templateKey),
    })),
    config,
  });
});

followUpRoutes.get("/config", async (c) => {
  const business = await resolveBusiness(c);
  const config = await repo.getFollowUpConfig(business.id);
  return c.json({ config });
});

followUpRoutes.put("/config", async (c) => {
  const { business } = await requireOwnerBusiness(c);
  const body = await c.req.json().catch(() => null);
  const parsed = configSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid input");
  const steps = parsed.data.steps.map((s, i) => ({ ...s, step: i + 1, templateKey: s.templateKey || `seq_${i + 1}` }));
  await repo.saveFollowUpConfig(business.id, steps);
  return c.json({ config: steps });
});

followUpRoutes.post("/", async (c) => {
  const business = await resolveBusiness(c);
  const user = await requireUser(c);
  if (user.role === "employee") throw new HttpError(403, "Only owners can create manual follow-ups.");
  const body = await c.req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid input");
  const lead = await repo.getLeadById(business.id, parsed.data.leadId);
  if (!lead) throw new HttpError(404, "Lead not found");
  if (lead.optedOut === 1) throw new HttpError(400, "This lead opted out of follow-ups.");
  const id = await repo.createFollowUp(business.id, {
    leadId: lead.id,
    type: parsed.data.type,
    scheduledFor: parsed.data.scheduledFor,
    templateKey: "manual",
  });
  await repo.logAgentAction(business.id, {
    agent: "followup",
    action: "schedule_followup",
    leadId: lead.id,
    input: { manual: true, type: parsed.data.type, scheduledFor: parsed.data.scheduledFor },
    result: { followUpId: id },
    success: true,
  });
  return c.json({ followUpId: id }, 201);
});

followUpRoutes.post("/start", async (c) => {
  const business = await resolveBusiness(c);
  const body = await c.req.json().catch(() => null);
  const leadId = z.string().uuid().safeParse(body?.leadId);
  if (!leadId.success) throw new HttpError(400, "A valid leadId is required");
  await assertFollowUpAccess(c, business.id, leadId.data);
  const lead = await repo.getLeadById(business.id, leadId.data);
  if (!lead) throw new HttpError(404, "Lead not found");
  const res = await startSequence(business.id, lead.id);
  return c.json(res);
});

followUpRoutes.post("/stop-sequence", async (c) => {
  const business = await resolveBusiness(c);
  const body = await c.req.json().catch(() => null);
  const leadId = z.string().uuid().safeParse(body?.leadId);
  if (!leadId.success) throw new HttpError(400, "A valid leadId is required");
  await assertFollowUpAccess(c, business.id, leadId.data);
  const cancelled = await stopSequence(business.id, leadId.data);
  return c.json({ cancelled });
});

followUpRoutes.post("/opt-out", async (c) => {
  const business = await resolveBusiness(c);
  const body = await c.req.json().catch(() => null);
  const leadId = z.string().uuid().safeParse(body?.leadId);
  if (!leadId.success) throw new HttpError(400, "A valid leadId is required");
  await assertFollowUpAccess(c, business.id, leadId.data);
  await optOutLead(business.id, leadId.data, "all");
  return c.json({ ok: true });
});

followUpRoutes.patch("/:id", async (c) => {
  const business = await resolveBusiness(c);
  const followUp = await repo.getFollowUpById(business.id, c.req.param("id"));
  if (!followUp) throw new HttpError(404, "Follow-up not found");
  await assertFollowUpAccess(c, business.id, followUp.leadId);
  const body = await c.req.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid input");
  const patch: Record<string, unknown> = {};
  if (parsed.data.scheduledFor !== undefined) patch.scheduledFor = parsed.data.scheduledFor;
  if (parsed.data.status !== undefined) patch.status = parsed.data.status;
  const updated = await repo.updateFollowUp(business.id, followUp.id, patch as never);
  return c.json({ followUp: updated });
});

followUpRoutes.post("/:id/stop", async (c) => {
  const business = await resolveBusiness(c);
  const followUp = await repo.getFollowUpById(business.id, c.req.param("id"));
  if (!followUp) throw new HttpError(404, "Follow-up not found");
  await assertFollowUpAccess(c, business.id, followUp.leadId);
  const updated = await repo.updateFollowUp(business.id, followUp.id, { status: "cancelled" });
  await repo.logAgentAction(business.id, {
    agent: "followup",
    action: "stop_followup",
    leadId: followUp.leadId,
    input: { followUpId: followUp.id },
    result: { ok: true },
    success: true,
  });
  return c.json({ followUp: updated });
});

followUpRoutes.post("/:id/done", async (c) => {
  const business = await resolveBusiness(c);
  const followUp = await repo.getFollowUpById(business.id, c.req.param("id"));
  if (!followUp) throw new HttpError(404, "Follow-up not found");
  await assertFollowUpAccess(c, business.id, followUp.leadId);
  const updated = await repo.updateFollowUp(business.id, followUp.id, { status: "sent" });
  return c.json({ followUp: updated });
});
