/**
 * AI BRAIN 6 — §34–35 automated test suite (the full "Testing" coverage matrix
 * from the owner's AI Agent Brain & Automation spec).
 *
 * §34 coverage (each exercised with real assertions):
 *   lead creation, lead qualification, knowledge retrieval, appointment
 *   booking, calendar failure, human escalation, opt-out, follow-up stopping,
 *   hallucination prevention, tenant isolation, permission enforcement,
 *   Stripe subscription status.
 *
 * §35 test scenarios 1–7 — conversation-level, driven through the AI chat:
 *   S1 normal lead ("My AC isn't working") → HVAC service identified, begins
 *      qualification
 *   S2 appointment request → checks the REAL calendar, offers REAL available
 *      times only (cross-checked against the availability endpoint)
 *   S3 unknown pricing ("How much does a new AC unit cost?") → no invented
 *      price; the exact spec fallback phrase
 *   S4 angry customer → immediate human escalation
 *   S5 "I want to talk to a person." → human escalation
 *   S6 "Stop texting me." → automated messaging stops immediately + opted out
 *   S7 100-miles-out location → lead marked UNQUALIFIED
 *
 * Style: matches brain5b-test.ts — fresh owner signup per run, HTTP against
 * the live server (port 3000, run `bun run publish` first), DB assertions via
 * getDb/schema, cleanup deletes every row this run created, final "ALL PASS"
 * summary, exit non-zero on failure. The calendar-failure scenario must force
 * a provider outage, so it runs IN-PROCESS against the same SQLite DB with
 * CALENDAR_PROVIDER pointed at an unimplemented provider (the HTTP server
 * process is untouched — the mock stays healthy there).
 *
 * Run:  cd /home/team/shared/site && unset DATABASE_URL && bun run publish && bun run brain6-test.ts
 */
import { runMigrations } from "./src/server/db/migrate";
import { getDb } from "./src/server/db/client";
import * as s from "./src/server/db/schema";
import { eq } from "drizzle-orm";
runMigrations();
const BASE = process.env.BRAIN6_BASE ?? "http://localhost:3000";
const EMAIL_A = `brain6a_${Date.now()}@test.ai`;
const EMAIL_B = `brain6b_${Date.now()}@test.ai`;
let failures = 0;
let auditBaseline = 0;
// Module-scope ids so the cleanup handler can reach them (mirrors brain5b).
let userIdA = "";
let userIdB = "";
let bizA = "";
let bizB = "";
// ---------------------------------------------------------------------------
// In-process imports (same SQLite DB as the server — .data/leadflow.db)
// ---------------------------------------------------------------------------
import * as repo from "./src/server/db/repo";
import { callAiTool, ToolError, TOOL_REGISTRY, AI_ACCESSIBLE_TOOLS } from "./src/server/ai/tools/registry";
import { handleLeadMessage } from "./src/server/ai/engine";
import { sendFollowUpRow } from "./src/server/followups/engine";
import { fmtTime } from "./src/server/appointments/agent";

function pass(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} | ${label}${detail ? " | " + detail : ""}`);
  if (!ok) failures += 1;
}

const cookies: Record<string, string> = {};
async function api(path: string, opts: { method?: string; body?: unknown; key?: string } = {}) {
  const key = opts.key ?? "a";
  const res = await fetch(BASE + path, {
    method: opts.method ?? "GET",
    headers: { "content-type": "application/json", ...(cookies[key] ? { cookie: cookies[key] } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const sc = res.headers.get("set-cookie");
  if (sc && key) cookies[key] = sc.split(";")[0];
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

/** POST a lead message; returns the bundle + the AI/system reply (newest). */
async function chat(convId: string, body: string, key = "a") {
  const r = await api(`/api/chat/conversations/${convId}/messages`, { method: "POST", body: { body }, key });
  const bundle = r.json.bundle ?? r.json;
  const msgs: { sender: string; body: string }[] = bundle.messages ?? [];
  const reply = [...msgs].reverse().find((m) => m.sender === "ai" || m.sender === "system")?.body ?? "";
  return { status: r.status, bundle, reply };
}

/** Create a lead + conversation (owner session), returns ids. */
async function newConversation(key = "a", firstName = "Website") {
  const r = await api("/api/leads", { method: "POST", body: { firstName, lastName: "Visitor", source: "brain6_test", notes: "brain6 test lead" }, key });
  const leadId = r.json.lead?.id ?? r.json.id ?? "";
  if (!leadId) throw new Error("lead create failed: " + JSON.stringify(r.json).slice(0, 160));
  const c = await api("/api/chat/conversations", { method: "POST", body: { leadId, source: "brain6_test" }, key });
  const convId = c.json.conversation?.id ?? "";
  if (!convId) throw new Error("conversation create failed: " + JSON.stringify(c.json).slice(0, 160));
  return { leadId, convId };
}

/** Last detect_intent row for a conversation (from the DB audit trail). */
async function lastIntent(bizId: string, convId: string) {
  const rows = await getDb().select().from(s.agentActions).where(eq(s.agentActions.businessId, bizId)).execute();
  const di = rows.filter((r) => r.action === "detect_intent" && JSON.parse(r.inputJson ?? "{}").conversationId === convId);
  const last = di[di.length - 1];
  return last ? JSON.parse(last.resultJson ?? "{}") : null;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** Human tasks for a business (newest last). */
async function tasksFor(bizId: string) {
  return getDb().select().from(s.humanTasks).where(eq(s.humanTasks.businessId, bizId)).execute();
}

(async () => {
  const db = getDb();
  auditBaseline = (await db.select().from(s.auditLogs).execute()).length;

  // ================================================================= A) SETUP
  // Fresh owner signup + business + services + hours + service area + KB.
  let r = await api("/api/auth/signup", { method: "POST", body: { name: "Brain6 Owner", email: EMAIL_A, password: "brain61234" } });
  userIdA = r.json.user?.id ?? "";
  pass("A1 signup owner A", r.status === 200 && !!userIdA, `status ${r.status}`);
  r = await api("/api/business", { method: "POST", body: { name: "Brain6 HVAC Co", category: "hvac" } });
  bizA = r.json.business?.id ?? "";
  pass("A2 business A created", (r.status === 200 || r.status === 201) && !!bizA, `status ${r.status}`);

  const mkService = (name: string, priceCents: number, durationMin: number) =>
    api("/api/services", { method: "POST", body: { name, priceCents, durationMin } }).then((x) => x.json.service);
  const acRepair = await mkService("AC Repair", 18900, 90);
  const acTune = await mkService("AC Tune-Up", 12900, 60);
  const furnaceInstall = await mkService("Furnace Installation", 0, 240);
  pass("A3 services created", !!acRepair?.id && !!acTune?.id && !!furnaceInstall?.id, `repair=${acRepair?.name} tune=${acTune?.name} furnace=${furnaceInstall?.name}`);

  const HOURS = { monday: { open: "08:00", close: "17:00", closed: false }, tuesday: { open: "08:00", close: "17:00", closed: false }, wednesday: { open: "08:00", close: "17:00", closed: false }, thursday: { open: "08:00", close: "17:00", closed: false }, friday: { open: "08:00", close: "17:00", closed: false }, saturday: { open: "09:00", close: "13:00", closed: false }, sunday: { open: "", close: "", closed: true } };
  r = await api("/api/business/hours", { method: "PUT", body: HOURS });
  pass("A4 business hours saved", r.status === 200, `status ${r.status}`);
  r = await api("/api/business/service-area", { method: "PUT", body: { zipCodes: ["49221"], cities: ["Adrian"] } });
  pass("A5 service area saved", r.status === 200, `status ${r.status}`);
  r = await api("/api/knowledge", { method: "POST", body: { kind: "faq", question: "Do you service the whole house?", answer: "Yes — we service the entire home, including all rooms and ductwork." } });
  pass("A6 KB entry created", r.status === 201 && !!r.json.entry?.id, `status ${r.status}`);
  r = await api("/api/knowledge", { method: "POST", body: { kind: "faq", question: "How much is an AC tune-up?", answer: "An AC tune-up is $129 — includes a full system check." } });
  pass("A6b KB pricing entry created", r.status === 201 && !!r.json.entry?.id, `status ${r.status}`);

  // ---- Stripe subscription status (§34) ----
  r = await api("/api/auth/me");
  const sub0 = r.json.subscription ?? {};
  pass("A7 fresh business subscription trialing", r.status === 200 && sub0.plan === "starter" && sub0.status === "trialing", JSON.stringify(sub0));
  await repo.setSubscriptionPlan(bizA, "professional", "active");
  r = await api("/api/auth/me");
  const sub1 = r.json.subscription ?? {};
  pass("A8 subscription status reflected (active)", sub1.plan === "professional" && sub1.status === "active", JSON.stringify(sub1));
  r = await api("/api/health/system");
  const stripeSvc = (r.json.services ?? []).find((x: any) => x.id === "stripe");
  pass("A9 health stripe mock-labeled", stripeSvc?.kind === "mock" && /mock/.test(stripeSvc?.provider ?? "") && stripeSvc?.status === "CONNECTED", JSON.stringify(stripeSvc).slice(0, 140));

  // ====================================================== B) LEAD CREATION §34
  r = await api("/api/leads", { method: "POST", body: { firstName: "Website", lastName: "Visitor", source: "brain6_test", notes: "§34 lead creation" } });
  const leadBC = r.json.lead?.id ?? r.json.id ?? "";
  pass("B1 lead created", r.status === 201 && !!leadBC, `status ${r.status}`);
  const leadRow = leadBC ? await db.select().from(s.leads).where(eq(s.leads.id, leadBC)).execute() : [];
  pass("B2 lead row tenant-scoped + new", leadRow[0]?.businessId === bizA && leadRow[0]?.status === "new" && leadRow[0]?.scoreValue === 0, `biz=${leadRow[0]?.businessId === bizA} status=${leadRow[0]?.status}`);
  r = await api("/api/leads", { method: "POST", body: { lastName: "NoFirst" } });
  pass("B3 invalid lead rejected", r.status === 400, `status ${r.status}`);

  // ============================== C) §35 SCENARIO 1: NORMAL LEAD + QUALIFY §34
  const { leadId: danaLead, convId: danaConv } = await newConversation();
  let c = await chat(danaConv, "My AC isn't working");
  pass("C1 S1 begins qualification (asks name)", /what'?s your name|what is your name/i.test(c.reply), `reply="${c.reply.slice(0, 90)}"`);
  const di1 = await lastIntent(bizA, danaConv);
  pass("C2 S1 intent SERVICE_INQUIRY (HVAC service identified)", di1?.intent === "SERVICE_INQUIRY", `got ${di1?.intent} (${di1?.confidence})`);
  const AC_SERVICES = ["AC Repair", "AC Tune-Up"];
  const danaRow1 = await db.select().from(s.leads).where(eq(s.leads.id, danaLead)).execute();
  // "My AC isn't working" matches every AC-named service; the engine picks the
  // longest matching name (deterministic). Scenario 1 only requires that an
  // HVAC service is identified and qualification begins.
  pass("C3 S1 HVAC service identified (AC service)", AC_SERVICES.includes(danaRow1[0]?.serviceRequested ?? ""), `svc=${danaRow1[0]?.serviceRequested}`);
  const convRow1 = await db.select().from(s.conversations).where(eq(s.conversations.id, danaConv)).execute();
  const mem1 = parseJson<{ service?: string; problem?: string }>(convRow1[0]?.memoryJson ?? null, {});
  pass("C4 S1 memory.service + problem persisted", mem1.service === danaRow1[0]?.serviceRequested && mem1.problem === "My AC isn't working", `service=${mem1.service} problem=${mem1.problem}`);
  pass("C5 S1 conversation AI-handled", c.bundle.conversation?.aiEnabled === 1, `ai=${c.bundle.conversation?.aiEnabled}`);

  c = await chat(danaConv, "My name is Dana");
  pass("C6 qualification: asks location after name", /what city|city are you in/i.test(c.reply), `reply="${c.reply.slice(0, 90)}"`);
  const danaRow2 = await db.select().from(s.leads).where(eq(s.leads.id, danaLead)).execute();
  pass("C7 name extracted to lead", danaRow2[0]?.firstName === "Dana", `name=${danaRow2[0]?.firstName}`);

  c = await chat(danaConv, "I'm in Adrian");
  pass("C8 qualification: asks contact after location", /phone number or email|reach you|email to reach/i.test(c.reply), `reply="${c.reply.slice(0, 110)}"`);
  const danaRow3 = await db.select().from(s.leads).where(eq(s.leads.id, danaLead)).execute();
  pass("C9 location extracted", danaRow3[0]?.location === "Adrian", `loc=${danaRow3[0]?.location}`);

  c = await chat(danaConv, "my phone is 5550101234");
  pass("C10 S1 fully qualified (status qualified)", c.bundle.lead?.status === "qualified", `status=${c.bundle.lead?.status}`);
  const danaRow4 = await db.select().from(s.leads).where(eq(s.leads.id, danaLead)).execute();
  const dana = danaRow4[0];
  pass("C11 §34 qualification rubric scored", !!dana && dana.scoreValue > 0 && ["HOT", "WARM", "COLD"].includes(dana.classification ?? ""), `score=${dana?.scoreValue} class=${dana?.classification}`);
  pass("C12 §34 score_lead action audited", (await db.select().from(s.agentActions).where(eq(s.agentActions.businessId, bizA)).execute()).some((a) => a.action === "score_lead" && a.leadId === danaLead && a.success === 1), "");
  const fupsDana = await db.select().from(s.followUps).where(eq(s.followUps.leadId, danaLead)).execute();
  pass("C13 qualification starts follow-up sequence", fupsDana.some((f) => f.status === "pending" && /^seq_/.test(f.templateKey ?? "")), `fups=${fupsDana.map((f) => f.templateKey).join(",")}`);

  // =========================== D) §35 SCENARIO 2: APPOINTMENT, REAL TIMES ONLY
  const matchedService = [acRepair, acTune, furnaceInstall].find((sv) => sv?.name === dana.serviceRequested) ?? acRepair;
  c = await chat(danaConv, "Can someone come tomorrow afternoon?");
  const di2 = await lastIntent(bizA, danaConv);
  pass("D1 S2 intent APPOINTMENT_REQUEST", di2?.intent === "APPOINTMENT_REQUEST", `got ${di2?.intent}`);
  const timeRe = /\d{1,2}:\d{2}\s*(AM|PM)/i;
  pass("D2 S2 offers times", timeRe.test(c.reply), `reply="${c.reply.slice(0, 120)}"`);
  // Cross-check: every offered time must be a REAL slot from the calendar for
  // the SAME service the AI matched (never invented — spec rule 2).
  const avail = await api("/api/appointments/availability", { method: "POST", body: { serviceId: matchedService.id, days: 3 } });
  const days = avail.json.days ?? [];
  const expected = new Map<string, string[]>();
  for (const d of days.slice(0, 3)) expected.set(d.date, d.slots.slice(0, 4).map((x: any) => fmtTime(x.startAt)));
  const offeredLines = c.reply.split("\n").filter((l: string) => /^\d{4}-\d{2}-\d{2}: /.test(l));
  const allReal = offeredLines.every((l: string) => {
    const [date, rest] = l.split(": ");
    const times = rest.split(", ").map((t) => t.trim());
    return expected.has(date) && times.every((t) => expected.get(date)!.includes(t));
  });
  pass("D3 S2 REAL available times only (cross-checked)", offeredLines.length > 0 && allReal, `lines=${offeredLines.length} days=${days.length}`);
  const calCheck = (await db.select().from(s.agentActions).where(eq(s.agentActions.businessId, bizA)).execute()).find((a) => a.action === "check_calendar" && a.leadId === danaLead && a.success === 1);
  pass("D4 S2 check_calendar tool audited (real calendar)", !!calCheck, "");
  pass("D5 S2 APPOINTMENT_REQUESTED event emitted", (await db.select().from(s.events).where(eq(s.events.businessId, bizA)).execute()).some((e) => e.type === "APPOINTMENT_REQUESTED" && e.leadId === danaLead), "");

  // ===================================== E) APPOINTMENT BOOKING §34 + STOP RULE
  // Pick the first slot that is still in the future (today's earlier slots may
  // already be past by run time — the calendar mock generates the whole day).
  const slot = days.flatMap((d: any) => d.slots).find((x: any) => x.startAt > Date.now()) ?? days[0]?.slots?.[0];
  r = await api("/api/appointments", { method: "POST", body: { leadId: danaLead, serviceId: matchedService.id, startAt: slot.startAt } });
  pass("E1 booking real slot -> 201", r.status === 201 && !!r.json.appointment?.id, `status=${r.status} err=${r.json.error ?? ""}`);
  const appts = await db.select().from(s.appointments).where(eq(s.appointments.leadId, danaLead)).execute();
  pass("E2 appointment row created (booked)", appts.some((a) => a.status === "booked" && a.businessId === bizA), `n=${appts.length}`);
  const danaAfter = (await db.select().from(s.leads).where(eq(s.leads.id, danaLead)).execute())[0];
  pass("E3 lead status appointment_booked", danaAfter?.status === "appointment_booked", `status=${danaAfter?.status}`);
  const fupsAfterBook = await db.select().from(s.followUps).where(eq(s.followUps.leadId, danaLead)).execute();
  pass("E4 §34 follow-ups stop on booking", !fupsAfterBook.some((f) => f.status === "pending"), fupsAfterBook.map((f) => f.status).join(","));
  const msgsDana = await db.select().from(s.messages).where(eq(s.messages.conversationId, danaConv)).execute();
  pass("E5 confirmation in thread", msgsDana.some((m) => m.sender === "system" && /appointment booked/i.test(m.body)), "");
  const notifsA = await db.select().from(s.notifications).where(eq(s.notifications.businessId, bizA)).execute();
  pass("E6 owner notified", notifsA.some((n) => n.kind === "appointment"), "");
  pass("E7 APPOINTMENT_BOOKED event", (await db.select().from(s.events).where(eq(s.events.businessId, bizA)).execute()).some((e) => e.type === "APPOINTMENT_BOOKED" && e.leadId === danaLead), "");
  // Invented time (3 AM — outside business hours) must be rejected, never booked.
  const inventedAt = Math.floor((Date.now() + 48 * 3600_000) / 3600_000) * 3600_000 + 3 * 3600_000;
  r = await api("/api/appointments", { method: "POST", body: { leadId: danaLead, serviceId: matchedService.id, startAt: inventedAt } });
  pass("E8 invented (non-available) time rejected 400", r.status === 400, `status=${r.status}`);

  // ===================================== F) §35 SCENARIO 3: UNKNOWN PRICING
  const { convId: priceConv } = await newConversation();
  let p = await chat(priceConv, "How much does a new AC unit cost?");
  const di3 = await lastIntent(bizA, priceConv);
  pass("F1 S3 intent PRICE_INQUIRY", di3?.intent === "PRICE_INQUIRY", `got ${di3?.intent}`);
  const EXACT_ESTIMATE = "The exact cost depends on the system and installation. I can have the team provide you with an estimate.";
  pass("F2 S3 exact fallback phrase (never invented price)", p.reply.includes(EXACT_ESTIMATE), `reply="${p.reply.slice(0, 140)}"`);
  pass("F3 S3 no dollar amount in reply", !/\$\s*\d/.test(p.reply), "");
  pass("F4 S3 no escalation on estimate (clarify, not escalate)", p.bundle.conversation?.aiEnabled === 1, `ai=${p.bundle.conversation?.aiEnabled}`);
  p = await chat(priceConv, "How much is an AC tune-up?");
  pass("F5 configured KB pricing honored (not invented)", /129/.test(p.reply) && /tune/i.test(p.reply), `reply="${p.reply.slice(0, 120)}"`);

  // ====================== G) KNOWLEDGE RETRIEVAL + HALLUCINATION PREVENTION §34
  const { convId: kbConv } = await newConversation();
  let g = await chat(kbConv, "Do you service the whole house?");
  pass("G1 KB retrieval answers from business KB", /entire home/.test(g.reply), `reply="${g.reply.slice(0, 120)}"`);
  g = await chat(kbConv, "What's the warranty on duct cleaning?");
  pass("G2 never fabricate (Balanced -> escalate, no invented answer)", g.reply === "I want to make sure you get the right answer, so I'm going to have someone from the team take a look at this. I've passed along the details you've provided." && !/year|warrant/i.test(g.reply), `reply="${g.reply.slice(0, 120)}"`);
  pass("G3 no-answer -> human task + takeover", g.bundle.conversation?.status === "human_takeover" && g.bundle.conversation?.aiEnabled === 0, `status=${g.bundle.conversation?.status}`);
  // Conservative sensitivity: genuine no-answer stays a clarify (never fabricate, never escalate).
  r = await api("/api/ai/config", { method: "PUT", body: { escalationSensitivity: "Conservative" } });
  pass("G4 sensitivity set Conservative", r.status === 200, `status=${r.status}`);
  const { convId: consConv } = await newConversation();
  g = await chat(consConv, "Do you offer senior discounts?");
  pass("G5 Conservative: clarify phrase, no fabrication", g.reply === "I don't want to give you inaccurate information. I can have someone from the team confirm that for you.", `reply="${g.reply.slice(0, 120)}"`);
  pass("G6 Conservative: no escalation on clarify", g.bundle.conversation?.aiEnabled === 1, `ai=${g.bundle.conversation?.aiEnabled}`);
  r = await api("/api/ai/config", { method: "PUT", body: { escalationSensitivity: "Balanced" } });
  pass("G7 sensitivity restored Balanced", r.status === 200, `status=${r.status}`);

  // =========================================== H) CALENDAR FAILURE §34 (§12–14)
  // In-process: point CALENDAR_PROVIDER at an unimplemented provider so the
  // calendar "outage" is deterministic; the HTTP server process is untouched.
  const { leadId: calLead, convId: calConv } = await newConversation();
  let h = await chat(calConv, "My AC isn't working");
  pass("H1 setup: service identified before failure", /name/i.test(h.reply), "");
  process.env.CALENDAR_PROVIDER = "brain6-failing-provider";
  let calError: unknown = null;
  try {
    const bundle = await handleLeadMessage(bizA, calConv, "Can someone come tomorrow afternoon?");
    const msgs: { sender: string; body: string }[] = bundle.messages ?? [];
    h = { status: 200, bundle, reply: [...msgs].reverse().find((m) => m.sender === "ai")?.body ?? "" };
  } catch (e) {
    calError = e;
  }
  delete process.env.CALENDAR_PROVIDER;
  pass("H2 calendar failure does not crash the conversation", calError === null, calError ? String(calError).slice(0, 120) : "");
  pass("H3 never claims booked, spec failure phrase", h.reply.includes("I'm having trouble accessing the scheduling system right now. I've sent this to the team so they can confirm your appointment."), `reply="${h.reply.slice(0, 150)}"`);
  pass("H4 no invented times offered", !/^\d{4}-\d{2}-\d{2}: \d/.test(h.reply) && !/\n\nHere are the next open times I can offer \([^)]+\):/.test(h.reply), "");
  const calTasks = (await tasksFor(bizA)).filter((t) => t.leadId === calLead);
  pass("H5 §31 human task created for calendar failure", calTasks.some((t) => t.reason === "calendar-failure" && t.priority === "medium"), calTasks.map((t) => t.reason).join(","));
  const calAppts = await db.select().from(s.appointments).where(eq(s.appointments.leadId, calLead)).execute();
  pass("H6 no appointment row created on failure", calAppts.length === 0, `n=${calAppts.length}`);
  const failedCalCheck = (await db.select().from(s.agentActions).where(eq(s.agentActions.businessId, bizA)).execute()).filter((a) => a.action === "check_calendar" && a.leadId === calLead && a.success === 0);
  pass("H7 failed check_calendar audited (never silent)", failedCalCheck.length > 0, `n=${failedCalCheck.length}`);

  // ========================= I) §35 SCENARIOS 4+5: HUMAN ESCALATION (§18, §34)
  const { leadId: angryLead, convId: angryConv } = await newConversation();
  let i4 = await chat(angryConv, "Your technician damaged my floor!");
  const di4 = await lastIntent(bizA, angryConv);
  pass("I1 S4 intent COMPLAINT", di4?.intent === "COMPLAINT", `got ${di4?.intent}`);
  pass("I2 S4 immediate escalation message", i4.reply === "I want to make sure you get the right answer, so I'm going to have someone from the team take a look at this. I've passed along the details you've provided.", `reply="${i4.reply.slice(0, 120)}"`);
  pass("I3 S4 lead needs_human", i4.bundle.lead?.status === "needs_human", `status=${i4.bundle.lead?.status}`);
  pass("I4 S4 conversation human-held", i4.bundle.conversation?.status === "human_takeover" && i4.bundle.conversation?.aiEnabled === 0, `status=${i4.bundle.conversation?.status}`);
  const angryTasks = (await tasksFor(bizA)).filter((t) => t.leadId === angryLead);
  pass("I5 S4 escalation task (high, complaint)", angryTasks.some((t) => t.priority === "high" && t.reason === "complaint" && t.conversationSummary?.length && t.recommendedAction?.length), angryTasks.map((t) => `${t.priority}/${t.reason}`).join(","));
  pass("I6 S4 no confidence/score leak", !/confidence|score|HOT|WARM|COLD/i.test(i4.reply), "");
  pass("I7 S4 owner notified (escalation)", (await db.select().from(s.notifications).where(eq(s.notifications.businessId, bizA)).execute()).some((n) => n.kind === "escalation"), "");

  const { leadId: humanLead, convId: humanConv } = await newConversation();
  let i5 = await chat(humanConv, "I want to talk to a person.");
  const di5 = await lastIntent(bizA, humanConv);
  pass("I8 S5 intent HUMAN_REQUEST", di5?.intent === "HUMAN_REQUEST", `got ${di5?.intent}`);
  pass("I9 S5 escalated to human", i5.bundle.conversation?.status === "human_takeover" && /someone from the team/i.test(i5.reply), `status=${i5.bundle.conversation?.status}`);
  const humanTasks5 = (await tasksFor(bizA)).filter((t) => t.leadId === humanLead);
  pass("I10 S5 escalation task + HUMAN_ESCALATION event", humanTasks5.some((t) => t.reason === "human-request" && t.priority === "medium") && (await db.select().from(s.events).where(eq(s.events.businessId, bizA)).execute()).some((e) => e.type === "HUMAN_ESCALATION" && e.leadId === humanLead), "");

  // ================================ J) §35 SCENARIO 6: OPT-OUT ("Stop texting")
  const { leadId: optLead, convId: optConv } = await newConversation();
  await chat(optConv, "My AC isn't working");
  await chat(optConv, "My name is Ben");
  await chat(optConv, "I'm in Adrian");
  let j = await chat(optConv, "my phone is 5550104321");
  pass("J1 setup: qualified + sequence started", j.bundle.lead?.status === "qualified" && (await db.select().from(s.followUps).where(eq(s.followUps.leadId, optLead)).execute()).some((f) => f.status === "pending"), `status=${j.bundle.lead?.status}`);
  j = await chat(optConv, "Stop texting me.");
  const optRow = (await db.select().from(s.leads).where(eq(s.leads.id, optLead)).execute())[0];
  pass("J2 S6 lead marked opted out", optRow?.optedOut === 1 && optRow?.optOutChannel === "all", `optedOut=${optRow?.optedOut} ch=${optRow?.optOutChannel}`);
  const optFups = await db.select().from(s.followUps).where(eq(s.followUps.leadId, optLead)).execute();
  pass("J3 S6 automated messaging stopped immediately", !optFups.some((f) => f.status === "pending"), optFups.map((f) => f.status).join(","));
  pass("J4 S6 confirmation reply", /we'll stop sending follow-up messages/i.test(j.reply), `reply="${j.reply.slice(0, 110)}"`);
  pass("J5 S6 CUSTOMER_OPTED_OUT event", (await db.select().from(s.events).where(eq(s.events.businessId, bizA)).execute()).some((e) => e.type === "CUSTOMER_OPTED_OUT" && e.leadId === optLead), "");
  pass("J6 S6 stop logged (opt_out action)", (await db.select().from(s.agentActions).where(eq(s.agentActions.businessId, bizA)).execute()).some((a) => a.action === "opt_out" && a.leadId === optLead && a.success === 1), "");
  pass("J7 S6 conversation stays AI-handled (no takeover)", j.bundle.conversation?.aiEnabled === 1, `ai=${j.bundle.conversation?.aiEnabled}`);

  // ================================== K) FOLLOW-UP STOPPING §34 (send-time check)
  const stopped = optFups.filter((f) => f.status === "cancelled");
  let kErr = "";
  if (stopped[0]) {
    try {
      await sendFollowUpRow(bizA, stopped[0].id);
      kErr = "no error thrown";
    } catch (e) {
      kErr = (e as Error).message;
    }
  }
  pass("K1 stopped sequence can never send (send-time re-check)", stopped.length > 0 && /not pending/i.test(kErr), kErr.slice(0, 120));
  const runs = await db.select().from(s.automationRuns).where(eq(s.automationRuns.leadId, optLead)).execute();
  pass("K2 follow-up runs cancelled", runs.length > 0 && runs.every((rn) => rn.status === "cancelled"), runs.map((rn) => rn.status).join(","));
  pass("K3 booking + opt-out both stop sequences (no pending anywhere)", fupsAfterBook.every((f) => f.status !== "pending") && optFups.every((f) => f.status !== "pending"), "");

  // ======================================== L) TENANT ISOLATION §33/§34
  r = await api("/api/auth/signup", { method: "POST", key: "b", body: { name: "Brain6 B", email: EMAIL_B, password: "brain61234" } });
  userIdB = r.json.user?.id ?? "";
  pass("L1 signup owner B", r.status === 200 && !!userIdB, `status ${r.status}`);
  r = await api("/api/business", { method: "POST", key: "b", body: { name: "Isolation Roofing", category: "roofing" } });
  bizB = r.json.business?.id ?? "";
  pass("L2 business B created (no KB/services/hours)", (r.status === 200 || r.status === 201) && !!bizB, `status ${r.status}`);
  r = await api("/api/knowledge", { key: "b" });
  pass("L3 B sees no knowledge from A", r.status === 200 && (r.json.entries ?? []).length === 0, `entries=${(r.json.entries ?? []).length}`);
  const { leadId: bLead, convId: bConv } = await newConversation("b", "Bob");
  const bLeadRow = (await db.select().from(s.leads).where(eq(s.leads.id, bLead)).execute())[0];
  pass("L4 B lead tenant-scoped to B", bLeadRow?.businessId === bizB, `biz=${bLeadRow?.businessId === bizB}`);
  const l = await chat(bConv, "Do you service the whole house?", "b");
  pass("L5 B's AI never answers from A's KB", !/entire home/.test(l.reply), `reply="${l.reply.slice(0, 120)}"`);
  r = await api(`/api/leads/${danaLead}`, { key: "b" });
  pass("L6 cross-tenant lead read -> 404", r.status === 404, `status=${r.status}`);
  let tenantErr: unknown = null;
  try {
    await callAiTool("get_lead", { businessId: bizB, agent: "brain6-test" }, { lead_id: danaLead });
  } catch (e) {
    tenantErr = e;
  }
  pass("L7 tool registry rejects cross-tenant lead (tenant_mismatch)", tenantErr instanceof ToolError && (tenantErr as ToolError).code === "tenant_mismatch", tenantErr ? (tenantErr as ToolError).message.slice(0, 120) : "no error");
  const bizInfo = (await callAiTool("get_business_info", { businessId: bizB, agent: "brain6-test" }, {})) as { name: string };
  pass("L8 business context isolated", bizInfo.name === "Isolation Roofing", `name=${bizInfo.name}`);
  const rejectedAudit = (await db.select().from(s.agentActions).where(eq(s.agentActions.businessId, bizB)).execute()).some((a) => a.action === "get_lead" && a.success === 0 && parseJson<{ rejected?: boolean }>(a.resultJson, {}).rejected === true);
  pass("L9 cross-tenant attempt audited", rejectedAudit, "");
  r = await api("/api/knowledge");
  pass("L10 A's KB intact (both directions)", r.status === 200 && (r.json.entries ?? []).length === 2, `entries=${(r.json.entries ?? []).length}`);

  // ======================================== M) PERMISSION ENFORCEMENT §24–25
  let permErr: unknown = null;
  try {
    await callAiTool("refund", { businessId: bizA, agent: "brain6-test", leadId: danaLead }, { lead_id: danaLead, amount_cents: 100 });
  } catch (e) {
    permErr = e;
  }
  pass("M1 HIGH_RISK refund blocked for AI", permErr instanceof ToolError && (permErr as ToolError).code === "permission_denied", permErr ? (permErr as ToolError).message.slice(0, 120) : "no error");
  const refundAudits = (await db.select().from(s.agentActions).where(eq(s.agentActions.businessId, bizA)).execute()).filter((a) => a.action === "refund" && a.success === 0);
  pass("M2 blocked HIGH_RISK audited", refundAudits.some((a) => parseJson<{ rejected?: boolean }>(a.resultJson, {}).rejected === true), `n=${refundAudits.length}`);
  const permTasks = (await tasksFor(bizA)).filter((t) => /HIGH_RISK tool 'refund'/.test(t.reason ?? ""));
  pass("M3 HIGH_RISK attempt -> human task", permTasks.length > 0, `n=${permTasks.length}`);
  pass("M4 AI has no HIGH_RISK tools by construction", !AI_ACCESSIBLE_TOOLS.some((t) => ["refund", "cancel_appointment", "change_billing", "modify_sensitive_data"].includes(t)) && AI_ACCESSIBLE_TOOLS.every((t) => TOOL_REGISTRY.find((x) => x.name === t)?.permissionLevel !== "HIGH_RISK"), "");
  const highRisk = TOOL_REGISTRY.filter((t) => t.permissionLevel === "HIGH_RISK");
  pass("M5 HIGH_RISK registry complete (4 tools)", ["cancel_appointment", "refund", "change_billing", "modify_sensitive_data"].every((n) => highRisk.some((t) => t.name === n)) && highRisk.length === 4, highRisk.map((t) => t.name).join(","));
  pass("M6 every tool declares permission/schema/validate/handler/audit", TOOL_REGISTRY.every((t) => ["READ", "WRITE", "HIGH_RISK"].includes(t.permissionLevel) && !!t.inputSchema && typeof t.validate === "function" && typeof t.handler === "function" && t.audit === true), `tools=${TOOL_REGISTRY.length}`);
  let unknownErr: unknown = null;
  try {
    await callAiTool("bogus_tool", { businessId: bizA, agent: "brain6-test" }, {});
  } catch (e) {
    unknownErr = e;
  }
  pass("M7 unknown tool rejected (unknown_tool)", unknownErr instanceof ToolError && (unknownErr as ToolError).code === "unknown_tool", "");
  let invalidErr: unknown = null;
  try {
    await callAiTool("create_lead", { businessId: bizA, agent: "brain6-test" }, {});
  } catch (e) {
    invalidErr = e;
  }
  pass("M8 invalid tool input rejected (invalid_input)", invalidErr instanceof ToolError && (invalidErr as ToolError).code === "invalid_input", "");

  // ========================== N) §35 SCENARIO 7: OUTSIDE SERVICE AREA -> UNQUAL
  const { leadId: outLead, convId: outConv } = await newConversation();
  await chat(outConv, "My AC isn't working");
  await chat(outConv, "My name is Chris");
  let n7 = await chat(outConv, "I'm in Toledo");
  const outRow = (await db.select().from(s.leads).where(eq(s.leads.id, outLead)).execute())[0];
  pass("N1 S7 lead status UNQUALIFIED", n7.bundle.lead?.status === "unqualified" || outRow?.status === "unqualified", `status=${n7.bundle.lead?.status ?? outRow?.status}`);
  pass("N2 S7 classification UNQUALIFIED", outRow?.classification === "UNQUALIFIED", `class=${outRow?.classification}`);
  const areaCheck = (await db.select().from(s.agentActions).where(eq(s.agentActions.businessId, bizA)).execute()).filter((a) => a.action === "service_area_check" && a.leadId === outLead);
  pass("N3 S7 service-area check logged (outside)", areaCheck.some((a) => parseJson<{ verdict?: string }>(a.resultJson, {}).verdict === "outside"), "");
  pass("N4 S7 honest area reply", /service area/i.test(n7.reply) && /passed your details to the team/i.test(n7.reply), `reply="${n7.reply.slice(0, 140)}"`);
  pass("N5 S7 no availability offered outside area", !/Here are the next open times/.test(n7.reply), "");

  // ================================================================== SUMMARY
  console.log(failures === 0 ? "BRAIN6-TEST: ALL PASS" : `BRAIN6-TEST: ${failures} FAILURE(S)`);
  process.exitCode = failures === 0 ? 0 : 1;
})();
// ------------------------------------------------------------------ cleanup
process.on("beforeExit", async () => {
  try {
    const db = getDb();
    // Remove every audit row created after the baseline (owner + admin side effects).
    const audits = await db.select().from(s.auditLogs).execute();
    for (const a of audits.slice(auditBaseline)) {
      await db.delete(s.auditLogs).where(eq(s.auditLogs.id, a.id)).execute();
    }
    for (const b of [bizA, bizB]) {
      if (!b) continue;
      for (const lead of await db.select({ id: s.leads.id }).from(s.leads).where(eq(s.leads.businessId, b)).execute()) {
        for (const a of await db.select().from(s.appointments).where(eq(s.appointments.leadId, lead.id)).execute()) await db.delete(s.appointments).where(eq(s.appointments.id, a.id)).execute();
        await db.delete(s.followUps).where(eq(s.followUps.leadId, lead.id)).execute();
        await db.delete(s.humanTasks).where(eq(s.humanTasks.leadId, lead.id)).execute();
        await db.delete(s.automationRuns).where(eq(s.automationRuns.leadId, lead.id)).execute();
        await db.delete(s.reviews).where(eq(s.reviews.leadId, lead.id)).execute();
        for (const c of await db.select().from(s.conversations).where(eq(s.conversations.leadId, lead.id)).execute()) {
          await db.delete(s.messages).where(eq(s.messages.conversationId, c.id)).execute();
          await db.delete(s.conversations).where(eq(s.conversations.id, c.id)).execute();
        }
        await db.delete(s.agentActions).where(eq(s.agentActions.leadId, lead.id)).execute();
        await db.delete(s.leads).where(eq(s.leads.id, lead.id)).execute();
      }
      await db.delete(s.services).where(eq(s.services.businessId, b)).execute();
      await db.delete(s.knowledgeBase).where(eq(s.knowledgeBase.businessId, b)).execute();
      await db.delete(s.followUpConfigs).where(eq(s.followUpConfigs.businessId, b)).execute();
      await db.delete(s.reviewConfigs).where(eq(s.reviewConfigs.businessId, b)).execute();
      await db.delete(s.notifications).where(eq(s.notifications.businessId, b)).execute();
      await db.delete(s.usageEvents).where(eq(s.usageEvents.businessId, b)).execute();
      await db.delete(s.auditLogs).where(eq(s.auditLogs.businessId, b)).execute();
      await db.delete(s.widgetSettings).where(eq(s.widgetSettings.businessId, b)).execute();
      await db.delete(s.integrations).where(eq(s.integrations.businessId, b)).execute();
      await db.delete(s.subscriptions).where(eq(s.subscriptions.businessId, b)).execute();
      await db.delete(s.events).where(eq(s.events.businessId, b)).execute();
      await db.delete(s.automationRuns).where(eq(s.automationRuns.businessId, b)).execute();
      await db.delete(s.reviews).where(eq(s.reviews.businessId, b)).execute();
      await db.delete(s.humanTasks).where(eq(s.humanTasks.businessId, b)).execute();
      await db.delete(s.businessReports).where(eq(s.businessReports.businessId, b)).execute();
      await db.delete(s.businesses).where(eq(s.businesses.id, b)).execute();
    }
    for (const u of [userIdA, userIdB]) {
      if (!u) continue;
      await db.delete(s.sessions).where(eq(s.sessions.userId, u)).execute();
      await db.delete(s.teamMembers).where(eq(s.teamMembers.userId, u)).execute();
      await db.delete(s.users).where(eq(s.users.id, u)).execute();
    }
    console.log("cleanup done");
  } catch {
    /* best-effort */
  }
});
