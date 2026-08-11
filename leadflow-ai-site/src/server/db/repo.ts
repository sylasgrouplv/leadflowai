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
import { and, asc, count, desc, eq, gte, inArray, sql, type SQL } from "drizzle-orm";
import { getDb } from "./client";
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
  db.insert(s.users)
    .values({ id, email: u.email.toLowerCase(), passwordHash: u.passwordHash, name: u.name, role: u.role ?? "owner", createdAt: t, updatedAt: t })
    .run();
  return getUserById(id);
}

export async function getUserByEmail(email: string) {
  const rows = getDb().select().from(s.users).where(eq(s.users.email, email.toLowerCase())).all();
  return rows[0] ?? null;
}

export async function getUserById(id: string) {
  const rows = getDb().select().from(s.users).where(eq(s.users.id, id)).all();
  return rows[0] ?? null;
}

export async function insertSession(id: string, userId: string, tokenHash: string, expiresAt: number) {
  getDb()
    .insert(s.sessions)
    .values({ id, userId, tokenHash, expiresAt, createdAt: now() })
    .run();
}

export async function getSessionByTokenHash(tokenHash: string) {
  const rows = getDb().select().from(s.sessions).where(eq(s.sessions.tokenHash, tokenHash)).all();
  return rows[0] ?? null;
}

export async function deleteSession(id: string) {
  getDb().delete(s.sessions).where(eq(s.sessions.id, id)).run();
}

export async function deleteExpiredSessions() {
  getDb().delete(s.sessions).where(sql`${s.sessions.expiresAt} < ${now()}`).run();
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
  db.transaction((tx) => {
    tx.insert(s.businesses)
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
      .run();
    tx.insert(s.teamMembers).values({ id: newId(), businessId: id, userId: b.ownerId, role: "owner", createdAt: t }).run();
    // Every business starts with an integration row per provider (mock status
    // until connected) and a trialing subscription row.
    for (const provider of s.INTEGRATION_PROVIDERS) {
      tx.insert(s.integrations)
        .values({ id: newId(), businessId: id, provider, status: "not_configured", createdAt: t, updatedAt: t })
        .run();
    }
    tx.insert(s.subscriptions)
      .values({ id: newId(), businessId: id, plan: "starter", status: "trialing", createdAt: t, updatedAt: t })
      .run();
    tx.insert(s.widgetSettings)
      .values({ id: newId(), businessId: id, ...DEFAULT_WIDGET_SETTINGS, createdAt: t, updatedAt: t })
      .run();
  });
  return getBusinessById(id);
}

export async function getBusinessById(id: string) {
  const rows = getDb().select().from(s.businesses).where(eq(s.businesses.id, id)).all();
  return rows[0] ?? null;
}

/** The first business the user belongs to (via team_members). */
export async function getBusinessForUser(userId: string) {
  const rows = getDb()
    .select({ business: s.businesses })
    .from(s.teamMembers)
    .innerJoin(s.businesses, eq(s.teamMembers.businessId, s.businesses.id))
    .where(eq(s.teamMembers.userId, userId))
    .all();
  return rows[0]?.business ?? null;
}

export async function listAllBusinessIds() {
  const rows = getDb().select({ id: s.businesses.id }).from(s.businesses).all();
  return rows.map((r) => r.id);
}

export async function updateBusiness(id: string, patch: Partial<typeof s.businesses.$inferInsert>) {
  const db = getDb();
  const existing = await getBusinessById(id);
  if (!existing) return null;
  db.update(s.businesses)
    .set({ ...patch, updatedAt: now() })
    .where(eq(s.businesses.id, id))
    .run();
  return getBusinessById(id);
}

export async function advanceOnboarding(id: string, toStep: number) {
  const db = getDb();
  const existing = await getBusinessById(id);
  if (!existing) return null;
  const next = Math.max(existing.onboardingStep, toStep);
  const completed = next >= 6 ? 1 : existing.onboardingCompleted;
  db.update(s.businesses)
    .set({ onboardingStep: next, onboardingCompleted: completed, updatedAt: now() })
    .where(eq(s.businesses.id, id))
    .run();
  return getBusinessById(id);
}

export async function addTeamMember(businessId: string, userId: string, role: UserRole) {
  const t = now();
  getDb()
    .insert(s.teamMembers)
    .values({ id: newId(), businessId, userId, role, createdAt: t })
    .run();
}

export async function listTeamMembers(businessId: string) {
  return getDb()
    .select({ id: s.teamMembers.id, role: s.teamMembers.role, userId: s.teamMembers.userId, name: s.users.name, email: s.users.email })
    .from(s.teamMembers)
    .innerJoin(s.users, eq(s.teamMembers.userId, s.users.id))
    .where(eq(s.teamMembers.businessId, businessId))
    .all();
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

export async function listServices(businessId: string) {
  return getDb().select().from(s.services).where(eq(s.services.businessId, businessId)).orderBy(asc(s.services.createdAt)).all();
}

export async function getServiceById(businessId: string, id: string) {
  const rows = getDb().select().from(s.services).where(and(eq(s.services.id, id), eq(s.services.businessId, businessId))).all();
  return rows[0] ?? null;
}

export async function addService(businessId: string, data: { name: string; description?: string; priceCents: number; durationMin: number; averageValueCents?: number }) {
  const t = now();
  const id = newId();
  getDb()
    .insert(s.services)
    .values({ id, businessId, name: data.name, description: data.description ?? "", priceCents: data.priceCents, durationMin: data.durationMin, averageValueCents: data.averageValueCents ?? 0, active: 1, createdAt: t, updatedAt: t })
    .run();
  return getServiceById(businessId, id);
}

export async function updateService(businessId: string, id: string, patch: Partial<typeof s.services.$inferInsert>) {
  const existing = await getServiceById(businessId, id);
  if (!existing) return null;
  getDb().update(s.services).set({ ...patch, updatedAt: now() }).where(and(eq(s.services.id, id), eq(s.services.businessId, businessId))).run();
  return getServiceById(businessId, id);
}

export async function deleteService(businessId: string, id: string) {
  getDb().delete(s.services).where(and(eq(s.services.id, id), eq(s.services.businessId, businessId))).run();
}

export async function replaceServices(businessId: string, items: { name: string; description?: string; priceCents: number; durationMin: number; averageValueCents?: number }[]) {
  const db = getDb();
  db.transaction((tx) => {
    tx.delete(s.services).where(eq(s.services.businessId, businessId)).run();
    for (const it of items) {
      const t = now();
      tx.insert(s.services)
        .values({ id: newId(), businessId, name: it.name, description: it.description ?? "", priceCents: it.priceCents, durationMin: it.durationMin, averageValueCents: it.averageValueCents ?? 0, active: 1, createdAt: t, updatedAt: t })
        .run();
    }
  });
  return listServices(businessId);
}

// ---------------------------------------------------------------------------
// Revenue attribution (spec §23)
// ---------------------------------------------------------------------------

/** Configured average job value for a service — falls back to priceCents when
 *  the owner hasn't set one (0 = "use list price"). Never a real revenue figure. */
export function effectiveServiceValue(service: { averageValueCents: number | null; priceCents: number } | null): number {
  if (!service) return 0;
  return service.averageValueCents && service.averageValueCents > 0 ? service.averageValueCents : service.priceCents;
}

/** Estimated revenue = booked/completed jobs × configured average job value
 *  (spec §23). Jobs = appointments with status booked/confirmed/completed.
 *  Callers MUST label this "Estimated Revenue" — it is an estimate, not actuals. */
export async function estimatedRevenueFromJobs(businessId: string): Promise<number> {
  const db = getDb();
  const appts = db
    .select()
    .from(s.appointments)
    .where(and(eq(s.appointments.businessId, businessId), sql`${s.appointments.status} IN ('booked','confirmed','completed')`))
    .all();
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
  return getDb().select().from(s.knowledgeBase).where(eq(s.knowledgeBase.businessId, businessId)).orderBy(asc(s.knowledgeBase.createdAt)).all();
}

export async function addKnowledge(businessId: string, data: { kind: (typeof KB_KINDS)[number]; question?: string; answer: string }) {
  const t = now();
  const id = newId();
  getDb()
    .insert(s.knowledgeBase)
    .values({ id, businessId, kind: data.kind, question: data.question ?? "", answer: data.answer, createdAt: t, updatedAt: t })
    .run();
  return getKnowledgeById(businessId, id);
}

export async function getKnowledgeById(businessId: string, id: string) {
  const rows = getDb().select().from(s.knowledgeBase).where(and(eq(s.knowledgeBase.id, id), eq(s.knowledgeBase.businessId, businessId))).all();
  return rows[0] ?? null;
}

export async function deleteKnowledge(businessId: string, id: string) {
  getDb().delete(s.knowledgeBase).where(and(eq(s.knowledgeBase.id, id), eq(s.knowledgeBase.businessId, businessId))).run();
}

export async function replaceKnowledge(businessId: string, items: { kind: (typeof KB_KINDS)[number]; question?: string; answer: string }[]) {
  const db = getDb();
  db.transaction((tx) => {
    tx.delete(s.knowledgeBase).where(eq(s.knowledgeBase.businessId, businessId)).run();
    for (const it of items) {
      const t = now();
      tx.insert(s.knowledgeBase)
        .values({ id: newId(), businessId, kind: it.kind, question: it.question ?? "", answer: it.answer, createdAt: t, updatedAt: t })
        .run();
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
  getDb()
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
    .run();
  return getLeadById(l.businessId, id);
}

export async function getLeadById(businessId: string, id: string) {
  const rows = getDb().select().from(s.leads).where(and(eq(s.leads.id, id), eq(s.leads.businessId, businessId))).all();
  return rows[0] ?? null;
}

export async function listLeads(businessId: string, limit = 100) {
  return getDb().select().from(s.leads).where(eq(s.leads.businessId, businessId)).orderBy(desc(s.leads.createdAt)).limit(limit).all();
}

export async function updateLead(businessId: string, id: string, patch: Partial<typeof s.leads.$inferInsert>) {
  const existing = await getLeadById(businessId, id);
  if (!existing) return null;
  getDb().update(s.leads).set({ ...patch, updatedAt: now() }).where(and(eq(s.leads.id, id), eq(s.leads.businessId, businessId))).run();
  return getLeadById(businessId, id);
}

export async function countLeadsByStatus(businessId: string, statuses: LeadStatus[]) {
  const rows = getDb()
    .select({ n: count() })
    .from(s.leads)
    .where(and(eq(s.leads.businessId, businessId), statuses.length ? inArray(s.leads.status, statuses) : sql`1=1`))
    .all();
  return rows[0]?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Conversations / messages
// ---------------------------------------------------------------------------

export async function createConversation(businessId: string, data: { leadId?: string; channel?: string; status?: (typeof s.CONVERSATION_STATUSES)[number]; aiEnabled?: number }) {
  const t = now();
  const id = newId();
  getDb()
    .insert(s.conversations)
    .values({ id, businessId, leadId: data.leadId ?? null, channel: data.channel ?? "chat", status: data.status ?? "active", aiEnabled: data.aiEnabled ?? 1, createdAt: t, updatedAt: t })
    .run();
  return getConversationById(businessId, id);
}

export async function getConversationById(businessId: string, id: string) {
  const rows = getDb().select().from(s.conversations).where(and(eq(s.conversations.id, id), eq(s.conversations.businessId, businessId))).all();
  return rows[0] ?? null;
}

export async function addMessage(businessId: string, data: { conversationId: string; sender: (typeof s.MESSAGE_SENDERS)[number]; body: string; createdAt?: number }) {
  const t = data.createdAt ?? now();
  const id = newId();
  getDb()
    .insert(s.messages)
    .values({ id, businessId, conversationId: data.conversationId, sender: data.sender, body: data.body, createdAt: t })
    .run();
  getDb().update(s.conversations).set({ updatedAt: t }).where(and(eq(s.conversations.id, data.conversationId), eq(s.conversations.businessId, businessId))).run();
  return id;
}

export async function listMessages(businessId: string, conversationId: string) {
  return getDb()
    .select()
    .from(s.messages)
    .where(and(eq(s.messages.conversationId, conversationId), eq(s.messages.businessId, businessId)))
    .orderBy(asc(s.messages.createdAt))
    .all();
}

export async function updateKnowledge(businessId: string, id: string, patch: Partial<typeof s.knowledgeBase.$inferInsert>) {
  const existing = await getKnowledgeById(businessId, id);
  if (!existing) return null;
  getDb().update(s.knowledgeBase).set({ ...patch, updatedAt: now() }).where(and(eq(s.knowledgeBase.id, id), eq(s.knowledgeBase.businessId, businessId))).run();
  return getKnowledgeById(businessId, id);
}

// ---------------------------------------------------------------------------
// Leads — search / detail / notes
// ---------------------------------------------------------------------------

export interface LeadSearch {
  q?: string;
  status?: string;
  score?: string;
  sort?: "newest" | "oldest";
  assignedTo?: string; // filter: only leads assigned to this user
}

export async function searchLeads(businessId: string, opts: LeadSearch = {}, limit = 500) {
  const db = getDb();
  const conds: SQL[] = [eq(s.leads.businessId, businessId)];
  if (opts.status && s.LEAD_STATUSES.includes(opts.status as LeadStatus)) conds.push(eq(s.leads.status, opts.status as LeadStatus));
  if (opts.score && s.LEAD_SCORES.includes(opts.score as LeadScore)) conds.push(eq(s.leads.score, opts.score as LeadScore));
  if (opts.assignedTo) conds.push(eq(s.leads.assignedTo, opts.assignedTo));
  if (opts.q) {
    const like = `%${opts.q.replace(/[%_]/g, "")}%`;
    conds.push(sql`(${s.leads.firstName} || ' ' || coalesce(${s.leads.lastName}, '') || ' ' || coalesce(${s.leads.phone}, '') || ' ' || coalesce(${s.leads.email}, '') || ' ' || coalesce(${s.leads.serviceRequested}, '') || ' ' || coalesce(${s.leads.location}, '')) LIKE ${like}`);
  }
  return db
    .select({
      lead: s.leads,
      assignedName: s.users.name,
    })
    .from(s.leads)
    .leftJoin(s.users, eq(s.leads.assignedTo, s.users.id))
    .where(and(...conds))
    .orderBy(opts.sort === "oldest" ? asc(s.leads.createdAt) : desc(s.leads.createdAt))
    .limit(limit)
    .all();
}

/** Earliest pending follow-up per lead (for the "next follow-up" column). */
export async function getNextFollowUps(businessId: string) {
  const rows = getDb()
    .select({
      leadId: s.followUps.leadId,
      scheduledFor: s.followUps.scheduledFor,
      type: s.followUps.type,
    })
    .from(s.followUps)
    .where(and(eq(s.followUps.businessId, businessId), eq(s.followUps.status, "pending")))
    .orderBy(asc(s.followUps.scheduledFor))
    .all();
  const map = new Map<string, { scheduledFor: number; type: string }>();
  for (const r of rows) if (!map.has(r.leadId)) map.set(r.leadId, { scheduledFor: r.scheduledFor, type: r.type });
  return map;
}

/** Set a lead's next follow-up by replacing its pending manual follow-ups. */
export async function setNextFollowUp(businessId: string, leadId: string, scheduledFor: number, type: (typeof FOLLOWUP_TYPES)[number] = "sms") {
  const db = getDb();
  db.transaction((tx) => {
    tx.delete(s.followUps)
      .where(and(eq(s.followUps.businessId, businessId), eq(s.followUps.leadId, leadId), eq(s.followUps.status, "pending"), eq(s.followUps.templateKey, "manual")))
      .run();
    tx.insert(s.followUps)
      .values({ id: newId(), businessId, leadId, type, scheduledFor, templateKey: "manual", status: "pending", attempts: 0, createdAt: now(), updatedAt: now() })
      .run();
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
  const rows = db
    .select({ conversation: s.conversations, lead: s.leads })
    .from(s.conversations)
    .leftJoin(s.leads, eq(s.conversations.leadId, s.leads.id))
    .where(and(...conds))
    .orderBy(desc(s.conversations.updatedAt))
    .all();

  // Last message per conversation — one grouped pass.
  const lastMsgs = db
    .select({
      conversationId: s.messages.conversationId,
      body: s.messages.body,
      sender: s.messages.sender,
      createdAt: s.messages.createdAt,
    })
    .from(s.messages)
    .where(eq(s.messages.businessId, businessId))
    .orderBy(asc(s.messages.createdAt))
    .all();
  const lastByConv = new Map<string, ConversationListItem["lastMessage"]>();
  for (const m of lastMsgs) lastByConv.set(m.conversationId, { body: m.body, sender: m.sender, createdAt: m.createdAt });

  return rows.map((r) => ({ conversation: r.conversation, lead: r.lead, lastMessage: lastByConv.get(r.conversation.id) ?? null }));
}

export async function updateConversation(businessId: string, id: string, patch: Partial<typeof s.conversations.$inferInsert>) {
  const existing = await getConversationById(businessId, id);
  if (!existing) return null;
  getDb().update(s.conversations).set({ ...patch, updatedAt: now() }).where(and(eq(s.conversations.id, id), eq(s.conversations.businessId, businessId))).run();
  return getConversationById(businessId, id);
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export async function createNotification(businessId: string, data: { userId?: string; kind?: string; title: string; body?: string }) {
  getDb()
    .insert(s.notifications)
    .values({ id: newId(), businessId, userId: data.userId ?? null, kind: data.kind ?? "info", title: data.title, body: data.body ?? "", read: 0, createdAt: now() })
    .run();
}

export async function listNotifications(businessId: string, limit = 20) {
  return getDb().select().from(s.notifications).where(eq(s.notifications.businessId, businessId)).orderBy(desc(s.notifications.createdAt)).limit(limit).all();
}

export async function countUnreadNotifications(businessId: string) {
  const rows = getDb()
    .select({ n: count() })
    .from(s.notifications)
    .where(and(eq(s.notifications.businessId, businessId), eq(s.notifications.read, 0)))
    .all();
  return rows[0]?.n ?? 0;
}

export async function markNotificationRead(businessId: string, id: string) {
  getDb().update(s.notifications).set({ read: 1 }).where(and(eq(s.notifications.id, id), eq(s.notifications.businessId, businessId))).run();
}

export async function markAllNotificationsRead(businessId: string) {
  getDb().update(s.notifications).set({ read: 1 }).where(eq(s.notifications.businessId, businessId)).run();
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
  getDb()
    .insert(s.appointments)
    .values({ id, businessId: a.businessId, leadId: a.leadId ?? null, serviceId: a.serviceId ?? null, startAt: a.startAt, endAt: a.endAt, status: a.status ?? "booked", notes: a.notes ?? "", createdAt: t, updatedAt: t })
    .run();
  return getAppointmentById(a.businessId, id);
}

export async function getAppointmentById(businessId: string, id: string) {
  const rows = getDb().select().from(s.appointments).where(and(eq(s.appointments.id, id), eq(s.appointments.businessId, businessId))).all();
  return rows[0] ?? null;
}

/** Appointments overlapping [start, end) for a business — used to never double-book. */
export async function listOverlappingAppointments(businessId: string, start: number, end: number) {
  return getDb()
    .select()
    .from(s.appointments)
    .where(
      and(
        eq(s.appointments.businessId, businessId),
        sql`${s.appointments.startAt} < ${end} AND ${s.appointments.endAt} > ${start}`,
        sql`${s.appointments.status} NOT IN ('cancelled', 'no_show')`
      )
    )
    .all();
}

export async function listAppointmentsForLead(businessId: string, leadId: string) {
  return getDb()
    .select({ appointment: s.appointments, serviceName: s.services.name })
    .from(s.appointments)
    .leftJoin(s.services, eq(s.appointments.serviceId, s.services.id))
    .where(and(eq(s.appointments.businessId, businessId), eq(s.appointments.leadId, leadId)))
    .orderBy(desc(s.appointments.startAt))
    .all();
}

export async function listUpcomingAppointments(businessId: string, limit = 6) {
  return getDb()
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
    .all();
}

export async function countAppointments(businessId: string) {
  const rows = getDb()
    .select({ n: count() })
    .from(s.appointments)
    .where(and(eq(s.appointments.businessId, businessId), sql`${s.appointments.status} NOT IN ('cancelled', 'no_show')`))
    .all();
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
  return getDb()
    .select({ appointment: s.appointments, lead: s.leads, serviceName: s.services.name })
    .from(s.appointments)
    .leftJoin(s.leads, eq(s.appointments.leadId, s.leads.id))
    .leftJoin(s.services, eq(s.appointments.serviceId, s.services.id))
    .where(and(...conds))
    .orderBy(scope === "past" ? desc(s.appointments.startAt) : asc(s.appointments.startAt))
    .limit(opts.limit ?? 200)
    .all();
}

export async function updateAppointment(businessId: string, id: string, patch: Partial<typeof s.appointments.$inferInsert>) {
  const existing = await getAppointmentById(businessId, id);
  if (!existing) return null;
  getDb().update(s.appointments).set({ ...patch, updatedAt: now() }).where(and(eq(s.appointments.id, id), eq(s.appointments.businessId, businessId))).run();
  return getAppointmentById(businessId, id);
}

// ---------------------------------------------------------------------------
// Follow-ups
// ---------------------------------------------------------------------------

export async function createFollowUp(businessId: string, data: { leadId: string; type: (typeof FOLLOWUP_TYPES)[number]; scheduledFor: number; templateKey?: string; status?: (typeof FOLLOWUP_STATUSES)[number] }) {
  const t = now();
  const id = newId();
  getDb()
    .insert(s.followUps)
    .values({ id, businessId, leadId: data.leadId, type: data.type, scheduledFor: data.scheduledFor, templateKey: data.templateKey ?? "", status: data.status ?? "pending", attempts: 0, createdAt: t, updatedAt: t })
    .run();
  return id;
}

export async function listFollowUps(businessId: string, limit = 50) {
  return getDb().select().from(s.followUps).where(eq(s.followUps.businessId, businessId)).orderBy(asc(s.followUps.scheduledFor)).limit(limit).all();
}

export async function getFollowUpById(businessId: string, id: string) {
  const rows = getDb().select().from(s.followUps).where(and(eq(s.followUps.id, id), eq(s.followUps.businessId, businessId))).all();
  return rows[0] ?? null;
}

export async function updateFollowUp(businessId: string, id: string, patch: Partial<typeof s.followUps.$inferInsert>) {
  const existing = await getFollowUpById(businessId, id);
  if (!existing) return null;
  getDb().update(s.followUps).set({ ...patch, updatedAt: now() }).where(and(eq(s.followUps.id, id), eq(s.followUps.businessId, businessId))).run();
  return getFollowUpById(businessId, id);
}

/** Follow-ups joined with lead names for the Follow-Ups page. */
export interface FollowUpListItem {
  followUp: typeof s.followUps.$inferSelect;
  lead: (typeof s.leads.$inferSelect) | null;
}

export async function listFollowUpsWithLead(businessId: string, limit = 200): Promise<FollowUpListItem[]> {
  return getDb()
    .select({ followUp: s.followUps, lead: s.leads })
    .from(s.followUps)
    .leftJoin(s.leads, eq(s.followUps.leadId, s.leads.id))
    .where(eq(s.followUps.businessId, businessId))
    .orderBy(asc(s.followUps.scheduledFor))
    .limit(limit)
    .all();
}

/** Due pending follow-ups for the scheduler (oldest first). */
export async function listDueFollowUps(limit = 100, nowMs = now()) {
  return getDb()
    .select()
    .from(s.followUps)
    .where(and(eq(s.followUps.status, "pending"), sql`${s.followUps.scheduledFor} <= ${nowMs}`))
    .orderBy(asc(s.followUps.scheduledFor))
    .limit(limit)
    .all();
}

/** Cancel a lead's not-yet-sent follow-ups (stop rules: booked / customer / opt-out / manual stop).
 *  Also cancels the lead's pending automation runs so a stopped sequence can
 *  never fire (Brain 3 — the engine re-checks the row at fire time too). */
export async function cancelFollowUpsForLead(businessId: string, leadId: string, opts: { keep?: string[] } = {}) {
  const db = getDb();
  const rows = db
    .select()
    .from(s.followUps)
    .where(and(eq(s.followUps.businessId, businessId), eq(s.followUps.leadId, leadId), sql`${s.followUps.status} IN ('pending', 'paused')`))
    .all();
  for (const r of rows) {
    if (opts.keep?.includes(r.templateKey ?? "")) continue;
    db.update(s.followUps).set({ status: "cancelled", updatedAt: now() }).where(eq(s.followUps.id, r.id)).run();
  }
  if (rows.length) {
    await cancelAutomationRunsForLead(businessId, leadId);
  }
  return rows.length;
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
  const rows = getDb().select().from(s.followUpConfigs).where(eq(s.followUpConfigs.businessId, businessId)).all();
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
  const existing = getDb().select().from(s.followUpConfigs).where(eq(s.followUpConfigs.businessId, businessId)).all();
  if (existing[0]) {
    getDb().update(s.followUpConfigs).set({ stepsJson: JSON.stringify(steps), updatedAt: t }).where(eq(s.followUpConfigs.id, existing[0].id)).run();
  } else {
    getDb().insert(s.followUpConfigs).values({ id: newId(), businessId, stepsJson: JSON.stringify(steps), createdAt: t, updatedAt: t }).run();
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
    getDb().select().from(s.leads).where(eq(s.leads.businessId, businessId)).orderBy(desc(s.leads.createdAt)).limit(6).all(),
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
  const leadRows = db
    .select({ createdAt: s.leads.createdAt, source: s.leads.source, serviceRequested: s.leads.serviceRequested })
    .from(s.leads)
    .where(eq(s.leads.businessId, businessId))
    .all();

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
    db.select({ n: count() }).from(s.messages).where(and(eq(s.messages.businessId, businessId), eq(s.messages.sender, "ai"))).all(),
    db.select({ n: count() }).from(s.messages).where(and(eq(s.messages.businessId, businessId), eq(s.messages.sender, "employee"))).all(),
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
  getDb()
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
    .run();
}

export async function audit(businessId: string | null, userId: string | null, action: string, entity = "", entityId = "", details: unknown = {}) {
  getDb()
    .insert(s.auditLogs)
    .values({ id: newId(), businessId, userId, action, entity, entityId, detailsJson: JSON.stringify(details), createdAt: now() })
    .run();
}

export async function listAuditLogs(businessId: string, limit = 50) {
  return getDb().select().from(s.auditLogs).where(eq(s.auditLogs.businessId, businessId)).orderBy(desc(s.auditLogs.createdAt)).limit(limit).all();
}

export async function listAgentActions(businessId: string, limit = 50) {
  return getDb().select().from(s.agentActions).where(eq(s.agentActions.businessId, businessId)).orderBy(desc(s.agentActions.createdAt)).limit(limit).all();
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
  getDb()
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
    .run();
  return getHumanTaskById(data.businessId, id);
}

export async function getHumanTaskById(businessId: string, id: string) {
  const rows = getDb().select().from(s.humanTasks).where(and(eq(s.humanTasks.id, id), eq(s.humanTasks.businessId, businessId))).all();
  return rows[0] ?? null;
}

export async function listHumanTasks(businessId: string, limit = 100, status?: s.HumanTaskStatus) {
  const conds = [eq(s.humanTasks.businessId, businessId)];
  if (status) conds.push(eq(s.humanTasks.status, status));
  return getDb().select().from(s.humanTasks).where(and(...conds)).orderBy(desc(s.humanTasks.createdAt)).limit(limit).all();
}

export async function resolveHumanTask(businessId: string, id: string): Promise<typeof s.humanTasks.$inferSelect | null> {
  const existing = await getHumanTaskById(businessId, id);
  if (!existing) return null;
  getDb()
    .update(s.humanTasks)
    .set({ status: "resolved", resolvedAt: now(), updatedAt: now() })
    .where(and(eq(s.humanTasks.id, id), eq(s.humanTasks.businessId, businessId)))
    .run();
  return getHumanTaskById(businessId, id);
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
  const rows = getDb().select().from(s.widgetSettings).where(eq(s.widgetSettings.businessId, businessId)).all();
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
  const existing = getDb().select().from(s.widgetSettings).where(eq(s.widgetSettings.businessId, businessId)).all();
  if (existing[0]) return getWidgetSettings(businessId);
  const t = now();
  getDb()
    .insert(s.widgetSettings)
    .values({ id: newId(), businessId, ...DEFAULT_WIDGET_SETTINGS, createdAt: t, updatedAt: t })
    .run();
  return getWidgetSettings(businessId);
}

export async function saveWidgetSettings(businessId: string, patch: { enabled?: number; primaryColor?: string; position?: s.WidgetPosition; welcomeMessage?: string; logoUrl?: string }) {
  const existing = getDb().select().from(s.widgetSettings).where(eq(s.widgetSettings.businessId, businessId)).all();
  const t = now();
  if (existing[0]) {
    getDb().update(s.widgetSettings).set({ ...patch, updatedAt: t }).where(eq(s.widgetSettings.id, existing[0].id)).run();
  } else {
    getDb()
      .insert(s.widgetSettings)
      .values({ id: newId(), businessId, ...DEFAULT_WIDGET_SETTINGS, ...patch, createdAt: t, updatedAt: t })
      .run();
  }
  return getWidgetSettings(businessId);
}

// ---------------------------------------------------------------------------
// Integrations / subscriptions
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// AI agent config (spec §6/§13 — owner-configured receptionist behavior)
// ---------------------------------------------------------------------------

export type EscalationSensitivity = "low" | "medium" | "high";

export interface AiConfig {
  /** AI replies to lead messages automatically (default true). */
  autoRespond: boolean;
  /** How readily the receptionist escalates to a human. */
  escalationSensitivity: EscalationSensitivity;
  /** Extra owner-defined phrases that must escalate (always honored). */
  escalationKeywords: string[];
}

export const DEFAULT_AI_CONFIG: AiConfig = {
  autoRespond: true,
  escalationSensitivity: "medium",
  escalationKeywords: [],
};

export const ESCALATION_SENSITIVITIES: EscalationSensitivity[] = ["low", "medium", "high"];

function parseAiConfig(raw: string | null | undefined): AiConfig {
  if (!raw) return { ...DEFAULT_AI_CONFIG };
  try {
    const parsed = JSON.parse(raw) as Partial<AiConfig>;
    return {
      autoRespond: typeof parsed.autoRespond === "boolean" ? parsed.autoRespond : DEFAULT_AI_CONFIG.autoRespond,
      escalationSensitivity: ESCALATION_SENSITIVITIES.includes(parsed.escalationSensitivity as EscalationSensitivity)
        ? (parsed.escalationSensitivity as EscalationSensitivity)
        : DEFAULT_AI_CONFIG.escalationSensitivity,
      escalationKeywords: Array.isArray(parsed.escalationKeywords)
        ? parsed.escalationKeywords.filter((k): k is string => typeof k === "string" && k.trim().length > 0).map((k) => k.trim())
        : [],
    };
  } catch {
    return { ...DEFAULT_AI_CONFIG };
  }
}

/** Read the business's AI agent config (defaults when never saved). */
export async function getAiConfig(businessId: string): Promise<AiConfig> {
  const business = await getBusinessById(businessId);
  if (!business) return { ...DEFAULT_AI_CONFIG };
  return parseAiConfig(business.aiConfigJson);
}

/** Persist a partial AI config update; returns the merged config. */
export async function saveAiConfig(businessId: string, patch: Partial<AiConfig>): Promise<AiConfig> {
  const current = await getAiConfig(businessId);
  const next: AiConfig = {
    autoRespond: patch.autoRespond ?? current.autoRespond,
    escalationSensitivity: ESCALATION_SENSITIVITIES.includes(patch.escalationSensitivity as EscalationSensitivity)
      ? (patch.escalationSensitivity as EscalationSensitivity)
      : current.escalationSensitivity,
    escalationKeywords: patch.escalationKeywords ?? current.escalationKeywords,
  };
  await updateBusiness(businessId, { aiConfigJson: JSON.stringify(next) });
  return next;
}

export async function listIntegrations(businessId: string) {
  return getDb().select().from(s.integrations).where(eq(s.integrations.businessId, businessId)).all();
}

export async function setIntegrationStatus(businessId: string, provider: (typeof INTEGRATION_PROVIDERS)[number], status: (typeof s.INTEGRATION_STATUSES)[number], config: unknown = {}) {
  const existing = getDb().select().from(s.integrations).where(and(eq(s.integrations.businessId, businessId), eq(s.integrations.provider, provider))).all();
  const t = now();
  if (existing[0]) {
    getDb().update(s.integrations).set({ status, configJson: JSON.stringify(config), updatedAt: t }).where(eq(s.integrations.id, existing[0].id)).run();
  } else {
    getDb().insert(s.integrations).values({ id: newId(), businessId, provider, status, configJson: JSON.stringify(config), createdAt: t, updatedAt: t }).run();
  }
}

export async function getSubscription(businessId: string) {
  const rows = getDb().select().from(s.subscriptions).where(eq(s.subscriptions.businessId, businessId)).all();
  return rows[0] ?? null;
}

export async function setSubscriptionPlan(businessId: string, plan: (typeof PLAN_NAMES)[number], status?: (typeof s.SUBSCRIPTION_STATUSES)[number]) {
  const existing = await getSubscription(businessId);
  const t = now();
  if (existing) {
    getDb().update(s.subscriptions).set({ plan, status: status ?? existing.status, updatedAt: t }).where(eq(s.subscriptions.businessId, businessId)).run();
  } else {
    getDb().insert(s.subscriptions).values({ id: newId(), businessId, plan, status: status ?? "trialing", createdAt: t, updatedAt: t }).run();
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
  getDb()
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
    .run();
  return id;
}

export async function listEvents(businessId: string, opts: { types?: s.EventType[]; since?: number; limit?: number } = {}) {
  const conds: SQL[] = [eq(s.events.businessId, businessId)];
  if (opts.types?.length) conds.push(inArray(s.events.type, opts.types));
  if (opts.since !== undefined) conds.push(gte(s.events.createdAt, opts.since));
  return getDb()
    .select()
    .from(s.events)
    .where(and(...conds))
    .orderBy(desc(s.events.createdAt))
    .limit(opts.limit ?? 200)
    .all();
}

export async function countEventsOfType(businessId: string, type: s.EventType, since?: number) {
  const conds: SQL[] = [eq(s.events.businessId, businessId), eq(s.events.type, type)];
  if (since !== undefined) conds.push(gte(s.events.createdAt, since));
  const rows = getDb().select({ n: count() }).from(s.events).where(and(...conds)).all();
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
  getDb()
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
    .run();
  return getAutomationRuleById(businessId, id);
}

export async function getAutomationRuleById(businessId: string, id: string) {
  const rows = getDb().select().from(s.automationRules).where(and(eq(s.automationRules.id, id), eq(s.automationRules.businessId, businessId))).all();
  return rows[0] ?? null;
}

export async function listAutomationRules(businessId: string) {
  return getDb().select().from(s.automationRules).where(eq(s.automationRules.businessId, businessId)).orderBy(asc(s.automationRules.createdAt)).all();
}

export async function countAutomationRules(businessId: string) {
  const rows = getDb().select({ n: count() }).from(s.automationRules).where(eq(s.automationRules.businessId, businessId)).all();
  return rows[0]?.n ?? 0;
}

export async function updateAutomationRule(businessId: string, id: string, patch: Partial<typeof s.automationRules.$inferInsert>) {
  const existing = await getAutomationRuleById(businessId, id);
  if (!existing) return null;
  getDb()
    .update(s.automationRules)
    .set({ ...patch, updatedAt: now() })
    .where(and(eq(s.automationRules.id, id), eq(s.automationRules.businessId, businessId)))
    .run();
  return getAutomationRuleById(businessId, id);
}

/** Enabled rules subscribed to an event (spec §30: agents subscribe to events). */
export async function getAutomationRulesForEvent(businessId: string, eventType: s.EventType) {
  return getDb()
    .select()
    .from(s.automationRules)
    .where(and(eq(s.automationRules.businessId, businessId), eq(s.automationRules.triggerEvent, eventType), eq(s.automationRules.enabled, 1)))
    .orderBy(asc(s.automationRules.createdAt))
    .all();
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
  getDb()
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
    .run();
  return getAutomationRunById(data.businessId, id);
}

export async function getAutomationRunById(businessId: string, id: string) {
  const rows = getDb().select().from(s.automationRuns).where(and(eq(s.automationRuns.id, id), eq(s.automationRuns.businessId, businessId))).all();
  return rows[0] ?? null;
}

export async function updateAutomationRun(businessId: string, id: string, patch: Partial<typeof s.automationRuns.$inferInsert>) {
  const existing = await getAutomationRunById(businessId, id);
  if (!existing) return null;
  getDb()
    .update(s.automationRuns)
    .set({ ...patch, updatedAt: now() })
    .where(and(eq(s.automationRuns.id, id), eq(s.automationRuns.businessId, businessId)))
    .run();
  return getAutomationRunById(businessId, id);
}

export async function listAutomationRuns(businessId: string, limit = 200) {
  return getDb()
    .select()
    .from(s.automationRuns)
    .where(eq(s.automationRuns.businessId, businessId))
    .orderBy(desc(s.automationRuns.createdAt))
    .limit(limit)
    .all();
}

/** Due pending runs for the worker (oldest first) — delayed/scheduled runs
 *  survive restarts because they are picked from the DB on every tick. */
export async function listDueAutomationRuns(limit = 100, nowMs = now()) {
  return getDb()
    .select()
    .from(s.automationRuns)
    .where(and(eq(s.automationRuns.status, "pending"), sql`${s.automationRuns.runAt} <= ${nowMs}`))
    .orderBy(asc(s.automationRuns.runAt))
    .limit(limit)
    .all();
}

/** Stale `running` rows (a process died mid-run) get retried or failed. */
export async function listStuckAutomationRuns(limit = 50) {
  return getDb()
    .select()
    .from(s.automationRuns)
    .where(eq(s.automationRuns.status, "running"))
    .limit(limit)
    .all();
}

/** The follow-up step run for a follow_up row (payload carries the followUpId). */
export async function getRunForFollowUp(followUpId: string) {
  const rows = getDb()
    .select()
    .from(s.automationRuns)
    .where(sql`${s.automationRuns.payloadJson} LIKE ${`%${followUpId}%`}`)
    .limit(10)
    .all();
  return rows[0] ?? null;
}

/** All pending follow-up rows (the backfill safety net creates a run for any
 *  pre-Brain-3 row that was scheduled before the automation engine existed). */
export async function listPendingFollowUps(limit = 500) {
  return getDb()
    .select()
    .from(s.followUps)
    .where(eq(s.followUps.status, "pending"))
    .orderBy(asc(s.followUps.scheduledFor))
    .limit(limit)
    .all();
}

/** Cancel a lead's pending automation runs (stop rules: booked / customer /
 *  opt-out / manual stop). Follow-up step runs are cancelled alongside their
 *  follow_up rows by cancelFollowUpsForLead. */
export async function cancelAutomationRunsForLead(businessId: string, leadId: string) {
  const db = getDb();
  const rows = db
    .select()
    .from(s.automationRuns)
    .where(and(eq(s.automationRuns.businessId, businessId), eq(s.automationRuns.leadId, leadId), inArray(s.automationRuns.status, ["pending", "running"])))
    .all();
  for (const r of rows) {
    db.update(s.automationRuns).set({ status: "cancelled", updatedAt: now() }).where(eq(s.automationRuns.id, r.id)).run();
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
  const rows = getDb().select().from(s.reviewConfigs).where(eq(s.reviewConfigs.businessId, businessId)).all();
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
  const existing = getDb().select().from(s.reviewConfigs).where(eq(s.reviewConfigs.businessId, businessId)).all();
  if (existing[0]) return getReviewConfig(businessId);
  const t = now();
  getDb()
    .insert(s.reviewConfigs)
    .values({ id: newId(), businessId, ...DEFAULT_REVIEW_CONFIG, createdAt: t, updatedAt: t })
    .run();
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
  getDb()
    .update(s.reviewConfigs)
    .set({ ...next, updatedAt: t })
    .where(eq(s.reviewConfigs.businessId, businessId))
    .run();
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
  getDb()
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
    .run();
  return getReviewById(data.businessId, id);
}

export async function getReviewById(businessId: string, id: string) {
  const rows = getDb().select().from(s.reviews).where(and(eq(s.reviews.id, id), eq(s.reviews.businessId, businessId))).all();
  return rows[0] ?? null;
}

export async function getReviewForAppointment(businessId: string, appointmentId: string) {
  const rows = getDb().select().from(s.reviews).where(and(eq(s.reviews.businessId, businessId), eq(s.reviews.appointmentId, appointmentId))).all();
  return rows[0] ?? null;
}

/** The open feedback record for a lead: a request was sent, no feedback yet. */
export async function getOpenReviewForLead(businessId: string, leadId: string) {
  const rows = getDb()
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
    .all();
  return rows[0] ?? null;
}

export async function updateReview(businessId: string, id: string, patch: Partial<typeof s.reviews.$inferInsert>) {
  const existing = await getReviewById(businessId, id);
  if (!existing) return null;
  getDb().update(s.reviews).set({ ...patch, updatedAt: now() }).where(and(eq(s.reviews.id, id), eq(s.reviews.businessId, businessId))).run();
  return getReviewById(businessId, id);
}

/** Recent feedback records joined with lead names for the Reviews surface. */
export interface ReviewListItem {
  review: typeof s.reviews.$inferSelect;
  lead: (typeof s.leads.$inferSelect) | null;
  serviceName: string | null;
}

export async function listReviews(businessId: string, limit = 100): Promise<ReviewListItem[]> {
  return getDb()
    .select({ review: s.reviews, lead: s.leads, serviceName: s.services.name })
    .from(s.reviews)
    .leftJoin(s.leads, eq(s.reviews.leadId, s.leads.id))
    .leftJoin(s.appointments, eq(s.reviews.appointmentId, s.appointments.id))
    .leftJoin(s.services, eq(s.appointments.serviceId, s.services.id))
    .where(eq(s.reviews.businessId, businessId))
    .orderBy(desc(s.reviews.createdAt))
    .limit(limit)
    .all();
}

// ---------------------------------------------------------------------------
// AI BRAIN 4 — weekly business intelligence reports (spec §22)
// ---------------------------------------------------------------------------

export async function getWeeklyReport(businessId: string, weekStart: number) {
  const rows = getDb().select().from(s.businessReports).where(and(eq(s.businessReports.businessId, businessId), eq(s.businessReports.weekStart, weekStart))).all();
  return rows[0] ?? null;
}

export async function getWeeklyReportById(businessId: string, id: string) {
  const rows = getDb().select().from(s.businessReports).where(and(eq(s.businessReports.businessId, businessId), eq(s.businessReports.id, id))).all();
  return rows[0] ?? null;
}

export async function listWeeklyReports(businessId: string, limit = 12) {
  return getDb()
    .select()
    .from(s.businessReports)
    .where(eq(s.businessReports.businessId, businessId))
    .orderBy(desc(s.businessReports.weekStart))
    .limit(limit)
    .all();
}

/** Upsert a weekly report for a business+week (idempotent — regenerating a
 *  week replaces the stored report). */
export async function upsertWeeklyReport(businessId: string, weekStart: number, metrics: unknown, narrative: unknown) {
  const t = now();
  const existing = await getWeeklyReport(businessId, weekStart);
  if (existing) {
    getDb()
      .update(s.businessReports)
      .set({ metricsJson: JSON.stringify(metrics), narrativeJson: JSON.stringify(narrative), createdAt: t })
      .where(eq(s.businessReports.id, existing.id))
      .run();
    return getWeeklyReport(businessId, weekStart)!;
  }
  getDb()
    .insert(s.businessReports)
    .values({ id: newId(), businessId, weekStart, metricsJson: JSON.stringify(metrics), narrativeJson: JSON.stringify(narrative), createdAt: t })
    .run();
  return getWeeklyReport(businessId, weekStart)!;
}

// ---------------------------------------------------------------------------
// Week-scoped reads (used by the Business Intelligence agent)
// ---------------------------------------------------------------------------

export async function listLeadsCreatedBetween(businessId: string, start: number, end: number) {
  return getDb()
    .select()
    .from(s.leads)
    .where(and(eq(s.leads.businessId, businessId), gte(s.leads.createdAt, start), sql`${s.leads.createdAt} < ${end}`))
    .all();
}

export async function listAppointmentsCreatedBetween(businessId: string, start: number, end: number) {
  return getDb()
    .select()
    .from(s.appointments)
    .where(and(eq(s.appointments.businessId, businessId), gte(s.appointments.createdAt, start), sql`${s.appointments.createdAt} < ${end}`))
    .all();
}

export async function listMessagesBetween(businessId: string, start: number, end: number) {
  return getDb()
    .select()
    .from(s.messages)
    .where(and(eq(s.messages.businessId, businessId), gte(s.messages.createdAt, start), sql`${s.messages.createdAt} < ${end}`))
    .orderBy(asc(s.messages.createdAt))
    .all();
}

export async function listConversationsBetween(businessId: string, start: number, end: number) {
  return getDb()
    .select()
    .from(s.conversations)
    .where(and(eq(s.conversations.businessId, businessId), gte(s.conversations.createdAt, start), sql`${s.conversations.createdAt} < ${end}`))
    .all();
}

export async function listFollowUpsBetween(businessId: string, start: number, end: number) {
  return getDb()
    .select()
    .from(s.followUps)
    .where(and(eq(s.followUps.businessId, businessId), gte(s.followUps.scheduledFor, start), sql`${s.followUps.scheduledFor} < ${end}`))
    .all();
}

export async function listReviewsBetween(businessId: string, start: number, end: number) {
  return getDb()
    .select()
    .from(s.reviews)
    .where(and(eq(s.reviews.businessId, businessId), gte(s.reviews.reviewRequestSentAt ?? 0, start), sql`${s.reviews.reviewRequestSentAt ?? 0} < ${end}`))
    .all();
}

export type { SQL };
