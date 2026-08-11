/**
 * Lead routes — full lead management: search/filter/sort list, manual
 * creation ("create test lead"), detail, edits, status/score transitions,
 * notes, employee assignment, next follow-up.
 *
 * Role guards: owners see/act on everything; employees see only leads
 * assigned to them and may update status, add notes, and manage their own
 * conversations (spec: employee = assigned leads + status + notes + takeover).
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import * as repo from "../db/repo";
import { getDb } from "../db/client";
import * as s from "../db/schema";
import { attachUser, HttpError, requireUser, resolveBusiness } from "../auth/guards";
import type { LeadScore, LeadStatus } from "../db/schema";
import { startConversation } from "../ai/engine";
import { startSequence } from "../followups/engine";

const leadCreateSchema = z.object({
  firstName: z.string().trim().min(1, "First name is required").max(100),
  lastName: z.string().trim().max(100).optional().default(""),
  phone: z.string().trim().max(30).optional().default(""),
  email: z.string().email().max(254).optional().or(z.literal("")).optional().default(""),
  source: z.string().max(40).optional().default("manual"),
  serviceRequested: z.string().trim().max(120).optional().default(""),
  location: z.string().trim().max(120).optional().default(""),
  estimatedValueCents: z.number().int().min(0).max(100_000_000).optional().default(0),
  notes: z.string().max(4000).optional().default(""),
});

const leadUpdateSchema = z.object({
  firstName: z.string().trim().min(1).max(100).optional(),
  lastName: z.string().trim().max(100).optional(),
  phone: z.string().trim().max(30).optional(),
  email: z.string().email().max(254).optional().or(z.literal("")),
  serviceRequested: z.string().trim().max(120).optional(),
  location: z.string().trim().max(120).optional(),
  status: z.enum(s.LEAD_STATUSES as unknown as [LeadStatus, ...LeadStatus[]]).optional(),
  score: z.enum(s.LEAD_SCORES as unknown as [LeadScore, ...LeadScore[]]).optional(),
  estimatedValueCents: z.number().int().min(0).max(100_000_000).optional(),
  assignedTo: z.string().uuid().nullable().optional(),
  /** Appends a timestamped note to the lead's notes field. */
  note: z.string().trim().min(1).max(2000).optional(),
  /** Sets the next follow-up date (creates a pending follow-up row). */
  nextFollowUpAt: z.number().int().min(0).nullable().optional(),
  source: z.string().max(40).optional(),
  /** Opt the lead out of automated follow-ups (stop rule). */
  optedOut: z.boolean().optional(),
});

export const leadRoutes = new Hono();
leadRoutes.use("*", attachUser);

/** Resolve the business and check the user may access this lead. */
async function resolveLeadAccess(c: Context) {
  const business = await resolveBusiness(c);
  const user = await requireUser(c);
  const id = c.req.param("id") as string;
  const lead = await repo.getLeadById(business.id, id);
  if (!lead) throw new HttpError(404, "Lead not found");
  if (user.role === "employee" && lead.assignedTo !== user.id) {
    throw new HttpError(403, "You can only view and work leads assigned to you.");
  }
  return { business, user, lead };
}

leadRoutes.get("/", async (c) => {
  const business = await resolveBusiness(c);
  const user = await requireUser(c);
  const q = c.req.query("q") ?? "";
  const status = c.req.query("status") ?? "";
  const score = c.req.query("score") ?? "";
  const sort = c.req.query("sort") === "oldest" ? "oldest" : "newest";
  const rows = await repo.searchLeads(business.id, {
    q,
    status,
    score,
    sort,
    assignedTo: user.role === "employee" ? user.id : undefined,
  });
  const next = await repo.getNextFollowUps(business.id);
  const leads = rows.map((r) => ({
    ...r.lead,
    assignedName: r.assignedName ?? null,
    nextFollowUp: r.lead.id && next.has(r.lead.id) ? next.get(r.lead.id)! : null,
  }));
  return c.json({ leads });
});

leadRoutes.post("/", async (c) => {
  const business = await resolveBusiness(c);
  const user = await requireUser(c);
  if (user.role === "employee") throw new HttpError(403, "Only owners can create leads.");
  const body = await c.req.json().catch(() => null);
  const parsed = leadCreateSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid input");
  const lead = await repo.createLead({ businessId: business.id, ...parsed.data });
  await repo.audit(business.id, user.id, "lead.create", "lead", lead.id, { name: `${lead.firstName} ${lead.lastName}` });
  return c.json({ lead }, 201);
});

leadRoutes.get("/:id", async (c) => {
  const { business, lead } = await resolveLeadAccess(c);
  const [conversations, appointments] = await Promise.all([
    repo.listConversations(business.id, { leadIds: [lead.id] }),
    repo.listAppointmentsForLead(business.id, lead.id),
  ]);
  const next = await repo.getNextFollowUps(business.id);
  const team = await repo.listTeamMembers(business.id);
  return c.json({
    lead: { ...lead, nextFollowUp: next.get(lead.id) ?? null },
    conversations: conversations.map((r) => r.conversation),
    appointments,
    team,
  });
});

leadRoutes.patch("/:id", async (c) => {
  const { business, user, lead } = await resolveLeadAccess(c);
  const body = await c.req.json().catch(() => null);
  const parsed = leadUpdateSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid input");

  const isOwner = user.role === "owner" || user.role === "admin";
  const patch: Record<string, unknown> = {};

  // Employees: status + notes only (spec). Owners: everything.
  if (parsed.data.status !== undefined) patch.status = parsed.data.status;
  if (parsed.data.note !== undefined && isOwner) {
    const note = parsed.data.note as string;
    const stamp = new Date().toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    patch.notes = lead.notes ? `${lead.notes}\n\n${stamp} — ${user.name}: ${note}` : `${stamp} — ${user.name}: ${note}`;
  }
  if (isOwner) {
    if (parsed.data.firstName !== undefined) patch.firstName = parsed.data.firstName;
    if (parsed.data.lastName !== undefined) patch.lastName = parsed.data.lastName;
    if (parsed.data.phone !== undefined) patch.phone = parsed.data.phone;
    if (parsed.data.email !== undefined) patch.email = parsed.data.email;
    if (parsed.data.serviceRequested !== undefined) patch.serviceRequested = parsed.data.serviceRequested;
    if (parsed.data.location !== undefined) patch.location = parsed.data.location;
    if (parsed.data.score !== undefined) patch.score = parsed.data.score;
    if (parsed.data.estimatedValueCents !== undefined) patch.estimatedValueCents = parsed.data.estimatedValueCents;
    if (parsed.data.assignedTo !== undefined) patch.assignedTo = parsed.data.assignedTo;
    if (parsed.data.source !== undefined) patch.source = parsed.data.source;
    if (parsed.data.optedOut !== undefined) {
      patch.optedOut = parsed.data.optedOut ? 1 : 0;
      if (parsed.data.optedOut) {
        // Stop rule: opted-out leads get their pending follow-ups cancelled.
        getDb()
          .update(s.followUps)
          .set({ status: "cancelled", updatedAt: Date.now() })
          .where(and(eq(s.followUps.businessId, business.id), eq(s.followUps.leadId, lead.id), sql`${s.followUps.status} IN ('pending','paused')`))
          .run();
      }
    }
  }

  let updated: typeof lead | null = lead;
  if (Object.keys(patch).length) {
    updated = await repo.updateLead(business.id, lead.id, patch as never);
  }
  // Qualified = follow-up sequence trigger (spec §9); customer = stop rule.
  if (isOwner && parsed.data.status === "qualified" && updated) {
    await startSequence(business.id, updated.id);
  }
  if (isOwner && parsed.data.status === "customer" && updated) {
    getDb()
      .update(s.followUps)
      .set({ status: "cancelled", updatedAt: Date.now() })
      .where(and(eq(s.followUps.businessId, business.id), eq(s.followUps.leadId, lead.id), sql`${s.followUps.status} IN ('pending','paused')`))
      .run();
  }
  if (parsed.data.nextFollowUpAt !== undefined && isOwner) {
    if (parsed.data.nextFollowUpAt === null) {
      getDb()
        .delete(s.followUps)
        .where(and(eq(s.followUps.businessId, business.id), eq(s.followUps.leadId, lead.id), eq(s.followUps.status, "pending"), eq(s.followUps.templateKey, "manual")))
        .run();
    } else {
      await repo.setNextFollowUp(business.id, lead.id, parsed.data.nextFollowUpAt);
    }
  }
  await repo.audit(business.id, user.id, "lead.update", "lead", lead.id, patch);
  const next = await repo.getNextFollowUps(business.id);
  return c.json({ lead: { ...updated!, nextFollowUp: next.get(lead.id) ?? null } });
});

/** Open (or reuse) an AI chat for a lead — used from lead detail. */
leadRoutes.post("/:id/chat", async (c) => {
  const { business, lead } = await resolveLeadAccess(c);
  const bundle = await startConversation(business.id, { leadId: lead.id, source: lead.source || "website_chat" });
  return c.json(bundle, 201);
});
