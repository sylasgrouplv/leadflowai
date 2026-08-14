/**
 * Repository — the ONLY place that talks to the database from app code.
 *
 * Every business-owned read/write takes an explicit businessId and filters by
 * it, so tenant isolation is enforced in one place and later builds (leads,
 * conversations, appointments, follow-ups) slot in as new functions here.
 *
 * All functions are async so a future Postgres driver swap (await-based) is a
 * change inside this file + client.ts, not across the app.
 */
import { and, asc, count, desc, eq, gte, inArray, lt, sql, type SQL } from "drizzle-orm";
import { getDb, getSqliteRaw, isPgMode, type Db } from "./client";
import * as s from "./schema";
import {
  type BusinessCategory,
  type LeadScore,
  type LeadStatus,
  type UserRole,
  type APPOINTMENT_STATUSES,
  type FOLLOWUP_STATUSES,
  type FOLLOWUP_TYPES,
  type INTEGRATION_PROVIDERS,
  type KB_KINDS,
  type PLAN_NAMES,
} from "./schema";
import { randomUUID } from "node:crypto";

export const now = () => Date.now();

/**
 * Run a callback inside a database transaction on either dialect.
 *
 * - Postgres (async): drizzle's native transaction with an async callback.
 * - SQLite: bun:sqlite's native transaction is SYNC-ONLY (it commits before
 *   microtasks run), so we drive BEGIN/COMMIT/ROLLBACK directly on the raw
 *   connection — this lets the same async callback work on both drivers.
 */
export async function withTransaction<T>(fn: (tx: Db) => Promise<T> | T): Promise<T> {
  const db = getDb();
  if (isPgMode()) {
    return db.transaction(async (tx: Db) => fn(tx));
  }
  const raw = getSqliteRaw();
  raw.exec("BEGIN");
  try {
    const result = await fn(db);
    raw.exec("COMMIT");
    return result;
  } catch (err) {
    raw.exec("ROLLBACK");
    throw err;
  }
}

export const newId = () => randomUUID();

// ---------------------------------------------------------------------------
// Users / auth
// ---------------------------------------------------------------------------

export interface NewUser {
  email: string;
  passwordHash: string;
  name: string;
  role?: UserRole;
}

export async function createUser(u: NewUser) {
  const db = getDb();
  const id = newId();
  const t = now();
  await db.insert(s.users)
    .values({ id, email: u.email.toLowerCase(), passwordHash: u.passwordHash, name: u.name, role: u.role ?? "owner", createdAt: t, updatedAt: t })
    .execute();
  return getUserById(id);
}

export async function getUserByEmail(email: string) {
  const rows = await getDb().select().from(s.users).where(eq(s.users.email, email.toLowerCase())).execute();
  return rows[0] ?? null;
}

export async function getUserById(id: string) {
  const rows = await getDb().select().from(s.users).where(eq(s.users.id, id)).execute();
  return rows[0] ?? null;
}

export async function insertSession(id: string, userId: string, tokenHash: string, expiresAt: number) {
  await getDb()
    .insert(s.sessions)
    .values({ id, userId, tokenHash, expiresAt, createdAt: now() })
    .execute();
}

export async function getSessionByTokenHash(tokenHash: string) {
  const rows = await getDb().select().from(s.sessions).where(eq(s.sessions.tokenHash, tokenHash)).execute();
  return rows[0] ?? null;
}

export async function deleteSession(id: string) {
  await getDb().delete(s.sessions).where(eq(s.sessions.id, id)).execute();
}

export async function deleteExpiredSessions() {
  await getDb().delete(s.sessions).where(sql`${s.sessions.expiresAt} < ${now()}`).execute();
}

// ---------------------------------------------------------------------------
// Businesses + team
// ---------------------------------------------------------------------------

export interface NewBusiness {
  ownerId: string;
  name: string;
  category?: BusinessCategory;
  phone?: string;
  email?: string;
  website?: string;
  description?: string;
}

export async function createBusiness(b: NewBusiness) {
  const db = getDb();
  const id = newId();
  const t = now();
  await withTransaction(async (tx) => {
    await tx.insert(s.businesses)
      .values({
        id,
        ownerId: b.ownerId,
        name: b.name,
        category: b.category ?? "home_services",
        phone: b.phone ?? "",
        email: b.email ?? "",
        website: b.website ?? "",
        description: b.description ?? "",
        onboardingStep: 1,
        onboardingCompleted: 0,
        createdAt: t,
        updatedAt: t,
      })
      .execute();
    await tx.insert(s.teamMembers).values({ id: newId(), businessId: id, userId: b.ownerId, role: "owner", createdAt: t }).execute();
    // Every business starts with an integration row per provider (mock status
    // until connected) and a trialing subscription row.
    for (const provider of s.INTEGRATION_PROVIDERS) {
      await tx.insert(s.integrations)
        .values({ id: newId(), businessId: id, provider, status: "not_configured", createdAt: t, updatedAt: t })
        .execute();
    }
    await tx.insert(s.subscriptions)
      .values({ id: newId(), businessId: id, plan: "starter", status: "trialing", createdAt: t, updatedAt: t })
      .execute();
    await tx.insert(s.widgetSettings)
      .values({ id: newId(), businessId: id, ...DEFAULT_WIDGET_SETTINGS, createdAt: t, updatedAt: t })
      .execute();
  });
  return getBusinessById(id);
}

export async function getBusinessById(id: string) {
  const rows = await getDb().select().from(s.businesses).where(eq(s.businesses.id, id)).execute();
  return rows[0] ?? null;
}

/** The first business the user belongs to (via team_members). */
export async function getBusinessForUser(userId: string) {
  const rows = await getDb()
    .select({ business: s.businesses })
    .from(s.teamMembers)
    .innerJoin(s.businesses, eq(s.teamMembers.businessId, s.businesses.id))
    .where(eq(s.teamMembers.userId, userId))
    .execute();
  return rows[0]?.business ?? null;
}

export async function listAllBusinessIds() {
  const rows = await getDb().select({ id: s.businesses.id }).from(s.businesses).execute();
  return rows.map((r) => r.id);
}

export async function updateBusiness(id: string, patch: Partial<typeof s.businesses.$inferInsert>) {
  const db = getDb();
  const existing = await getBusinessById(id);
  if (!existing) return null;
  await db.update(s.businesses)
    .set({ ...patch, updatedAt: now() })
    .where(eq(s.businesses.id, id))
    .execute();
  return getBusinessById(id);
}

export async function advanceOnboarding(id: string, toStep: number) {
  const db = getDb();
  const existing = await getBusinessById(id);
  if (!existing) return null;
  const next = Math.max(existing.onboardingStep, toStep);
  const completed = next >= 6 ? 1 : existing.onboardingCompleted;
  await db.update(s.businesses)
    .set({ onboardingStep: next, onboardingCompleted: completed, updatedAt: now() })
    .where(eq(s.businesses.id, id))
    .execute();
  return getBusinessById(id);
}

export async function addTeamMember(businessId: string, userId: string, role: UserRole) {
  const t = now();
  await getDb()
    .insert(s.teamMembers)
    .values({ id: newId(), businessId, userId, role, createdAt: t })
    .execute();
}

export async function listTeamMembers(businessId: string) {
  return await getDb()
    .select({ id: s.teamMembers.id, role: s.teamMembers.role, userId: s.teamMembers.userId, name: s.users.name, email: s.users.email })
    .from(s.teamMembers)
    .innerJoin(s.users, eq(s.teamMembers.userId, s.users.id))
    .where(eq(s.teamMembers.businessId, businessId))
    .execute();
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

export async function listServices(businessId: string) {
  return await getDb().select().from(s.services).where(eq(s.services.businessId, businessId)).orderBy(asc(s.services.createdAt)).execute();
}

export async function getServiceById(businessId: string, id: string) {
  const rows = await getDb().select().from(s.services).where(and(eq(s.services.id, id), eq(s.services.businessId, businessId))).execute();
  return rows[0] ?? null;
}

export async function addService(businessId: string, data: { name: string; description?: string; priceCents: number; durationMin: number; averageValueCents?: number }) {
  const t = now();
  const id = newId();
  await getDb()
    .insert(s.services)
    .values({ id, businessId, name: data.name, description: data.description ?? "", priceCents: data.priceCents, durationMin: data.durationMin, averageValueCents: data.averageValueCents ?? 0, active: 1, createdAt: t, updatedAt: t })
    .execute();
  return getServiceById(businessId, id);
}

export async function updateService(businessId: string, id: string, patch: Partial<typeof s.services.$inferInsert>) {
  const existing = await getServiceById(businessId, id);
  if (!existing) return null;
  await getDb().update(s.services).set({ ...patch, updatedAt: now() }).where(and(eq(s.services.id, id), eq(s.services.businessId, businessId))).execute();
  return getServiceById(businessId, id);
}

export async function deleteService(businessId: string, id: string) {
  await getDb().delete(s.services).where(and(eq(s.services.id, id), eq(s.services.businessId, businessId))).execute();
}

export async function replaceServices(businessId: string, items: { name: string; description?: string; priceCents: number; durationMin: number; averageValueCents?: number }[]) {
  const db = getDb();
  await withTransaction(async (tx) => {
    await tx.delete(s.services).where(eq(s.services.businessId, businessId)).execute();
    for (const it of items) {
      const t = now();
      await tx.insert(s.services)
        .values({ id: newId(), businessId, name: it.name, description: it.description ?? "", priceCents: it.priceCents, durationMin: it.durationMin, averageValueCents: it.averageValueCents ?? 0, active: 1, createdAt: t, updatedAt: t })
        .execute();
    }
  });
  return listServices(businessId);
}

// ---------------------------------------------------------------------------
// Revenue attribution (spec §23)
// ---------------------------------------------------------------------------

/** Configured average job value for a service — falls back to priceCents when
 *  the owner hasn't set one (0 = "use list price"). Never a real revenue figure. */
export function effectiveServiceValue(service: { averageValueCents?: number | null; priceCents?: number } | null): number {
  if (!service) return 0;
  return service.averageValueCents && service.averageValueCents > 0 ? service.averageValueCents : (service.priceCents ?? 0);
}

/** Estimated revenue = booked/completed jobs × configured average job value
 *  (spec §23). Jobs = appointments with status booked/confirmed/completed.
 *  Callers MUST label this "Estimated Revenue" — it is an estimate, not actuals. */
export async function estimatedRevenueFromJobs(businessId: string): Promise<number> {
  const db = getDb();
  const appts = await db
    .select()
    .from(s.appointments)
    .where(and(eq(s.appointments.businessId, businessId), sql`${s.appointments.status} IN ('booked','confirmed','completed')`))
    .execute();
  if (!appts.length) return 0;
  const services = await listServices(businessId);
  const byId = new Map(services.map((sv) => [sv.id, sv]));
  let total = 0;
  for (const a of appts) {
    if (!a.serviceId) continue;
    total += effectiveServiceValue(byId.get(a.serviceId) ?? null);
  }
  return total;
}

// ---------------------------------------------------------------------------
// Knowledge base
// ---------------------------------------------------------------------------

export async function listKnowledge(businessId: string) {
  return await getDb().select().from(s.knowledgeBase).where(eq(s.knowledgeBase.businessId, businessId)).orderBy(asc(s.knowledgeBase.createdAt)).execute();
}

export async function addKnowledge(businessId: string, data: { kind: (typeof KB_KINDS)[number]; question?: string; answer: string }) {
  const t = now();
  const id = newId();
  await getDb()
    .insert(s.knowledgeBase)
    .values({ id, businessId, kind: data.kind, question: data.question ?? "", answer: data.answer, createdAt: t, updatedAt: t })
    .execute();
  return getKnowledgeById(businessId, id);
}

export async function getKnowledgeById(businessId: string, id: string) {
  const rows = await getDb().select().from(s.knowledgeBase).where(and(eq(s.knowledgeBase.id, id), eq(s.knowledgeBase.businessId, businessId))).execute();
  return rows[0] ?? null;
}

export async function deleteKnowledge(businessId: string, id: string) {
  await getDb().delete(s.knowledgeBase).where(and(eq(s.knowledgeBase.id, id), eq(s.knowledgeBase.businessId, businessId))).execute();
}

export async function replaceKnowledge(businessId: string, items: { kind: (typeof KB_KINDS)[number]; question?: string; answer: string }[]) {
  const db = getDb();
  await withTransaction(async (tx) => {
    await tx.delete(s.knowledgeBase).where(eq(s.knowledgeBase.businessId, businessId)).execute();
    for (const it of items) {
      const t = now();
      await tx.insert(s.knowledgeBase)
        .values({ id: newId(), businessId, kind: it.kind, question: it.question ?? "", answer: it.answer, createdAt: t, updatedAt: t })
        .execute();
    }
  });
  return listKnowledge(businessId);
}

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------

export interface NewLead {
  businessId: string;
  firstName: string;
  lastName?: string;
  phone?: string;
  email?: string;
  source?: string;
  serviceRequested?: string;
  location?: string;
  status?: LeadStatus;
  score?: LeadScore;
  notes?: string;
  estimatedValueCents?: number;
  createdAt?: number;
}

export async function createLead(l: NewLead) {
  const t = l.createdAt ?? now();
  const id = newId();
  await getDb()
    .insert(s.leads)
    .values({
      id,
      businessId: l.businessId,
      firstName: l.firstName,
      lastName: l.lastName ?? "",
      phone: l.phone ?? "",
      email: l.email ?? "",
      source: l.source ?? "website_chat",
      serviceRequested: l.serviceRequested ?? "",
      location: l.location ?? "",
      status: l.status ?? "new",
      score: l.score ?? "cold",
      notes: l.notes ?? "",
      estimatedValueCents: l.estimatedValueCents ?? 0,
      createdAt: t,
      updatedAt: t,
    })
    .execute();
  return getLeadById(l.businessId, id);
}

export async function getLeadById(businessId: string, id: string) {
  const rows = await getDb().select().from(s.leads).where(and(eq(s.leads.id, id), eq(s.leads.businessId, businessId))).execute();
  return rows[0] ?? null;
}

export async function listLeads(businessId: string, limit = 100) {
  return await getDb().select().from(s.leads).where(eq(s.leads.businessId, businessId)).orderBy(desc(s.leads.createdAt)).limit(limit).execute();
}

/** Leads of one source (e.g. source='prospect_import') — campaign views. */
export async function listLeadsBySource(businessId: string, source: string, limit = 100_000) {
  return await getDb()
    .select()
    .from(s.leads)
    .where(and(eq(s.leads.businessId, businessId), eq(s.leads.source, source)))
    .orderBy(desc(s.leads.createdAt))
    .limit(limit)
    .execute();
}

export async function updateLead(businessId: string, id: string, patch: Partial<typeof s.leads.$inferInsert>) {
  const existing = await getLeadById(businessId, id);
  if (!existing) return null;
  await getDb().update(s.leads).set({ ...patch, updatedAt: now() }).where(and(eq(s.leads.id, id), eq(s.leads.businessId, businessId))).execute();
  return getLeadById(businessId, id);
}

export async function countLeadsByStatus(businessId: string, statuses: LeadStatus[]) {
  const rows = await getDb()
    .select({ n: count() })
    .from(s.leads)
    .where(and(eq(s.leads.businessId, businessId), statuses.length ? inArray(s.leads.status, statuses) : sql`1=1`))
    .execute();
  return rows[0]?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Conversations / messages
// ---------------------------------------------------------------------------

export async function createConversation(businessId: string, data: { leadId?: string; channel?: string; status?: (typeof s.CONVERSATION_STATUSES)[number]; aiEnabled?: number }) {
  const t = now();
  const id = newId();
  await getDb()
    .insert(s.conversations)
    .values({ id, businessId, leadId: data.leadId ?? null, channel: data.channel ?? "chat", status: data.status ?? "active", aiEnabled: data.aiEnabled ?? 1, createdAt: t, updatedAt: t })
    .execute();
  return getConversationById(businessId, id);
}

export async function getConversationById(businessId: string, id: string) {
  const rows = await getDb().select().from(s.conversations).where(and(eq(s.conversations.id, id), eq(s.conversations.businessId, businessId))).execute();
  return rows[0] ?? null;
}

export async function addMessage(businessId: string, data: { conversationId: string; sender: (typeof s.MESSAGE_SENDERS)[number]; body: string; createdAt?: number }) {
  const t = data.createdAt ?? now();
  const id = newId();
  await getDb()
    .insert(s.messages)
    .values({ id, businessId, conversationId: data.conversationId, sender: data.sender, body: data.body, createdAt: t })
    .execute();
  await getDb().update(s.conversations).set({ updatedAt: t }).where(and(eq(s.conversations.id, data.conversationId), eq(s.conversations.businessId, businessId))).execute();
  return id;
}

export async function listMessages(businessId: string, conversationId: string) {
  return await getDb()
    .select()
    .from(s.messages)
    .where(and(eq(s.messages.conversationId, conversationId), eq(s.messages.businessId, businessId)))
    .orderBy(asc(s.messages.createdAt))
    .execute();
}

export async function updateKnowledge(businessId: string, id: string, patch: Partial<typeof s.knowledgeBase.$inferInsert>) {
  const existing = await getKnowledgeById(businessId, id);
  if (!existing) return null;
  await getDb().update(s.knowledgeBase).set({ ...patch, updatedAt: now() }).where(and(eq(s.knowledgeBase.id, id), eq(s.knowledgeBase.businessId, businessId))).execute();
  return getKnowledgeById(businessId, id);
}

// ---------------------------------------------------------------------------
// Leads — search / detail / notes
// ---------------------------------------------------------------------------

export interface LeadSearch {
  q?: string;
  status?: string;
  score?: string;
  source?: string;
  sort?: "newest" | "oldest";
  assignedTo?: string; // filter: only leads assigned to this user
}

export async function searchLeads(businessId: string, opts: LeadSearch = {}, limit = 500) {
  const db = getDb();
  const conds: SQL[] = [eq(s.leads.businessId, businessId)];
  if (opts.status && s.LEAD_STATUSES.includes(opts.status as LeadStatus)) conds.push(eq(s.leads.status, opts.status as LeadStatus));
  if (opts.score && s.LEAD_SCORES.includes(opts.score as LeadScore)) conds.push(eq(s.leads.score, opts.score as LeadScore));
  if (opts.source) conds.push(eq(s.leads.source, opts.source));
  if (opts.assignedTo) conds.push(eq(s.leads.assignedTo, opts.assignedTo));
  if (opts.q) {
    const like = `%${opts.q.replace(/[%_]/g, "")}%`;
    conds.push(sql`(${s.leads.firstName} || ' ' || coalesce(${s.leads.lastName}, '') || ' ' || coalesce(${s.leads.phone}, '') || ' ' || coalesce(${s.leads.email}, '') || ' ' || coalesce(${s.leads.serviceRequested}, '') || ' ' || coalesce(${s.leads.location}, '')) LIKE ${like}`);
  }
  return await db
    .select({
      lead: s.leads,
      assignedName: s.users.name,
    })
    .from(s.leads)
    .leftJoin(s.users, eq(s.leads.assignedTo, s.users.id))
    .where(and(...conds))
    .orderBy(opts.sort === "oldest" ? asc(s.leads.createdAt) : desc(s.leads.createdAt))
    .limit(limit)
    .execute();
}

/** Earliest pending follow-up per lead (for the "next follow-up" column). */
export async function getNextFollowUps(businessId: string) {
  const rows = await getDb()
    .select({
      leadId: s.followUps.leadId,
      scheduledFor: s.followUps.scheduledFor,
      type: s.followUps.type,
    })
    .from(s.followUps)
    .where(and(eq(s.followUps.businessId, businessId), eq(s.followUps.status, "pending")))
    .orderBy(asc(s.followUps.scheduledFor))
    .execute();
  const map = new Map<string, { scheduledFor: number; type: string }>();
  for (const r of rows) if (!map.has(r.leadId)) map.set(r.leadId, { scheduledFor: r.scheduledFor, type: r.type });
  return map;
}

/** Set a lead's next follow-up by replacing its pending manual follow-ups. */
export async function setNextFollowUp(businessId: string, leadId: string, scheduledFor: number, type: (typeof FOLLOWUP_TYPES)[number] = "sms") {
  const db = getDb();
  await withTransaction(async (tx) => {
    await tx.delete(s.followUps)
      .where(and(eq(s.followUps.businessId, businessId), eq(s.followUps.leadId, leadId), eq(s.followUps.status, "pending"), eq(s.followUps.templateKey, "manual")))
      .execute();
    await tx.insert(s.followUps)
      .values({ id: newId(), businessId, leadId, type, scheduledFor, templateKey: "manual", status: "pending", attempts: 0, createdAt: now(), updatedAt: now() })
      .execute();
  });
}

export async function appendLeadNote(businessId: string, leadId: string, note: string, authorName: string) {
  const lead = await getLeadById(businessId, leadId);
  if (!lead) return null;
  const stamp = new Date().toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const entry = `${stamp} — ${authorName}: ${note}`;
  const notes = lead.notes ? `${lead.notes}\n\n${entry}` : entry;
  return updateLead(businessId, leadId, { notes });
}

// ---------------------------------------------------------------------------
// Conversations / messages
// ---------------------------------------------------------------------------

export interface ConversationListItem {
  conversation: typeof s.conversations.$inferSelect;
  lead: (typeof s.leads.$inferSelect) | null;
  lastMessage: { body: string; sender: string; createdAt: number } | null;
}

export async function listConversations(businessId: string, opts: { statuses?: string[]; leadIds?: string[] } = {}): Promise<ConversationListItem[]> {
  const db = getDb();
  const conds: SQL[] = [eq(s.conversations.businessId, businessId)];
  if (opts.statuses?.length) conds.push(inArray(s.conversations.status, opts.statuses as (typeof s.CONVERSATION_STATUSES)[number][]));
  if (opts.leadIds?.length) conds.push(inArray(s.conversations.leadId, opts.leadIds));
  const rows = await db
    .select({ conversation: s.conversations, lead: s.leads })
    .from(s.conversations)
    .leftJoin(s.leads, eq(s.conversations.leadId, s.leads.id))
    .where(and(...conds))
    .orderBy(desc(s.conversations.updatedAt))
    .execute();

  // Last message per conversation — one grouped pass.
  const lastMsgs = await db
    .select({
      conversationId: s.messages.conversationId,
      body: s.messages.body,
      sender: s.messages.sender,
      createdAt: s.messages.createdAt,
    })
    .from(s.messages)
    .where(eq(s.messages.businessId, businessId))
    .orderBy(asc(s.messages.createdAt))
    .execute();
  const lastByConv = new Map<string, ConversationListItem["lastMessage"]>();
  for (const m of lastMsgs) lastByConv.set(m.conversationId, { body: m.body, sender: m.sender, createdAt: m.createdAt });

  return rows.map((r) => ({ conversation: r.conversation, lead: r.lead, lastMessage: lastByConv.get(r.conversation.id) ?? null }));
}

export async function updateConversation(businessId: string, id: string, patch: Partial<typeof s.conversations.$inferInsert>) {
  const existing = await getConversationById(businessId, id);
  if (!existing) return null;
  await getDb().update(s.conversations).set({ ...patch, updatedAt: now() }).where(and(eq(s.conversations.id, id), eq(s.conversations.businessId, businessId))).execute();
  return getConversationById(businessId, id);
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export async function createNotification(businessId: string, data: { userId?: string; kind?: string; title: string; body?: string }) {
  await getDb()
    .insert(s.notifications)
    .values({ id: newId(), businessId, userId: data.userId ?? null, kind: data.kind ?? "info", title: data.title, body: data.body ?? "", read: 0, createdAt: now() })
    .execute();
}

export async function listNotifications(businessId: string, limit = 20) {
  return await getDb().select().from(s.notifications).where(eq(s.notifications.businessId, businessId)).orderBy(desc(s.notifications.createdAt)).limit(limit).execute();
}

export async function countUnreadNotifications(businessId: string) {
  const rows = await getDb()
    .select({ n: count() })
    .from(s.notifications)
    .where(and(eq(s.notifications.businessId, businessId), eq(s.notifications.read, 0)))
    .execute();
  return rows[0]?.n ?? 0;
}

export async function markNotificationRead(businessId: string, id: string) {
  await getDb().update(s.notifications).set({ read: 1 }).where(and(eq(s.notifications.id, id), eq(s.notifications.businessId, businessId))).execute();
}

export async function markAllNotificationsRead(businessId: string) {
  await getDb().update(s.notifications).set({ read: 1 }).where(eq(s.notifications.businessId, businessId)).execute();
}

// ---------------------------------------------------------------------------
// Appointments
// ---------------------------------------------------------------------------

export interface NewAppointment {
  businessId: string;
  leadId?: string | null;
  serviceId?: string | null;
  startAt: number;
  endAt: number;
  status?: (typeof APPOINTMENT_STATUSES)[number];
  notes?: string;
  createdAt?: number;
}

export async function createAppointment(a: NewAppointment) {
  const t = a.createdAt ?? now();
  const id = newId();
  await getDb()
    .insert(s.appointments)
    .values({ id, businessId: a.businessId, leadId: a.leadId ?? null, serviceId: a.serviceId ?? null, startAt: a.startAt, endAt: a.endAt, status: a.status ?? "booked", notes: a.notes ?? "", createdAt: t, updatedAt: t })
    .execute();
  return getAppointmentById(a.businessId, id);
}

export async function getAppointmentById(businessId: string, id: string) {
  const rows = await getDb().select().from(s.appointments).where(and(eq(s.appointments.id, id), eq(s.appointments.businessId, businessId))).execute();
  return rows[0] ?? null;
}

/** Appointments overlapping [start, end) for a business — used to never double-book. */
export async function listOverlappingAppointments(businessId: string, start: number, end: number) {
  return await getDb()
    .select()
    .from(s.appointments)
    .where(
      and(
        eq(s.appointments.businessId, businessId),
        sql`${s.appointments.startAt} < ${end} AND ${s.appointments.endAt} > ${start}`,
        sql`${s.appointments.status} NOT IN ('cancelled', 'no_show')`
      )
    )
    .execute();
}

export async function listAppointmentsForLead(businessId: string, leadId: string) {
  return await getDb()
    .select({ appointment: s.appointments, serviceName: s.services.name })
    .from(s.appointments)
    .leftJoin(s.services, eq(s.appointments.serviceId, s.services.id))
    .where(and(eq(s.appointments.businessId, businessId), eq(s.appointments.leadId, leadId)))
    .orderBy(desc(s.appointments.startAt))
    .execute();
}

export async function listUpcomingAppointments(businessId: string, limit = 6) {
  return await getDb()
    .select({
      appointment: s.appointments,
      leadName: s.leads.firstName,
      leadLastName: s.leads.lastName,
      serviceName: s.services.name,
    })
    .from(s.appointments)
    .leftJoin(s.leads, eq(s.appointments.leadId, s.leads.id))
    .leftJoin(s.services, eq(s.appointments.serviceId, s.services.id))
    .where(and(eq(s.appointments.businessId, businessId), gte(s.appointments.startAt, now()), sql`${s.appointments.status} NOT IN ('cancelled', 'no_show')`))
    .orderBy(asc(s.appointments.startAt))
    .limit(limit)
    .execute();
}

export async function countAppointments(businessId: string) {
  const rows = await getDb()
    .select({ n: count() })
    .from(s.appointments)
    .where(and(eq(s.appointments.businessId, businessId), sql`${s.appointments.status} NOT IN ('cancelled', 'no_show')`))
    .execute();
  return rows[0]?.n ?? 0;
}

/** Appointment list with lead + service + value, scoped upcoming/past/all (never cancelled/no-show in "upcoming"). */
export interface AppointmentListItem {
  appointment: typeof s.appointments.$inferSelect;
  lead: (typeof s.leads.$inferSelect) | null;
  serviceName: string | null;
}

export async function listAppointments(
  businessId: string,
  opts: { scope?: "upcoming" | "past" | "all"; limit?: number } = {}
): Promise<AppointmentListItem[]> {
  const scope = opts.scope ?? "all";
  const conds: SQL[] = [eq(s.appointments.businessId, businessId)];
  if (scope === "upcoming") {
    conds.push(gte(s.appointments.startAt, now()));
    conds.push(sql`${s.appointments.status} NOT IN ('cancelled', 'no_show')`);
  } else if (scope === "past") {
    conds.push(sql`${s.appointments.startAt} < ${now()}`);
  }
  return await getDb()
    .select({ appointment: s.appointments, lead: s.leads, serviceName: s.services.name })
    .from(s.appointments)
    .leftJoin(s.leads, eq(s.appointments.leadId, s.leads.id))
    .leftJoin(s.services, eq(s.appointments.serviceId, s.services.id))
    .where(and(...conds))
    .orderBy(scope === "past" ? desc(s.appointments.startAt) : asc(s.appointments.startAt))
    .limit(opts.limit ?? 200)
    .execute();
}

export async function updateAppointment(businessId: string, id: string, patch: Partial<typeof s.appointments.$inferInsert>) {
  const existing = await getAppointmentById(businessId, id);
  if (!existing) return null;
  await getDb().update(s.appointments).set({ ...patch, updatedAt: now() }).where(and(eq(s.appointments.id, id), eq(s.appointments.businessId, businessId))).execute();
  return getAppointmentById(businessId, id);
}

// ---------------------------------------------------------------------------
// Follow-ups
// ---------------------------------------------------------------------------

export async function createFollowUp(businessId: string, data: { leadId: string; type: (typeof FOLLOWUP_TYPES)[number]; scheduledFor: number; templateKey?: string; status?: (typeof FOLLOWUP_STATUSES)[number] }) {
  const t = now();
  const id = newId();
  await getDb()
    .insert(s.followUps)
    .values({ id, businessId, leadId: data.leadId, type: data.type, scheduledFor: data.scheduledFor, templateKey: data.templateKey ?? "", status: data.status ?? "pending", attempts: 0, createdAt: t, updatedAt: t })
    .execute();
  return id;
}

export async function listFollowUps(businessId: string, limit = 50) {
  return await getDb().select().from(s.followUps).where(eq(s.followUps.businessId, businessId)).orderBy(asc(s.followUps.scheduledFor)).limit(limit).execute();
}

export async function getFollowUpById(businessId: string, id: string) {
  const rows = await getDb().select().from(s.followUps).where(and(eq(s.followUps.id, id), eq(s.followUps.businessId, businessId))).execute();
  return rows[0] ?? null;
}

export async function updateFollowUp(businessId: string, id: string, patch: Partial<typeof s.followUps.$inferInsert>) {
  const existing = await getFollowUpById(businessId, id);
  if (!existing) return null;
  await getDb().update(s.followUps).set({ ...patch, updatedAt: now() }).where(and(eq(s.followUps.id, id), eq(s.followUps.businessId, businessId))).execute();
  return getFollowUpById(businessId, id);
}

/** Follow-ups joined with lead names for the Follow-Ups page. */
export interface FollowUpListItem {
  followUp: typeof s.followUps.$inferSelect;
  lead: (typeof s.leads.$inferSelect) | null;
}

export async function listFollowUpsWithLead(businessId: string, limit = 200): Promise<FollowUpListItem[]> {
  return await getDb()
    .select({ followUp: s.followUps, lead: s.leads })
    .from(s.followUps)
    .leftJoin(s.leads, eq(s.followUps.leadId, s.leads.id))
    .where(eq(s.followUps.businessId, businessId))
    .orderBy(asc(s.followUps.scheduledFor))
    .limit(limit)
    .execute();
}

/** Due pending follow-ups for the scheduler (oldest first). */
export async function listDueFollowUps(limit = 100, nowMs = now()) {
  return await getDb()
    .select()
    .from(s.followUps)
    .where(and(eq(s.followUps.status, "pending"), sql`${s.followUps.scheduledFor} <= ${nowMs}`))
    .orderBy(asc(s.followUps.scheduledFor))
    .limit(limit)
    .execute();
}

/** Cancel a lead's not-yet-sent follow-ups (stop rules: booked / customer / opt-out / manual stop).
 *  Also cancels each cancelled row's own automation run so a stopped sequence
 *  can never fire (Brain 3 — the engine re-checks the row at fire time too).
 *  Appointment-reminder rows (Phase 1b, templateKey "appointment_reminder")
 *  are EXCLUDED: the Reminder Agent owns them and re-checks the appointment at
 *  fire time, so a booked lead's reminder must survive the booking stop-rule
 *  (it cancels itself for cancelled/rescheduled appointments).
 *  Onboarding setup-step rows (Phase 2, templateKey "onboarding_step_<n>") are
 *  EXCLUDED the same way: the Onboarding Agent owns them and re-checks the
 *  step is still incomplete at fire time, so generic stop rules must not kill
 *  a new business's setup reminders (completed steps cancel themselves).
 *  Invoice-reminder rows (Phase 2 / Chunk H, templateKey "invoice_reminder")
 *  are EXCLUDED the same way: the Invoice Agent owns them and re-checks the
 *  invoice is still unpaid at fire time, so a customer lead's invoice reminder
 *  survives generic stop rules (markInvoicePaid/Cancelled cancels it). */
export async function cancelFollowUpsForLead(businessId: string, leadId: string, opts: { keep?: string[] } = {}) {
  const db = getDb();
  const rows = await db
    .select()
    .from(s.followUps)
    .where(and(eq(s.followUps.businessId, businessId), eq(s.followUps.leadId, leadId), sql`${s.followUps.status} IN ('pending', 'paused')`))
    .execute();
  let cancelled = 0;
  for (const r of rows) {
    if (opts.keep?.includes(r.templateKey ?? "") || r.templateKey === "appointment_reminder" || (r.templateKey ?? "").startsWith("onboarding_step_") || r.templateKey === "invoice_reminder") continue;
    await db.update(s.followUps).set({ status: "cancelled", updatedAt: now() }).where(eq(s.followUps.id, r.id)).execute();
    cancelled += 1;
    const run = await getRunForFollowUp(r.id);
    if (run && ["pending", "running"].includes(run.status)) {
      await db.update(s.automationRuns).set({ status: "cancelled", updatedAt: now() }).where(eq(s.automationRuns.id, run.id)).execute();
    }
  }
  // Also cancel any remaining runs for this lead that are NOT backed by an
  // excluded follow-up row — e.g. the sequence-start run materialized on
  // LEAD_QUALIFIED (ruleKind "qualified_followup_sequence", no followUpId).
  // Reminder/onboarding runs survive: they are linked to an excluded row via
  // their payload followUpId, so we resolve the row's templateKey and skip it.
  const runs = await db
    .select()
    .from(s.automationRuns)
    .where(and(eq(s.automationRuns.businessId, businessId), eq(s.automationRuns.leadId, leadId), inArray(s.automationRuns.status, ["pending", "running"])))
    .execute();
  for (const r of runs) {
    let templateKey: string | null = null;
    try {
      const p = JSON.parse(r.payloadJson || "{}");
      if (typeof p.followUpId === "string") templateKey = (await getFollowUpById(businessId, p.followUpId))?.templateKey ?? null;
    } catch {
      /* unparsable payload — treat as orphaned (cancel) */
    }
    if (templateKey === "appointment_reminder" || (templateKey ?? "").startsWith("onboarding_step_") || templateKey === "invoice_reminder" || (opts.keep ?? []).includes(templateKey ?? "")) continue;
    await db.update(s.automationRuns).set({ status: "cancelled", updatedAt: now() }).where(eq(s.automationRuns.id, r.id)).execute();
  }
  return cancelled;
}

// ---------------------------------------------------------------------------
// Follow-up sequence config (owner-customizable, spec §9)
// ---------------------------------------------------------------------------

export interface FollowUpStepConfig {
  step: number;
  days: number;
  type: (typeof FOLLOWUP_TYPES)[number];
  enabled: boolean;
  templateKey: string;
}

export const DEFAULT_FOLLOWUP_STEPS: FollowUpStepConfig[] = [
  { step: 1, days: 1, type: "sms", enabled: true, templateKey: "seq_1" },
  { step: 2, days: 3, type: "email", enabled: true, templateKey: "seq_2" },
  { step: 3, days: 7, type: "sms", enabled: true, templateKey: "seq_3" },
  { step: 4, days: 14, type: "email", enabled: true, templateKey: "seq_4" },
];

export async function getFollowUpConfig(businessId: string): Promise<FollowUpStepConfig[]> {
  const rows = await getDb().select().from(s.followUpConfigs).where(eq(s.followUpConfigs.businessId, businessId)).execute();
  if (!rows[0]) return DEFAULT_FOLLOWUP_STEPS.map((st) => ({ ...st }));
  try {
    const parsed = JSON.parse(rows[0].stepsJson) as FollowUpStepConfig[];
    if (Array.isArray(parsed) && parsed.length) return parsed;
  } catch {
    /* fall through to defaults */
  }
  return DEFAULT_FOLLOWUP_STEPS.map((st) => ({ ...st }));
}

export async function saveFollowUpConfig(businessId: string, steps: FollowUpStepConfig[]) {
  const t = now();
  const existing = await getDb().select().from(s.followUpConfigs).where(eq(s.followUpConfigs.businessId, businessId)).execute();
  if (existing[0]) {
    await getDb().update(s.followUpConfigs).set({ stepsJson: JSON.stringify(steps), updatedAt: t }).where(eq(s.followUpConfigs.id, existing[0].id)).execute();
  } else {
    await getDb().insert(s.followUpConfigs).values({ id: newId(), businessId, stepsJson: JSON.stringify(steps), createdAt: t, updatedAt: t }).execute();
  }
  return steps;
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export interface DashboardData {
  stats: {
    leads: number;
    qualified: number;
    appointments: number;
    customers: number;
    conversionRate: number;
    estimatedRevenueCents: number;
  };
  funnel: { leads: number; qualified: number; appointments: number; customers: number };
  recentLeads: typeof s.leads.$inferSelect[];
  upcomingAppointments: Awaited<ReturnType<typeof listUpcomingAppointments>>;
}

const QUALIFIED_STATUSES: LeadStatus[] = ["qualified", "appointment_booked", "customer"];
const PIPELINE_STATUSES: LeadStatus[] = ["qualified", "appointment_booked", "customer"];

export async function getDashboard(businessId: string): Promise<DashboardData> {
  const db = getDb();
  const leads = await countLeadsByStatus(businessId, [...s.LEAD_STATUSES]);
  const qualified = await countLeadsByStatus(businessId, QUALIFIED_STATUSES);
  const appointments = await countAppointments(businessId);
  const customers = await countLeadsByStatus(businessId, ["customer"]);

  // Est. Revenue (spec §23): booked/completed jobs × configured average job
  // value — clearly labeled an estimate, never presented as actuals.
  const estimatedRevenueCents = await estimatedRevenueFromJobs(businessId);

  const [recentLeads, upcomingAppointments] = await Promise.all([
    getDb().select().from(s.leads).where(eq(s.leads.businessId, businessId)).orderBy(desc(s.leads.createdAt)).limit(6).execute(),
    listUpcomingAppointments(businessId, 6),
  ]);

  return {
    stats: {
      leads,
      qualified,
      appointments,
      customers,
      conversionRate: leads > 0 ? Math.round((customers / leads) * 1000) / 10 : 0,
      estimatedRevenueCents,
    },
    funnel: { leads, qualified, appointments, customers },
    recentLeads,
    upcomingAppointments,
  };
}

// ---------------------------------------------------------------------------
// Analytics (spec §19) — real aggregations for the Analytics page
// ---------------------------------------------------------------------------

export interface LeadsOverTimePoint {
  date: string; // YYYY-MM-DD (UTC)
  count: number;
}

export interface SourceBreakdown {
  source: string;
  count: number;
  share: number; // 0-100, 0 when no leads
}

export interface AnalyticsData {
  funnel: { leads: number; qualified: number; appointments: number; customers: number };
  stats: {
    leads: number;
    qualified: number;
    appointments: number;
    customers: number;
    conversionRate: number;
    estimatedRevenueCents: number;
    aiMessages: number;
    humanMessages: number;
  };
  leadsOverTime: LeadsOverTimePoint[];
  sources: SourceBreakdown[];
  topServices: { service: string; count: number }[];
}

const ANALYTICS_DAYS = 30;

export async function getAnalytics(businessId: string): Promise<AnalyticsData> {
  const db = getDb();
  const nowMs = now();
  const dayStartMs = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const toDateStr = (ms: number) => new Date(ms).toISOString().slice(0, 10);

  // One pass over the business's leads for time/source/service aggregation.
  const leadRows = await db
    .select({ createdAt: s.leads.createdAt, source: s.leads.source, serviceRequested: s.leads.serviceRequested })
    .from(s.leads)
    .where(eq(s.leads.businessId, businessId))
    .execute();

  // Leads over the last N days (UTC day buckets, zero-filled).
  const todayStart = dayStartMs(new Date(nowMs));
  const byDay = new Map<string, number>();
  for (let i = ANALYTICS_DAYS - 1; i >= 0; i--) byDay.set(toDateStr(todayStart - i * 86_400_000), 0);
  for (const r of leadRows) {
    const key = toDateStr(r.createdAt);
    if (byDay.has(key)) byDay.set(key, (byDay.get(key) ?? 0) + 1);
  }
  const leadsOverTime: LeadsOverTimePoint[] = [...byDay.entries()].map(([date, count]) => ({ date, count }));

  // Lead sources (all-time) with share.
  const sourceCounts = new Map<string, number>();
  for (const r of leadRows) {
    const src = r.source && r.source.trim() ? r.source : "unknown";
    sourceCounts.set(src, (sourceCounts.get(src) ?? 0) + 1);
  }
  const total = leadRows.length;
  const sources: SourceBreakdown[] = [...sourceCounts.entries()]
    .map(([source, count]) => ({ source, count, share: total > 0 ? Math.round((count / total) * 1000) / 10 : 0 }))
    .sort((a, b) => b.count - a.count);

  // Top requested services.
  const svcCounts = new Map<string, number>();
  for (const r of leadRows) {
    if (!r.serviceRequested) continue;
    svcCounts.set(r.serviceRequested, (svcCounts.get(r.serviceRequested) ?? 0) + 1);
  }
  const topServices = [...svcCounts.entries()]
    .map(([service, count]) => ({ service, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  // Funnel + stat cards (same queries as the dashboard). Est. Revenue comes
  // from revenue attribution (§23): booked/completed jobs × avg job value.
  const [leads, qualified, appointments, customers, estimatedRevenueCents, aiMsgs, humanMsgs] = await Promise.all([
    countLeadsByStatus(businessId, [...s.LEAD_STATUSES]),
    countLeadsByStatus(businessId, QUALIFIED_STATUSES),
    countAppointments(businessId),
    countLeadsByStatus(businessId, ["customer"]),
    estimatedRevenueFromJobs(businessId),
    db.select({ n: count() }).from(s.messages).where(and(eq(s.messages.businessId, businessId), eq(s.messages.sender, "ai"))).execute(),
    db.select({ n: count() }).from(s.messages).where(and(eq(s.messages.businessId, businessId), eq(s.messages.sender, "employee"))).execute(),
  ]);

  return {
    funnel: { leads, qualified, appointments, customers },
    stats: {
      leads,
      qualified,
      appointments,
      customers,
      conversionRate: leads > 0 ? Math.round((customers / leads) * 1000) / 10 : 0,
      estimatedRevenueCents,
      aiMessages: aiMsgs[0]?.n ?? 0,
      humanMessages: humanMsgs[0]?.n ?? 0,
    },
    leadsOverTime,
    sources,
    topServices,
  };
}

// ---------------------------------------------------------------------------
// Agent actions / audit / notifications
// ---------------------------------------------------------------------------

export async function logAgentAction(businessId: string, data: { agent: string; action: string; leadId?: string; input?: unknown; result?: unknown; success?: boolean }) {
  await getDb()
    .insert(s.agentActions)
    .values({
      id: newId(),
      businessId,
      agent: data.agent,
      action: data.action,
      leadId: data.leadId ?? null,
      inputJson: JSON.stringify(data.input ?? {}),
      resultJson: JSON.stringify(data.result ?? {}),
      success: data.success === false ? 0 : 1,
      createdAt: now(),
    })
    .execute();
}

export async function audit(businessId: string | null, userId: string | null, action: string, entity = "", entityId = "", details: unknown = {}) {
  await getDb()
    .insert(s.auditLogs)
    .values({ id: newId(), businessId, userId, action, entity, entityId, detailsJson: JSON.stringify(details), createdAt: now() })
    .execute();
}

export async function listAuditLogs(businessId: string, limit = 50) {
  return await getDb().select().from(s.auditLogs).where(eq(s.auditLogs.businessId, businessId)).orderBy(desc(s.auditLogs.createdAt)).limit(limit).execute();
}

export async function listAgentActions(businessId: string, limit = 50) {
  return await getDb().select().from(s.agentActions).where(eq(s.agentActions.businessId, businessId)).orderBy(desc(s.agentActions.createdAt)).limit(limit).execute();
}

// ---------------------------------------------------------------------------
// Human escalation tasks (spec §18)
// ---------------------------------------------------------------------------

export interface NewHumanTask {
  businessId: string;
  leadId?: string;
  priority: s.HumanTaskPriority;
  reason: string;
  conversationSummary?: string;
  recommendedAction?: string;
}

export async function createHumanTask(data: NewHumanTask) {
  const t = now();
  const id = newId();
  await getDb()
    .insert(s.humanTasks)
    .values({
      id,
      businessId: data.businessId,
      leadId: data.leadId ?? null,
      priority: data.priority,
      reason: data.reason,
      conversationSummary: data.conversationSummary ?? "",
      recommendedAction: data.recommendedAction ?? "",
      status: "open",
      createdAt: t,
      updatedAt: t,
      resolvedAt: null,
    })
    .execute();
  return getHumanTaskById(data.businessId, id);
}

export async function getHumanTaskById(businessId: string, id: string) {
  const rows = await getDb().select().from(s.humanTasks).where(and(eq(s.humanTasks.id, id), eq(s.humanTasks.businessId, businessId))).execute();
  return rows[0] ?? null;
}

export async function listHumanTasks(businessId: string, limit = 100, status?: s.HumanTaskStatus) {
  const conds = [eq(s.humanTasks.businessId, businessId)];
  if (status) conds.push(eq(s.humanTasks.status, status));
  return await getDb().select().from(s.humanTasks).where(and(...conds)).orderBy(desc(s.humanTasks.createdAt)).limit(limit).execute();
}

export async function resolveHumanTask(businessId: string, id: string): Promise<typeof s.humanTasks.$inferSelect | null> {
  const existing = await getHumanTaskById(businessId, id);
  if (!existing) return null;
  await getDb()
    .update(s.humanTasks)
    .set({ status: "resolved", resolvedAt: now(), updatedAt: now() })
    .where(and(eq(s.humanTasks.id, id), eq(s.humanTasks.businessId, businessId)))
    .execute();
  return getHumanTaskById(businessId, id);
}
/** Set the support category (billing/technical/emergency/complaint/other) on a human task — Phase 2 / Chunk F. */
export async function updateHumanTaskCategory(businessId: string, id: string, category: string): Promise<typeof s.humanTasks.$inferSelect | null> {
  const existing = await getHumanTaskById(businessId, id);
  if (!existing) return null;
  await getDb()
    .update(s.humanTasks)
    .set({ category, updatedAt: now() })
    .where(and(eq(s.humanTasks.id, id), eq(s.humanTasks.businessId, businessId)))
    .execute();
  return getHumanTaskById(businessId, id);
}
// ---------------------------------------------------------------------------
// Invoices (dogfooding Phase 2 / Chunk H — invoice reminders, automation #10)
// ---------------------------------------------------------------------------

export interface NewInvoice {
  customerName: string;
  customerEmail: string;
  amountCents: number;
  dueAt: number;
  status?: (typeof s.INVOICE_STATUSES)[number];
}

/** Create an invoice row (tenant-scoped). The `create_invoice` tool is the ONLY app path here — it also emits INVOICE_CREATED. */
export async function createInvoice(businessId: string, data: NewInvoice) {
  const t = now();
  const id = newId();
  await getDb()
    .insert(s.invoices)
    .values({
      id,
      businessId,
      customerName: data.customerName,
      customerEmail: data.customerEmail,
      amountCents: data.amountCents,
      dueAt: data.dueAt,
      status: data.status ?? "unpaid",
      createdAt: t,
      updatedAt: t,
    })
    .execute();
  return getInvoiceById(businessId, id);
}

export async function getInvoiceById(businessId: string, id: string) {
  const rows = await getDb().select().from(s.invoices).where(and(eq(s.invoices.id, id), eq(s.invoices.businessId, businessId))).execute();
  return rows[0] ?? null;
}

export async function listInvoicesByBusiness(businessId: string, limit = 100) {
  return await getDb().select().from(s.invoices).where(eq(s.invoices.businessId, businessId)).orderBy(asc(s.invoices.dueAt)).limit(limit).execute();
}

export async function updateInvoice(businessId: string, id: string, patch: Partial<typeof s.invoices.$inferInsert>) {
  const existing = await getInvoiceById(businessId, id);
  if (!existing) return null;
  await getDb().update(s.invoices).set({ ...patch, updatedAt: now() }).where(and(eq(s.invoices.id, id), eq(s.invoices.businessId, businessId))).execute();
  return getInvoiceById(businessId, id);
}

/**
 * Cancel the pending invoice-reminder follow-up row + run for an invoice
 * (Chunk H). Called when the invoice is marked paid or cancelled so a settled
 * invoice is NEVER reminded; the send path also re-checks at fire time
 * (invoiceStillUnpaid) as a second guard.
 */
export async function cancelInvoiceReminderFollowUp(businessId: string, invoiceId: string): Promise<number> {
  const rows = await getDb()
    .select()
    .from(s.followUps)
    .where(and(eq(s.followUps.businessId, businessId), eq(s.followUps.templateKey, "invoice_reminder"), sql`${s.followUps.status} IN ('pending', 'paused')`))
    .execute();
  let cancelled = 0;
  for (const r of rows) {
    const run = await getRunForFollowUp(r.id);
    let payload: Record<string, unknown> = {};
    if (run) {
      try {
        payload = JSON.parse(run.payloadJson || "{}");
      } catch {
        /* unparsable — treat as matching (cancel) */
      }
    }
    if (payload.invoiceId !== invoiceId) continue;
    await getDb().update(s.followUps).set({ status: "cancelled", updatedAt: now() }).where(eq(s.followUps.id, r.id)).execute();
    if (run && ["pending", "running"].includes(run.status)) {
      await getDb().update(s.automationRuns).set({ status: "cancelled", updatedAt: now() }).where(eq(s.automationRuns.id, run.id)).execute();
    }
    cancelled += 1;
  }
  return cancelled;
}

/** Mark an invoice paid (future payment webhook path) and cancel its pending reminder. */
export async function markInvoicePaid(businessId: string, id: string) {
  const updated = await updateInvoice(businessId, id, { status: "paid" });
  if (updated) await cancelInvoiceReminderFollowUp(businessId, id);
  return updated;
}

/** Mark an invoice cancelled and cancel its pending reminder. */
export async function markInvoiceCancelled(businessId: string, id: string) {
  const updated = await updateInvoice(businessId, id, { status: "cancelled" });
  if (updated) await cancelInvoiceReminderFollowUp(businessId, id);
  return updated;
}

// ---------------------------------------------------------------------------
// Website widget settings (spec §14)
// ---------------------------------------------------------------------------

export interface WidgetSettings {
  id: string;
  businessId: string;
  enabled: number;
  primaryColor: string;
  position: s.WidgetPosition;
  welcomeMessage: string;
  logoUrl: string;
}

export const DEFAULT_WIDGET_SETTINGS = {
  enabled: 1,
  primaryColor: "#4f46e5",
  position: "bottom-right" as s.WidgetPosition,
  welcomeMessage: "",
  logoUrl: "",
};

/** Read a business's widget settings; returns defaults when no row exists (never writes). */
export async function getWidgetSettings(businessId: string): Promise<WidgetSettings> {
  const rows = await getDb().select().from(s.widgetSettings).where(eq(s.widgetSettings.businessId, businessId)).execute();
  if (rows[0]) {
    return {
      id: rows[0].id,
      businessId: rows[0].businessId,
      enabled: rows[0].enabled,
      primaryColor: rows[0].primaryColor,
      position: rows[0].position,
      welcomeMessage: rows[0].welcomeMessage ?? "",
      logoUrl: rows[0].logoUrl ?? "",
    };
  }
  return { id: "", businessId, ...DEFAULT_WIDGET_SETTINGS };
}

/** Create a row with defaults (idempotent) — used at business creation + seed. */
export async function ensureWidgetSettings(businessId: string): Promise<WidgetSettings> {
  const existing = await getDb().select().from(s.widgetSettings).where(eq(s.widgetSettings.businessId, businessId)).execute();
  if (existing[0]) return getWidgetSettings(businessId);
  const t = now();
  await getDb()
    .insert(s.widgetSettings)
    .values({ id: newId(), businessId, ...DEFAULT_WIDGET_SETTINGS, createdAt: t, updatedAt: t })
    .execute();
  return getWidgetSettings(businessId);
}

export async function saveWidgetSettings(businessId: string, patch: { enabled?: number; primaryColor?: string; position?: s.WidgetPosition; welcomeMessage?: string; logoUrl?: string }) {
  const existing = await getDb().select().from(s.widgetSettings).where(eq(s.widgetSettings.businessId, businessId)).execute();
  const t = now();
  if (existing[0]) {
    await getDb().update(s.widgetSettings).set({ ...patch, updatedAt: t }).where(eq(s.widgetSettings.id, existing[0].id)).execute();
  } else {
    await getDb()
      .insert(s.widgetSettings)
      .values({ id: newId(), businessId, ...DEFAULT_WIDGET_SETTINGS, ...patch, createdAt: t, updatedAt: t })
      .execute();
  }
  return getWidgetSettings(businessId);
}

// ---------------------------------------------------------------------------
// Integrations / subscriptions
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// AI agent config (spec §38 — owner-configured receptionist behavior)
// ---------------------------------------------------------------------------
export type EscalationSensitivity = "Conservative" | "Balanced" | "Aggressive";
export type AiTone = "Professional" | "Friendly" | "Casual" | "Concise";
export type AiResponseLength = "Short" | "Medium" | "Detailed";
/** Legacy stored values (pre-Brain-5a) — accepted everywhere and normalized. */
export type LegacyEscalationSensitivity = "low" | "medium" | "high";
export interface AiConfig {
  /** AI replies to lead messages automatically (default true). */
  autoRespond: boolean;
  /** The receptionist's name — shown in chat UI, widget header, signatures. */
  agentName: string;
  /** Reply phrasing style (spec §38). */
  tone: AiTone;
  /** Reply verbosity (spec §38). */
  responseLength: AiResponseLength;
  /** How readily the receptionist escalates to a human (spec §38). */
  escalationSensitivity: EscalationSensitivity;
  /** Extra owner-defined phrases that must escalate (always honored). */
  escalationKeywords: string[];
  /** Monthly usage budget in cents (spec §32); alerts at 80/90/100%. */
  monthlyBudgetCents: number;
}
export const DEFAULT_AI_CONFIG: AiConfig = {
  autoRespond: true,
  agentName: "Sarah",
  tone: "Professional",
  responseLength: "Medium",
  escalationSensitivity: "Balanced",
  escalationKeywords: [],
  monthlyBudgetCents: 10_000, // $100/mo sane default — owner-adjustable
};
export const ESCALATION_SENSITIVITIES: EscalationSensitivity[] = ["Conservative", "Balanced", "Aggressive"];
export const AI_TONES: AiTone[] = ["Professional", "Friendly", "Casual", "Concise"];
export const AI_RESPONSE_LENGTHS: AiResponseLength[] = ["Short", "Medium", "Detailed"];
/** Backward-compat: old stored low/medium/high map onto the spec values. */
export function normalizeSensitivity(v: unknown): EscalationSensitivity {
  if (v === "Conservative" || v === "low") return "Conservative";
  if (v === "Balanced" || v === "medium") return "Balanced";
  if (v === "Aggressive" || v === "high") return "Aggressive";
  return DEFAULT_AI_CONFIG.escalationSensitivity;
}
function parseAiConfig(raw: string | null | undefined): AiConfig {
  if (!raw) return { ...DEFAULT_AI_CONFIG };
  try {
    const parsed = JSON.parse(raw) as Partial<AiConfig>;
    return {
      autoRespond: typeof parsed.autoRespond === "boolean" ? parsed.autoRespond : DEFAULT_AI_CONFIG.autoRespond,
      agentName:
        typeof parsed.agentName === "string" && parsed.agentName.trim().length > 0
          ? parsed.agentName.trim().slice(0, 60)
          : DEFAULT_AI_CONFIG.agentName,
      tone: AI_TONES.includes(parsed.tone as AiTone) ? (parsed.tone as AiTone) : DEFAULT_AI_CONFIG.tone,
      responseLength: AI_RESPONSE_LENGTHS.includes(parsed.responseLength as AiResponseLength)
        ? (parsed.responseLength as AiResponseLength)
        : DEFAULT_AI_CONFIG.responseLength,
      escalationSensitivity: normalizeSensitivity(parsed.escalationSensitivity),
      escalationKeywords: Array.isArray(parsed.escalationKeywords)
        ? parsed.escalationKeywords.filter((k): k is string => typeof k === "string" && k.trim().length > 0).map((k) => k.trim())
        : [],
      monthlyBudgetCents:
        typeof parsed.monthlyBudgetCents === "number" && Number.isFinite(parsed.monthlyBudgetCents) && parsed.monthlyBudgetCents >= 0
          ? Math.floor(parsed.monthlyBudgetCents)
          : DEFAULT_AI_CONFIG.monthlyBudgetCents,
    };
  } catch {
    return { ...DEFAULT_AI_CONFIG };
  }
}
/** Read the business's AI agent config (defaults when never saved). */
export async function getAiConfig(businessId: string): Promise<AiConfig> {
  const business = await getBusinessById(businessId);
  if (!business) return { ...DEFAULT_AI_CONFIG };
  const cfg = parseAiConfig(business.aiConfigJson);
  // Spec §39 platform global defaults: applied only where the business has NOT
  // customized the field (field absent from the stored config JSON). When the
  // admin has not changed the defaults this is a no-op (same values as
  // DEFAULT_AI_CONFIG), so existing behavior is untouched.
  if (!business.aiConfigJson) return cfg;
  try {
    const defaults = await getPlatformSetting<{ tone?: string; responseLength?: string; escalationSensitivity?: string }>("defaults");
    if (!defaults) return cfg;
    const raw = JSON.parse(business.aiConfigJson) as Record<string, unknown>;
    if (typeof raw.tone !== "string" && AI_TONES.includes(defaults.tone as AiTone)) cfg.tone = defaults.tone as AiTone;
    if (typeof raw.responseLength !== "string" && AI_RESPONSE_LENGTHS.includes(defaults.responseLength as AiResponseLength)) {
      cfg.responseLength = defaults.responseLength as AiResponseLength;
    }
    if (typeof raw.escalationSensitivity !== "string") cfg.escalationSensitivity = normalizeSensitivity(defaults.escalationSensitivity);
  } catch {
    /* fall back to business config alone */
  }
  return cfg;
}
/** Persist a partial AI config update; returns the merged config. */
export async function saveAiConfig(businessId: string, patch: Partial<AiConfig>): Promise<AiConfig> {
  const current = await getAiConfig(businessId);
  const next: AiConfig = {
    autoRespond: patch.autoRespond ?? current.autoRespond,
    agentName:
      typeof patch.agentName === "string" && patch.agentName.trim().length > 0
        ? patch.agentName.trim().slice(0, 60)
        : current.agentName,
    tone: AI_TONES.includes(patch.tone as AiTone) ? (patch.tone as AiTone) : current.tone,
    responseLength: AI_RESPONSE_LENGTHS.includes(patch.responseLength as AiResponseLength)
      ? (patch.responseLength as AiResponseLength)
      : current.responseLength,
    escalationSensitivity:
      patch.escalationSensitivity !== undefined ? normalizeSensitivity(patch.escalationSensitivity) : current.escalationSensitivity,
    escalationKeywords: patch.escalationKeywords ?? current.escalationKeywords,
    monthlyBudgetCents:
      typeof patch.monthlyBudgetCents === "number" && Number.isFinite(patch.monthlyBudgetCents) && patch.monthlyBudgetCents >= 0
        ? Math.floor(patch.monthlyBudgetCents)
        : current.monthlyBudgetCents,
  };
  await updateBusiness(businessId, { aiConfigJson: JSON.stringify(next) });
  return next;
}
// ---------------------------------------------------------------------------
// AI usage & cost tracking (spec §32) — rows written ONLY via the
// record_usage tool (audited, tenant-scoped); reads are tenant-scoped here.
// ---------------------------------------------------------------------------
export const USAGE_KINDS = s.USAGE_KINDS;
export type UsageKind = s.UsageKind;
export type UsageDirection = s.UsageDirection;
/** Start of the current UTC month (epoch ms) — the §32 rollup window. */
export function usageMonthStartMs(nowMs: number = Date.now()): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}
export function usageMonthEndMs(startMs: number): number {
  const d = new Date(startMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}
export interface NewUsageEvent {
  kind: UsageKind;
  direction: UsageDirection;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostCents?: number;
  meta?: Record<string, unknown>;
}
export async function recordUsageEvent(businessId: string, data: NewUsageEvent): Promise<void> {
  await getDb()
    .insert(s.usageEvents)
    .values({
      id: newId(),
      businessId,
      kind: data.kind,
      direction: data.direction,
      inputTokens: Math.max(0, Math.floor(data.inputTokens ?? 0)),
      outputTokens: Math.max(0, Math.floor(data.outputTokens ?? 0)),
      estimatedCostCents: Math.max(0, Math.floor(data.estimatedCostCents ?? 0)),
      metaJson: JSON.stringify(data.meta ?? {}),
      createdAt: now(),
    })
    .execute();
}
export interface MonthlyUsage {
  aiMessages: number;
  smsMessages: number;
  voiceMessages: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostCents: number;
}
/**
 * Roll up one business's usage for the month containing `startMs` (or the
 * current month). Tenant-scoped: only THIS business's rows are read.
 */
export async function getMonthlyUsage(businessId: string, startMs?: number): Promise<MonthlyUsage> {
  const start = startMs ?? usageMonthStartMs();
  const end = usageMonthEndMs(start);
  const rows = await getDb()
    .select()
    .from(s.usageEvents)
    .where(and(eq(s.usageEvents.businessId, businessId), gte(s.usageEvents.createdAt, start), lt(s.usageEvents.createdAt, end)))
    .execute();
  const usage: MonthlyUsage = { aiMessages: 0, smsMessages: 0, voiceMessages: 0, inputTokens: 0, outputTokens: 0, estimatedCostCents: 0 };
  for (const r of rows) {
    if (r.kind === "ai_message") usage.aiMessages += 1;
    else if (r.kind === "sms") usage.smsMessages += 1;
    else if (r.kind === "voice") usage.voiceMessages += 1;
    usage.inputTokens += r.inputTokens;
    usage.outputTokens += r.outputTokens;
    usage.estimatedCostCents += r.estimatedCostCents;
  }
  return usage;
}
/** Has any notification of this kind been created since `since`? (alert dedupe) */
export async function hasNotificationSince(businessId: string, kind: string, since: number): Promise<boolean> {
  const rows = await getDb()
    .select({ id: s.notifications.id })
    .from(s.notifications)
    .where(and(eq(s.notifications.businessId, businessId), eq(s.notifications.kind, kind), gte(s.notifications.createdAt, since)))
    .limit(1)
    .execute();
  return rows.length > 0;
}
export async function listIntegrations(businessId: string) {
  return await getDb().select().from(s.integrations).where(eq(s.integrations.businessId, businessId)).execute();
}

export async function setIntegrationStatus(businessId: string, provider: (typeof INTEGRATION_PROVIDERS)[number], status: (typeof s.INTEGRATION_STATUSES)[number], config: unknown = {}) {
  const existing = await getDb().select().from(s.integrations).where(and(eq(s.integrations.businessId, businessId), eq(s.integrations.provider, provider))).execute();
  const t = now();
  if (existing[0]) {
    await getDb().update(s.integrations).set({ status, configJson: JSON.stringify(config), updatedAt: t }).where(eq(s.integrations.id, existing[0].id)).execute();
  } else {
    await getDb().insert(s.integrations).values({ id: newId(), businessId, provider, status, configJson: JSON.stringify(config), createdAt: t, updatedAt: t }).execute();
  }
}

export async function getSubscription(businessId: string) {
  const rows = await getDb().select().from(s.subscriptions).where(eq(s.subscriptions.businessId, businessId)).execute();
  return rows[0] ?? null;
}

export async function setSubscriptionPlan(businessId: string, plan: (typeof PLAN_NAMES)[number], status?: (typeof s.SUBSCRIPTION_STATUSES)[number]) {
  const existing = await getSubscription(businessId);
  const t = now();
  if (existing) {
    await getDb().update(s.subscriptions).set({ plan, status: status ?? existing.status, updatedAt: t }).where(eq(s.subscriptions.businessId, businessId)).execute();
  } else {
    await getDb().insert(s.subscriptions).values({ id: newId(), businessId, plan, status: status ?? "trialing", createdAt: t, updatedAt: t }).execute();
  }
  return getSubscription(businessId);
}

// ---------------------------------------------------------------------------
// AI BRAIN 3 — events (spec §30), automation rules + runs (spec §29)
// ---------------------------------------------------------------------------

export async function createEvent(data: {
  businessId: string;
  type: s.EventType;
  leadId?: string | null;
  conversationId?: string | null;
  payload?: unknown;
  createdAt?: number;
}) {
  const t = data.createdAt ?? now();
  const id = newId();
  await getDb()
    .insert(s.events)
    .values({
      id,
      businessId: data.businessId,
      type: data.type,
      leadId: data.leadId ?? null,
      conversationId: data.conversationId ?? null,
      payloadJson: JSON.stringify(data.payload ?? {}),
      createdAt: t,
    })
    .execute();
  return id;
}

export async function listEvents(businessId: string, opts: { types?: s.EventType[]; since?: number; limit?: number } = {}) {
  const conds: SQL[] = [eq(s.events.businessId, businessId)];
  if (opts.types?.length) conds.push(inArray(s.events.type, opts.types));
  if (opts.since !== undefined) conds.push(gte(s.events.createdAt, opts.since));
  return await getDb()
    .select()
    .from(s.events)
    .where(and(...conds))
    .orderBy(desc(s.events.createdAt))
    .limit(opts.limit ?? 200)
    .execute();
}

export async function countEventsOfType(businessId: string, type: s.EventType, since?: number) {
  const conds: SQL[] = [eq(s.events.businessId, businessId), eq(s.events.type, type)];
  if (since !== undefined) conds.push(gte(s.events.createdAt, since));
  const rows = await getDb().select({ n: count() }).from(s.events).where(and(...conds)).execute();
  return rows[0]?.n ?? 0;
}

// --- automation rules -------------------------------------------------------

export interface AutomationRuleInput {
  name: string;
  triggerEvent?: s.EventType | "";
  delayMs?: number;
  condition?: unknown;
  action: string;
  actionConfig?: unknown;
  enabled?: boolean;
}

export async function createAutomationRule(businessId: string, data: AutomationRuleInput) {
  const t = now();
  const id = newId();
  await getDb()
    .insert(s.automationRules)
    .values({
      id,
      businessId,
      name: data.name,
      triggerEvent: data.triggerEvent ?? "",
      delayMs: data.delayMs ?? 0,
      conditionJson: JSON.stringify(data.condition ?? { type: "none" }),
      action: data.action,
      actionConfigJson: JSON.stringify(data.actionConfig ?? {}),
      enabled: data.enabled === false ? 0 : 1,
      createdAt: t,
      updatedAt: t,
    })
    .execute();
  return getAutomationRuleById(businessId, id);
}

export async function getAutomationRuleById(businessId: string, id: string) {
  const rows = await getDb().select().from(s.automationRules).where(and(eq(s.automationRules.id, id), eq(s.automationRules.businessId, businessId))).execute();
  return rows[0] ?? null;
}

export async function listAutomationRules(businessId: string) {
  return await getDb().select().from(s.automationRules).where(eq(s.automationRules.businessId, businessId)).orderBy(asc(s.automationRules.createdAt)).execute();
}

export async function countAutomationRules(businessId: string) {
  const rows = await getDb().select({ n: count() }).from(s.automationRules).where(eq(s.automationRules.businessId, businessId)).execute();
  return rows[0]?.n ?? 0;
}

export async function updateAutomationRule(businessId: string, id: string, patch: Partial<typeof s.automationRules.$inferInsert>) {
  const existing = await getAutomationRuleById(businessId, id);
  if (!existing) return null;
  await getDb()
    .update(s.automationRules)
    .set({ ...patch, updatedAt: now() })
    .where(and(eq(s.automationRules.id, id), eq(s.automationRules.businessId, businessId)))
    .execute();
  return getAutomationRuleById(businessId, id);
}

/** Enabled rules subscribed to an event (spec §30: agents subscribe to events). */
export async function getAutomationRulesForEvent(businessId: string, eventType: s.EventType) {
  return await getDb()
    .select()
    .from(s.automationRules)
    .where(and(eq(s.automationRules.businessId, businessId), eq(s.automationRules.triggerEvent, eventType), eq(s.automationRules.enabled, 1)))
    .orderBy(asc(s.automationRules.createdAt))
    .execute();
}

// --- automation runs --------------------------------------------------------

export interface NewAutomationRun {
  businessId: string;
  leadId?: string | null;
  ruleId?: string | null;
  ruleKind: string;
  runAt: number;
  payload?: unknown;
  attempts?: number;
}

export async function createAutomationRun(data: NewAutomationRun) {
  const t = now();
  const id = newId();
  await getDb()
    .insert(s.automationRuns)
    .values({
      id,
      businessId: data.businessId,
      leadId: data.leadId ?? null,
      ruleId: data.ruleId ?? null,
      ruleKind: data.ruleKind,
      runAt: data.runAt,
      status: "pending",
      payloadJson: JSON.stringify(data.payload ?? {}),
      attempts: data.attempts ?? 0,
      lastError: "",
      createdAt: t,
      updatedAt: t,
    })
    .execute();
  return getAutomationRunById(data.businessId, id);
}

export async function getAutomationRunById(businessId: string, id: string) {
  const rows = await getDb().select().from(s.automationRuns).where(and(eq(s.automationRuns.id, id), eq(s.automationRuns.businessId, businessId))).execute();
  return rows[0] ?? null;
}

export async function updateAutomationRun(businessId: string, id: string, patch: Partial<typeof s.automationRuns.$inferInsert>) {
  const existing = await getAutomationRunById(businessId, id);
  if (!existing) return null;
  await getDb()
    .update(s.automationRuns)
    .set({ ...patch, updatedAt: now() })
    .where(and(eq(s.automationRuns.id, id), eq(s.automationRuns.businessId, businessId)))
    .execute();
  return getAutomationRunById(businessId, id);
}

export async function listAutomationRuns(businessId: string, limit = 200) {
  return await getDb()
    .select()
    .from(s.automationRuns)
    .where(eq(s.automationRuns.businessId, businessId))
    .orderBy(desc(s.automationRuns.createdAt))
    .limit(limit)
    .execute();
}

/** Due pending runs for the worker (oldest first) — delayed/scheduled runs
 *  survive restarts because they are picked from the DB on every tick. */
export async function listDueAutomationRuns(limit = 100, nowMs = now()) {
  return await getDb()
    .select()
    .from(s.automationRuns)
    .where(and(eq(s.automationRuns.status, "pending"), sql`${s.automationRuns.runAt} <= ${nowMs}`))
    .orderBy(asc(s.automationRuns.runAt))
    .limit(limit)
    .execute();
}

/** Stale `running` rows (a process died mid-run) get retried or failed. */
export async function listStuckAutomationRuns(limit = 50) {
  return await getDb()
    .select()
    .from(s.automationRuns)
    .where(eq(s.automationRuns.status, "running"))
    .limit(limit)
    .execute();
}

/** The follow-up step run for a follow_up row (payload carries the followUpId). */
export async function getRunForFollowUp(followUpId: string) {
  const rows = await getDb()
    .select()
    .from(s.automationRuns)
    .where(sql`${s.automationRuns.payloadJson} LIKE ${`%${followUpId}%`}`)
    .limit(10)
    .execute();
  return rows[0] ?? null;
}

/** All pending follow-up rows (the backfill safety net creates a run for any
 *  pre-Brain-3 row that was scheduled before the automation engine existed). */
export async function listPendingFollowUps(limit = 500) {
  return await getDb()
    .select()
    .from(s.followUps)
    .where(eq(s.followUps.status, "pending"))
    .orderBy(asc(s.followUps.scheduledFor))
    .limit(limit)
    .execute();
}

/** Cancel a lead's pending automation runs (stop rules: booked / customer /
 *  opt-out / manual stop). Follow-up step runs are cancelled alongside their
 *  follow_up rows by cancelFollowUpsForLead. */
export async function cancelAutomationRunsForLead(businessId: string, leadId: string) {
  const db = getDb();
  const rows = await db
    .select()
    .from(s.automationRuns)
    .where(and(eq(s.automationRuns.businessId, businessId), eq(s.automationRuns.leadId, leadId), inArray(s.automationRuns.status, ["pending", "running"])))
    .execute();
  for (const r of rows) {
    await db.update(s.automationRuns).set({ status: "cancelled", updatedAt: now() }).where(eq(s.automationRuns.id, r.id)).execute();
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// AI BRAIN 4 — review config + feedback records (spec §21)
// ---------------------------------------------------------------------------

export interface ReviewConfig {
  id: string;
  businessId: string;
  enabled: number;
  delayDays: number;
  reviewUrl: string;
}

export const DEFAULT_REVIEW_CONFIG: Omit<ReviewConfig, "id" | "businessId"> = {
  enabled: 1,
  delayDays: 1,
  reviewUrl: "",
};

export async function getReviewConfig(businessId: string): Promise<ReviewConfig> {
  const rows = await getDb().select().from(s.reviewConfigs).where(eq(s.reviewConfigs.businessId, businessId)).execute();
  if (rows[0]) {
    return {
      id: rows[0].id,
      businessId: rows[0].businessId,
      enabled: rows[0].enabled,
      delayDays: rows[0].delayDays,
      reviewUrl: rows[0].reviewUrl ?? "",
    };
  }
  return { id: "", businessId, ...DEFAULT_REVIEW_CONFIG };
}

/** Create a review config row with defaults when absent (idempotent — never overwrites). */
export async function ensureReviewConfig(businessId: string): Promise<ReviewConfig> {
  const existing = await getDb().select().from(s.reviewConfigs).where(eq(s.reviewConfigs.businessId, businessId)).execute();
  if (existing[0]) return getReviewConfig(businessId);
  const t = now();
  await getDb()
    .insert(s.reviewConfigs)
    .values({ id: newId(), businessId, ...DEFAULT_REVIEW_CONFIG, createdAt: t, updatedAt: t })
    .execute();
  return getReviewConfig(businessId);
}

export async function saveReviewConfig(businessId: string, patch: { enabled?: boolean; delayDays?: number; reviewUrl?: string }): Promise<ReviewConfig> {
  const current = await ensureReviewConfig(businessId);
  const t = now();
  const next = {
    enabled: patch.enabled === undefined ? current.enabled : patch.enabled ? 1 : 0,
    delayDays: patch.delayDays !== undefined ? Math.max(0, Math.min(90, Math.round(patch.delayDays))) : current.delayDays,
    reviewUrl: patch.reviewUrl !== undefined ? patch.reviewUrl.trim().slice(0, 500) : current.reviewUrl,
  };
  await getDb()
    .update(s.reviewConfigs)
    .set({ ...next, updatedAt: t })
    .where(eq(s.reviewConfigs.businessId, businessId))
    .execute();
  return getReviewConfig(businessId);
}

export interface NewReview {
  businessId: string;
  leadId: string;
  appointmentId?: string | null;
  reviewRequestSentAt?: number;
}

export async function createReview(data: NewReview) {
  const t = now();
  const id = newId();
  await getDb()
    .insert(s.reviews)
    .values({
      id,
      businessId: data.businessId,
      leadId: data.leadId,
      appointmentId: data.appointmentId ?? null,
      feedbackText: "",
      sentiment: "unknown",
      reviewRequestSentAt: data.reviewRequestSentAt ?? null,
      reviewLinkSentAt: null,
      createdAt: t,
      updatedAt: t,
    })
    .execute();
  return getReviewById(data.businessId, id);
}

export async function getReviewById(businessId: string, id: string) {
  const rows = await getDb().select().from(s.reviews).where(and(eq(s.reviews.id, id), eq(s.reviews.businessId, businessId))).execute();
  return rows[0] ?? null;
}

export async function getReviewForAppointment(businessId: string, appointmentId: string) {
  const rows = await getDb().select().from(s.reviews).where(and(eq(s.reviews.businessId, businessId), eq(s.reviews.appointmentId, appointmentId))).execute();
  return rows[0] ?? null;
}

/** The open feedback record for a lead: a request was sent, no feedback yet. */
export async function getOpenReviewForLead(businessId: string, leadId: string) {
  const rows = await getDb()
    .select()
    .from(s.reviews)
    .where(
      and(
        eq(s.reviews.businessId, businessId),
        eq(s.reviews.leadId, leadId),
        eq(s.reviews.sentiment, "unknown"),
        sql`${s.reviews.reviewRequestSentAt} IS NOT NULL`
      )
    )
    .orderBy(desc(s.reviews.createdAt))
    .limit(1)
    .execute();
  return rows[0] ?? null;
}

export async function updateReview(businessId: string, id: string, patch: Partial<typeof s.reviews.$inferInsert>) {
  const existing = await getReviewById(businessId, id);
  if (!existing) return null;
  await getDb().update(s.reviews).set({ ...patch, updatedAt: now() }).where(and(eq(s.reviews.id, id), eq(s.reviews.businessId, businessId))).execute();
  return getReviewById(businessId, id);
}

/** Recent feedback records joined with lead names for the Reviews surface. */
export interface ReviewListItem {
  review: typeof s.reviews.$inferSelect;
  lead: (typeof s.leads.$inferSelect) | null;
  serviceName: string | null;
}

export async function listReviews(businessId: string, limit = 100): Promise<ReviewListItem[]> {
  return await getDb()
    .select({ review: s.reviews, lead: s.leads, serviceName: s.services.name })
    .from(s.reviews)
    .leftJoin(s.leads, eq(s.reviews.leadId, s.leads.id))
    .leftJoin(s.appointments, eq(s.reviews.appointmentId, s.appointments.id))
    .leftJoin(s.services, eq(s.appointments.serviceId, s.services.id))
    .where(eq(s.reviews.businessId, businessId))
    .orderBy(desc(s.reviews.createdAt))
    .limit(limit)
    .execute();
}

// ---------------------------------------------------------------------------
// AI BRAIN 4 — business intelligence reports (spec §22) + daily ops reports
// (dogfooding #9, Chunk G). Shared storage: business_reports with a `type`
// discriminator ('weekly' default / 'daily'). week_start holds the period
// start (Monday 00:00 UTC for weekly, midnight UTC for daily).
// ---------------------------------------------------------------------------

export const WEEKLY_REPORT_TYPE = "weekly";
export const DAILY_REPORT_TYPE = "daily";

export async function getWeeklyReport(businessId: string, weekStart: number) {
  const rows = await getDb()
    .select()
    .from(s.businessReports)
    .where(and(eq(s.businessReports.businessId, businessId), eq(s.businessReports.type, WEEKLY_REPORT_TYPE), eq(s.businessReports.weekStart, weekStart)))
    .execute();
  return rows[0] ?? null;
}

export async function getDailyReport(businessId: string, dayStart: number) {
  const rows = await getDb()
    .select()
    .from(s.businessReports)
    .where(and(eq(s.businessReports.businessId, businessId), eq(s.businessReports.type, DAILY_REPORT_TYPE), eq(s.businessReports.weekStart, dayStart)))
    .execute();
  return rows[0] ?? null;
}

export async function getWeeklyReportById(businessId: string, id: string) {
  const rows = await getDb().select().from(s.businessReports).where(and(eq(s.businessReports.businessId, businessId), eq(s.businessReports.id, id), eq(s.businessReports.type, WEEKLY_REPORT_TYPE))).execute();
  return rows[0] ?? null;
}

export async function listWeeklyReports(businessId: string, limit = 12) {
  return await getDb()
    .select()
    .from(s.businessReports)
    .where(and(eq(s.businessReports.businessId, businessId), eq(s.businessReports.type, WEEKLY_REPORT_TYPE)))
    .orderBy(desc(s.businessReports.weekStart))
    .limit(limit)
    .execute();
}

export async function listDailyReports(businessId: string, limit = 12) {
  return await getDb()
    .select()
    .from(s.businessReports)
    .where(and(eq(s.businessReports.businessId, businessId), eq(s.businessReports.type, DAILY_REPORT_TYPE)))
    .orderBy(desc(s.businessReports.weekStart))
    .limit(limit)
    .execute();
}

/** Upsert a weekly report for a business+week (idempotent — regenerating a
 *  week replaces the stored report). */
export async function upsertWeeklyReport(businessId: string, weekStart: number, metrics: unknown, narrative: unknown) {
  const t = now();
  const existing = await getWeeklyReport(businessId, weekStart);
  if (existing) {
    await getDb()
      .update(s.businessReports)
      .set({ metricsJson: JSON.stringify(metrics), narrativeJson: JSON.stringify(narrative), createdAt: t })
      .where(eq(s.businessReports.id, existing.id))
      .execute();
    return getWeeklyReport(businessId, weekStart)!;
  }
  await getDb()
    .insert(s.businessReports)
    .values({ id: newId(), businessId, type: WEEKLY_REPORT_TYPE, weekStart, metricsJson: JSON.stringify(metrics), narrativeJson: JSON.stringify(narrative), createdAt: t })
    .execute();
  return getWeeklyReport(businessId, weekStart)!;
}

/** Upsert a daily ops report for a business+day (idempotent — regenerating a
 *  day replaces the stored report; the (business_id, type, week_start) unique
 *  index guarantees one row per business+day). */
export async function upsertDailyReport(businessId: string, dayStart: number, metrics: unknown, narrative: unknown) {
  const t = now();
  const existing = await getDailyReport(businessId, dayStart);
  if (existing) {
    await getDb()
      .update(s.businessReports)
      .set({ metricsJson: JSON.stringify(metrics), narrativeJson: JSON.stringify(narrative), createdAt: t })
      .where(eq(s.businessReports.id, existing.id))
      .execute();
    return getDailyReport(businessId, dayStart)!;
  }
  await getDb()
    .insert(s.businessReports)
    .values({ id: newId(), businessId, type: DAILY_REPORT_TYPE, weekStart: dayStart, metricsJson: JSON.stringify(metrics), narrativeJson: JSON.stringify(narrative), createdAt: t })
    .execute();
  return getDailyReport(businessId, dayStart)!;
}

// ---------------------------------------------------------------------------
// Week-scoped reads (used by the Business Intelligence agent)
// ---------------------------------------------------------------------------

export async function listLeadsCreatedBetween(businessId: string, start: number, end: number) {
  return await getDb()
    .select()
    .from(s.leads)
    .where(and(eq(s.leads.businessId, businessId), gte(s.leads.createdAt, start), sql`${s.leads.createdAt} < ${end}`))
    .execute();
}

export async function listAppointmentsCreatedBetween(businessId: string, start: number, end: number) {
  return await getDb()
    .select()
    .from(s.appointments)
    .where(and(eq(s.appointments.businessId, businessId), gte(s.appointments.createdAt, start), sql`${s.appointments.createdAt} < ${end}`))
    .execute();
}

export async function listMessagesBetween(businessId: string, start: number, end: number) {
  return await getDb()
    .select()
    .from(s.messages)
    .where(and(eq(s.messages.businessId, businessId), gte(s.messages.createdAt, start), sql`${s.messages.createdAt} < ${end}`))
    .orderBy(asc(s.messages.createdAt))
    .execute();
}

export async function listConversationsBetween(businessId: string, start: number, end: number) {
  return await getDb()
    .select()
    .from(s.conversations)
    .where(and(eq(s.conversations.businessId, businessId), gte(s.conversations.createdAt, start), sql`${s.conversations.createdAt} < ${end}`))
    .execute();
}

export async function listFollowUpsBetween(businessId: string, start: number, end: number) {
  return await getDb()
    .select()
    .from(s.followUps)
    .where(and(eq(s.followUps.businessId, businessId), gte(s.followUps.scheduledFor, start), sql`${s.followUps.scheduledFor} < ${end}`))
    .execute();
}

// ---------------------------------------------------------------------------
// Prospect-scoped reads (daily ops report — dogfooding #9 / Chunk G).
// Bounded by an explicit lead-id set so the report scans only the campaign's
// rows, never the whole business. All-time (0, now) is intentional: the daily
// report mixes one day's numbers with campaign totals-to-date.
// ---------------------------------------------------------------------------

/** Appointments whose lead is in `leadIds` (all time). */
export async function listAppointmentsByLeadIds(businessId: string, leadIds: string[]) {
  if (!leadIds.length) return [];
  return await getDb()
    .select()
    .from(s.appointments)
    .where(and(eq(s.appointments.businessId, businessId), inArray(s.appointments.leadId, leadIds)))
    .execute();
}

/** Follow-ups whose lead is in `leadIds` (all time). */
export async function listFollowUpsByLeadIds(businessId: string, leadIds: string[]) {
  if (!leadIds.length) return [];
  return await getDb()
    .select()
    .from(s.followUps)
    .where(and(eq(s.followUps.businessId, businessId), inArray(s.followUps.leadId, leadIds)))
    .execute();
}

/** Conversations whose lead is in `leadIds` (all time). */
export async function listConversationsByLeadIds(businessId: string, leadIds: string[]) {
  if (!leadIds.length) return [];
  return await getDb()
    .select()
    .from(s.conversations)
    .where(and(eq(s.conversations.businessId, businessId), inArray(s.conversations.leadId, leadIds)))
    .execute();
}

/** Messages in the given conversations within [start, end). */
export async function listMessagesForConversations(businessId: string, conversationIds: string[], start: number, end: number) {
  if (!conversationIds.length) return [];
  return await getDb()
    .select()
    .from(s.messages)
    .where(and(eq(s.messages.businessId, businessId), inArray(s.messages.conversationId, conversationIds), gte(s.messages.createdAt, start), sql`${s.messages.createdAt} < ${end}`))
    .orderBy(asc(s.messages.createdAt))
    .execute();
}

export async function listReviewsBetween(businessId: string, start: number, end: number) {
  return await getDb()
    .select()
    .from(s.reviews)
    .where(and(eq(s.reviews.businessId, businessId), gte(s.reviews.reviewRequestSentAt ?? 0, start), sql`${s.reviews.reviewRequestSentAt ?? 0} < ${end}`))
    .execute();
}

// ---------------------------------------------------------------------------
// AI BRAIN 5b — platform settings (spec §39), savings assumptions (§37),
// and metric helpers (§36) — see also src/server/ai/perf.ts + platform/settings.ts
// ---------------------------------------------------------------------------

/** Read a platform settings row's parsed JSON value (null when never set). */
export async function getPlatformSetting<T = Record<string, unknown>>(key: string): Promise<T | null> {
  const rows = await getDb().select().from(s.platformSettings).where(eq(s.platformSettings.key, key)).limit(1).execute();
  if (!rows[0]) return null;
  try {
    return JSON.parse(rows[0].valueJson) as T;
  } catch {
    return null;
  }
}

/** Upsert a platform settings row (admin-only callers — enforced in routes). */
export async function setPlatformSetting(key: string, value: unknown): Promise<void> {
  const existing = await getDb().select().from(s.platformSettings).where(eq(s.platformSettings.key, key)).limit(1).execute();
  const t = now();
  if (existing[0]) {
    await getDb().update(s.platformSettings).set({ valueJson: JSON.stringify(value), updatedAt: t }).where(eq(s.platformSettings.id, existing[0].id)).execute();
  } else {
    await getDb().insert(s.platformSettings).values({ id: newId(), key, valueJson: JSON.stringify(value), updatedAt: t }).execute();
  }
}

// --- Owner dashboard savings assumptions (§37) — stored in policiesJson.aiSavings
// (merged, never overwritten — the policies/welcome writers both spread).

export interface SavingsAssumptions {
  /** Cost per hour of a human receptionist (cents) — configured assumption. */
  humanHourlyCostCents: number;
  /** Minutes a human would spend handling one AI-resolved conversation. */
  minutesPerConversation: number;
}

export const DEFAULT_SAVINGS_ASSUMPTIONS: SavingsAssumptions = {
  humanHourlyCostCents: 3000, // $30/hr
  minutesPerConversation: 8,
};

/** Owner-configured savings assumptions (spec §37 — always labeled estimates). */
export async function getSavingsAssumptions(businessId: string): Promise<SavingsAssumptions> {
  const business = await getBusinessById(businessId);
  if (!business) return { ...DEFAULT_SAVINGS_ASSUMPTIONS };
  try {
    const policies = JSON.parse(business.policiesJson || "{}") as { aiSavings?: Partial<SavingsAssumptions> };
    const s = policies.aiSavings ?? {};
    return {
      humanHourlyCostCents:
        typeof s.humanHourlyCostCents === "number" && Number.isFinite(s.humanHourlyCostCents) && s.humanHourlyCostCents >= 0
          ? Math.floor(s.humanHourlyCostCents)
          : DEFAULT_SAVINGS_ASSUMPTIONS.humanHourlyCostCents,
      minutesPerConversation:
        typeof s.minutesPerConversation === "number" && Number.isFinite(s.minutesPerConversation) && s.minutesPerConversation >= 0
          ? Math.floor(s.minutesPerConversation)
          : DEFAULT_SAVINGS_ASSUMPTIONS.minutesPerConversation,
    };
  } catch {
    return { ...DEFAULT_SAVINGS_ASSUMPTIONS };
  }
}

/** Persist savings assumptions (merged into policiesJson — never a full overwrite). */
export async function saveSavingsAssumptions(businessId: string, patch: Partial<SavingsAssumptions>): Promise<SavingsAssumptions> {
  const current = await getSavingsAssumptions(businessId);
  const next: SavingsAssumptions = {
    humanHourlyCostCents:
      typeof patch.humanHourlyCostCents === "number" && Number.isFinite(patch.humanHourlyCostCents) && patch.humanHourlyCostCents >= 0
        ? Math.floor(patch.humanHourlyCostCents)
        : current.humanHourlyCostCents,
    minutesPerConversation:
      typeof patch.minutesPerConversation === "number" && Number.isFinite(patch.minutesPerConversation) && patch.minutesPerConversation >= 0
        ? Math.floor(patch.minutesPerConversation)
        : current.minutesPerConversation,
  };
  const business = await getBusinessById(businessId);
  if (business) {
    const policies = JSON.parse(business.policiesJson || "{}") as Record<string, unknown>;
    await updateBusiness(businessId, { policiesJson: JSON.stringify({ ...policies, aiSavings: next }) });
  }
  return next;
}

/** Human escalation tasks created in [start, end) — used by the perf dashboard. */
export async function listHumanTasksBetween(businessId: string, start: number, end: number) {
  return await getDb()
    .select()
    .from(s.humanTasks)
    .where(and(eq(s.humanTasks.businessId, businessId), gte(s.humanTasks.createdAt, start), sql`${s.humanTasks.createdAt} < ${end}`))
    .execute();
}

/** Failed automation runs (any business) — admin health (§39) / system health (§40). */
export async function listFailedAutomationRuns(limit = 50, sinceMs?: number) {
  const conds: SQL[] = [eq(s.automationRuns.status, "failed")];
  if (sinceMs !== undefined) conds.push(gte(s.automationRuns.createdAt, sinceMs));
  return await getDb().select().from(s.automationRuns).where(and(...conds)).orderBy(desc(s.automationRuns.createdAt)).limit(limit).execute();
}

export type { SQL };

export async function getDailyReportById(businessId: string, id: string) {
  const rows = await getDb().select().from(s.businessReports).where(and(eq(s.businessReports.businessId, businessId), eq(s.businessReports.id, id), eq(s.businessReports.type, DAILY_REPORT_TYPE))).execute();
  return rows[0] ?? null;
}
