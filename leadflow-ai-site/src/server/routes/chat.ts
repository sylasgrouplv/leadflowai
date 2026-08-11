/**
 * Chat routes — the Conversation Center API.
 *
 *   GET    /api/chat/conversations          inbox (lead + last message + priority)
 *   POST   /api/chat/conversations          open a conversation for a lead (or create one)
 *   POST   /api/chat/test                   one-click "Test your AI receptionist" chat
 *   GET    /api/chat/conversations/:id      full bundle (thread, lead, appointments)
 *   POST   /api/chat/conversations/:id/messages     lead message -> AI responds
 *   POST   /api/chat/conversations/:id/reply        human reply
 *   POST   /api/chat/conversations/:id/takeover     human takes over
 *   POST   /api/chat/conversations/:id/return-to-ai AI resumes
 *   POST   /api/chat/conversations/:id/qualified    mark lead qualified (+score)
 *   POST   /api/chat/conversations/:id/close        close lead (lost/unqualified/customer)
 *
 * Role guards: owners see every conversation; employees only conversations
 * whose lead is assigned to them.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import * as repo from "../db/repo";
import { attachUser, HttpError, requireUser, resolveBusiness } from "../auth/guards";
import {
  closeLead,
  getBundle,
  handleLeadMessage,
  humanReply,
  markQualified,
  returnToAi,
  startConversation,
  takeOver,
} from "../ai/engine";

const messageSchema = z.object({
  body: z.string().trim().min(1, "Message cannot be empty").max(4000),
});
const scoreSchema = z.object({
  score: z.enum(["hot", "warm", "cold"]).default("warm"),
});
const closeSchema = z.object({
  outcome: z.enum(["lost", "unqualified", "customer"]),
});

export const chatRoutes = new Hono();
chatRoutes.use("*", attachUser);

/** Resolve the conversation and enforce the role's access scope. */
async function resolveConversationAccess(c: Context) {
  const business = await resolveBusiness(c);
  const user = await requireUser(c);
  const id = c.req.param("id") as string;
  const conversation = await repo.getConversationById(business.id, id);
  if (!conversation) throw new HttpError(404, "Conversation not found");
  if (user.role === "employee") {
    if (!conversation.leadId) throw new HttpError(403, "You can only access conversations for assigned leads.");
    const lead = await repo.getLeadById(business.id, conversation.leadId);
    if (!lead || lead.assignedTo !== user.id) {
      throw new HttpError(403, "You can only access conversations for leads assigned to you.");
    }
  }
  return { business, user, conversation };
}

chatRoutes.get("/conversations", async (c) => {
  const business = await resolveBusiness(c);
  const user = await requireUser(c);
  const statusFilter = c.req.query("status") ?? "";
  let statuses: string[] | undefined;
  if (statusFilter && statusFilter !== "all") statuses = [statusFilter];

  let items = await repo.listConversations(business.id, { statuses });
  if (user.role === "employee") {
    const mine: typeof items = [];
    for (const item of items) {
      if (item.lead && item.lead.assignedTo === user.id) mine.push(item);
    }
    items = mine;
  }
  const conversations = items.map((r) => ({
    ...r.conversation,
    lead: r.lead,
    lastMessage: r.lastMessage,
    priority: r.lead?.status === "needs_human",
  }));
  return c.json({ conversations });
});

chatRoutes.post("/conversations", async (c) => {
  const business = await resolveBusiness(c);
  const body = await c.req.json().catch(() => null);
  const leadId = z.string().uuid().optional().safeParse(body?.leadId).success ? (body.leadId as string) : undefined;
  const source = typeof body?.source === "string" ? body.source : "website_chat";
  if (leadId) {
    const lead = await repo.getLeadById(business.id, leadId);
    if (!lead) throw new HttpError(404, "Lead not found");
  }
  const bundle = await startConversation(business.id, { leadId, source });
  return c.json(bundle, 201);
});

/** One-click test: create a throwaway lead + conversation, AI welcomes. */
chatRoutes.post("/test", async (c) => {
  const business = await resolveBusiness(c);
  const bundle = await startConversation(business.id, { source: "manual", testLeadName: "Test" });
  return c.json(bundle, 201);
});

chatRoutes.get("/conversations/:id", async (c) => {
  await resolveConversationAccess(c);
  const business = await resolveBusiness(c);
  const bundle = await getBundle(business.id, c.req.param("id"));
  if (!bundle) throw new HttpError(404, "Conversation not found");
  return c.json(bundle);
});

chatRoutes.post("/conversations/:id/messages", async (c) => {
  const { business } = await resolveConversationAccess(c);
  const body = await c.req.json().catch(() => null);
  const parsed = messageSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid input");
  const bundle = await handleLeadMessage(business.id, c.req.param("id"), parsed.data.body);
  return c.json(bundle);
});

chatRoutes.post("/conversations/:id/reply", async (c) => {
  const { business } = await resolveConversationAccess(c);
  const body = await c.req.json().catch(() => null);
  const parsed = messageSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid input");
  const bundle = await humanReply(business.id, c.req.param("id"), parsed.data.body);
  return c.json(bundle);
});

chatRoutes.post("/conversations/:id/takeover", async (c) => {
  const { business } = await resolveConversationAccess(c);
  const bundle = await takeOver(business.id, c.req.param("id"));
  return c.json(bundle);
});

chatRoutes.post("/conversations/:id/return-to-ai", async (c) => {
  const { business } = await resolveConversationAccess(c);
  const bundle = await returnToAi(business.id, c.req.param("id"));
  return c.json(bundle);
});

chatRoutes.post("/conversations/:id/qualified", async (c) => {
  const { business } = await resolveConversationAccess(c);
  const body = await c.req.json().catch(() => null);
  const parsed = scoreSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid input");
  const bundle = await markQualified(business.id, c.req.param("id"), parsed.data.score);
  return c.json(bundle);
});

chatRoutes.post("/conversations/:id/close", async (c) => {
  const { business } = await resolveConversationAccess(c);
  const body = await c.req.json().catch(() => null);
  const parsed = closeSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid input");
  const bundle = await closeLead(business.id, c.req.param("id"), parsed.data.outcome);
  return c.json(bundle);
});
