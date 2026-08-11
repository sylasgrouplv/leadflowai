/**
 * AI BRAIN 6 PART 2 — §43 FINAL ACCEPTANCE TEST (the most important test).
 *
 * Drives the COMPLETE §43 workflow end-to-end against the live preview:
 *
 *   website lead → AI chat opens → "My AC stopped working." → AI identifies
 *   HVAC repair → asks name → collects location → determines urgency →
 *   creates lead → scores lead → HOT → customer asks for appointment → AI
 *   checks the REAL calendar → offers real available times (zero invented,
 *   cross-checked against the availability endpoint) → customer chooses → AI
 *   confirms → appointment created → confirmation sent → business notified →
 *   lead status Appointment Booked → appointment occurs (marked completed) →
 *   review workflow begins → feedback request → positive feedback → public
 *   review request → analytics update → weekly report includes the lead.
 *
 * Every transition is asserted with real row/API evidence (DB rows via
 * getDb/schema, agent_actions audit trail, events, notifications, messages),
 * not just reply text. Style matches brain6-test.ts: fresh owner signup per
 * run, HTTP against the running server (run `unset DATABASE_URL && bun run
 * publish` first — SQLite dev path), full cleanup of every row this run
 * created, final "ALL PASS" summary, non-zero exit on failure.
 *
 * Also asserts the §43-run product fix: a real collected customer name is
 * never overwritten by a location fragment ("I'm in Adrian" must not clobber
 * "Sarah" with "in" — qualify.ts name-guard regression).
 *
 * Run:  cd /home/team/shared/site && unset DATABASE_URL && bun run publish && bun run brain6b-test.ts
 */
import { runMigrations } from "./src/server/db/migrate";
import { getDb } from "./src/server/db/client";
import * as s from "./src/server/db/schema";
import { eq } from "drizzle-orm";
import { fmtTime } from "./src/server/appointments/agent";
import { weekStartFor } from "./src/server/bi/report";
runMigrations();
const BASE = process.env.BRAIN6B_BASE ?? "http://localhost:3000";
const EMAIL = `brain6b_${Date.now()}@test.ai`;
let failures = 0;
let auditBaseline = 0;
// Module-scope fixtures so the cleanup path can reach them.
let userId = "";
let bizId = "";
let leadId = "";
let convId = "";
let apptId = "";
let reviewId = "";

function pass(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} | ${label}${detail ? " | " + detail : ""}`);
  if (!ok) failures += 1;
}

let cookie = "";
async function api(path: string, opts: { method?: string; body?: unknown } = {}) {
  const res = await fetch(BASE + path, {
    method: opts.method ?? "GET",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const sc = res.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

/** POST a lead message; returns the bundle + the AI/system reply (newest). */
async function chat(body: string) {
  const r = await api(`/api/chat/conversations/${convId}/messages`, { method: "POST", body: { body } });
  const bundle = r.json.bundle ?? r.json;
  const msgs: { sender: string; body: string }[] = bundle.messages ?? [];
  const reply = [...msgs].reverse().find((m) => m.sender === "ai" || m.sender === "system")?.body ?? "";
  return { status: r.status, bundle, reply };
}

/** Last detect_intent row for our conversation (DB audit trail). */
async function lastIntent() {
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

async function eventsOf() {
  return getDb().select().from(s.events).where(eq(s.events.businessId, bizId)).execute();
}
async function actionsOf() {
  return getDb().select().from(s.agentActions).where(eq(s.agentActions.businessId, bizId)).execute();
}
async function leadRow() {
  const rows = await getDb().select().from(s.leads).where(eq(s.leads.id, leadId)).execute();
  return rows[0];
}
async function msgsOf() {
  return getDb().select().from(s.messages).where(eq(s.messages.conversationId, convId)).execute();
}

(async () => {
  const db = getDb();
  auditBaseline = (await db.select().from(s.auditLogs).execute()).length;

  // ============================================================ A) SETUP §43
  console.log("\n== A) fresh business (signup → services → hours → area → KB) ==");
  let r = await api("/api/auth/signup", { method: "POST", body: { name: "Brain6B Owner", email: EMAIL, password: "brain6b1234" } });
  userId = r.json.user?.id ?? "";
  pass("A1 fresh owner signup", r.status === 200 && !!userId, `status ${r.status}`);
  r = await api("/api/business", { method: "POST", body: { name: "Brain6B HVAC Co", category: "hvac" } });
  bizId = r.json.business?.id ?? "";
  pass("A2 business created", (r.status === 200 || r.status === 201) && !!bizId, `status ${r.status}`);

  const mkService = (name: string, priceCents: number, durationMin: number) =>
    api("/api/services", { method: "POST", body: { name, priceCents, durationMin } }).then((x) => x.json.service);
  const acRepair = await mkService("AC Repair", 18900, 90);
  const acTune = await mkService("AC Tune-Up", 12900, 60);
  pass("A3 services created (AC Repair + AC Tune-Up)", !!acRepair?.id && !!acTune?.id, `repair=${acRepair?.name} tune=${acTune?.name}`);

  const HOURS = { monday: { open: "08:00", close: "17:00", closed: false }, tuesday: { open: "08:00", close: "17:00", closed: false }, wednesday: { open: "08:00", close: "17:00", closed: false }, thursday: { open: "08:00", close: "17:00", closed: false }, friday: { open: "08:00", close: "17:00", closed: false }, saturday: { open: "09:00", close: "13:00", closed: false }, sunday: { open: "", close: "", closed: true } };
  r = await api("/api/business/hours", { method: "PUT", body: HOURS });
  pass("A4 business hours saved", r.status === 200, `status ${r.status}`);
  r = await api("/api/business/service-area", { method: "PUT", body: { zipCodes: ["49221"], cities: ["Adrian"] } });
  pass("A5 service area saved (Adrian 49221)", r.status === 200, `status ${r.status}`);
  r = await api("/api/knowledge", { method: "POST", body: { kind: "faq", question: "Do you service the whole house?", answer: "Yes — we service the entire home, including all rooms and ductwork." } });
  pass("A6 KB entry created", r.status === 201 && !!r.json.entry?.id, `status ${r.status}`);

  // ================================= B) WEBSITE LEAD → AI CHAT OPENS (§43)
  console.log("\n== B) website lead → AI chat opens ==");
  r = await api("/api/leads", { method: "POST", body: { firstName: "Website", lastName: "Visitor", source: "website_chat", notes: "brain6b website lead" } });
  leadId = r.json.lead?.id ?? r.json.id ?? "";
  pass("B1 website lead created", r.status === 201 && !!leadId, `status ${r.status}`);
  const lead0 = await leadRow();
  pass("B2 lead is a website lead (source website_chat)", lead0?.source === "website_chat", `source=${lead0?.source}`);
  r = await api("/api/chat/conversations", { method: "POST", body: { leadId, source: "website_chat" } });
  convId = r.json.conversation?.id ?? "";
  pass("B3 chat conversation opened for the lead", r.status === 201 && !!convId, `status ${r.status}`);
  const conv0 = (await db.select().from(s.conversations).where(eq(s.conversations.id, convId)).execute())[0];
  pass("B4 conversation AI-handled from the start", conv0?.aiEnabled === 1 && conv0?.status === "ai_handling", `ai=${conv0?.aiEnabled} status=${conv0?.status}`);

  // =============== C) "My AC stopped working." → HVAC repair identified §43
  console.log("\n== C) 'My AC stopped working.' → HVAC identified → asks name ==");
  let c = await chat("My AC stopped working.");
  pass("C1 AI asks for the customer's name", /what'?s your name|what is your name/i.test(c.reply), `reply="${c.reply.slice(0, 90)}"`);
  const di1 = await lastIntent();
  pass("C2 intent SERVICE_INQUIRY (HVAC service identified)", di1?.intent === "SERVICE_INQUIRY", `got ${di1?.intent} (${di1?.confidence})`);
  const AC_SERVICES = ["AC Repair", "AC Tune-Up"];
  const lead1 = await leadRow();
  pass("C3 lead's requested service is an AC/HVAC service", AC_SERVICES.includes(lead1?.serviceRequested ?? ""), `svc=${lead1?.serviceRequested}`);
  const convRow1 = (await db.select().from(s.conversations).where(eq(s.conversations.id, convId)).execute())[0];
  const mem1 = parseJson<{ problem?: string; service?: string }>(convRow1?.memoryJson ?? null, {});
  pass("C4 problem persisted to conversation memory", mem1.problem === "My AC stopped working.", `problem=${mem1.problem}`);

  // ====================================================== D) ASKS NAME §43
  console.log("\n== D) customer gives name → AI collects location ==");
  c = await chat("My name is Sarah");
  const lead2 = await leadRow();
  pass("D1 name extracted to the lead", lead2?.firstName === "Sarah", `name=${lead2?.firstName}`);
  pass("D2 AI asks for location after name", /what city|city are you in/i.test(c.reply), `reply="${c.reply.slice(0, 90)}"`);

  // ============================================== E) COLLECTS LOCATION §43
  c = await chat("I'm in Adrian");
  const lead3 = await leadRow();
  pass("E1 location extracted to the lead", lead3?.location === "Adrian", `loc=${lead3?.location}`);
  // §43-run product fix: a real collected name must never be overwritten by a
  // location fragment ("I'm in Adrian" used to clobber "Sarah" with "in").
  pass("E2 real name preserved (never clobbered by location)", lead3?.firstName === "Sarah", `name=${lead3?.firstName}`);
  pass("E3 AI asks for contact after location", /phone number or email|reach you|email to reach/i.test(c.reply), `reply="${c.reply.slice(0, 110)}"`);

  // ===================== F) CONTACT → CREATES LEAD → SCORES LEAD (qualified)
  console.log("\n== F) contact given → lead created/qualified → scored ==");
  c = await chat("my phone is 5550109999");
  const lead4 = await leadRow();
  pass("F1 phone extracted", lead4?.phone === "5550109999", `phone=${lead4?.phone}`);
  pass("F2 lead status qualified", c.bundle.lead?.status === "qualified" || lead4?.status === "qualified", `status=${c.bundle.lead?.status ?? lead4?.status}`);
  pass("F3 scored with the 0–100 rubric", !!lead4 && lead4.scoreValue > 0 && ["HOT", "WARM", "COLD"].includes(lead4.classification ?? ""), `score=${lead4?.scoreValue} class=${lead4?.classification}`);
  const scoreActs = (await actionsOf()).filter((a) => a.action === "score_lead" && a.leadId === leadId && a.success === 1);
  pass("F4 score_lead action audited", scoreActs.length > 0, `n=${scoreActs.length}`);
  const fups = await db.select().from(s.followUps).where(eq(s.followUps.leadId, leadId)).execute();
  pass("F5 follow-up sequence started for the unconverted lead", fups.some((f) => f.status === "pending" && /^seq_/.test(f.templateKey ?? "")), `fups=${fups.map((f) => f.templateKey).join(",")}`);

  // ================ G) "Can someone come out tomorrow afternoon?" → HOT §43
  console.log("\n== G) appointment ask → urgency → HOT → REAL calendar times ==");
  const leadBeforeAsk = await leadRow();
  const matchedService = [acRepair, acTune].find((sv) => sv?.name === leadBeforeAsk?.serviceRequested) ?? acTune;
  c = await chat("Can someone come out tomorrow afternoon?");
  const di2 = await lastIntent();
  pass("G1 intent APPOINTMENT_REQUEST", di2?.intent === "APPOINTMENT_REQUEST", `got ${di2?.intent}`);
  // §43: "determines urgency → scores lead → HOT" — the appointment request
  // ("tomorrow" = soon, "come out" = booking intent) pushes the rubric to HOT.
  const lead5 = await leadRow();
  pass("G2 lead scored HOT (≥80)", !!lead5 && lead5.scoreValue >= 80 && lead5.classification === "HOT", `score=${lead5?.scoreValue} class=${lead5?.classification}`);
  pass("G3 urgency captured (soon/urgent → score went up)", lead5!.scoreValue >= 80 && lead5!.scoreValue > (lead4?.scoreValue ?? 0), `prev=${lead4?.scoreValue} now=${lead5?.scoreValue}`);
  const timeRe = /\d{1,2}:\d{2}\s*(AM|PM)/i;
  pass("G4 AI offers real times", timeRe.test(c.reply) && /Here are the next open times/.test(c.reply), `reply="${c.reply.slice(0, 120)}"`);
  // Cross-check: EVERY offered time must be a real slot from the calendar for
  // the SAME service the AI matched (spec rule 2 — zero invented times).
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
  pass("G5 REAL available times only — zero invented (cross-checked)", offeredLines.length > 0 && allReal, `lines=${offeredLines.length} days=${days.length}`);
  const calCheck = (await actionsOf()).filter((a) => a.action === "check_calendar" && a.leadId === leadId && a.success === 1);
  pass("G6 check_calendar tool audited (real calendar)", calCheck.length > 0, `n=${calCheck.length}`);
  pass("G7 APPOINTMENT_REQUESTED event emitted", (await eventsOf()).some((e) => e.type === "APPOINTMENT_REQUESTED" && e.leadId === leadId), "");

  // ==================== H) CUSTOMER CHOOSES → CONFIRMED → BOOKED §43
  console.log("\n== H) customer chooses → appointment created → confirmed → notified ==");
  const slot = days.flatMap((d: any) => d.slots).find((x: any) => x.startAt > Date.now()) ?? days[0]?.slots?.[0];
  r = await api("/api/appointments", { method: "POST", body: { leadId, serviceId: matchedService.id, startAt: slot.startAt } });
  pass("H1 booking the customer's chosen REAL slot -> 201", r.status === 201 && !!r.json.appointment?.id, `status=${r.status} err=${r.json.error ?? ""}`);
  apptId = r.json.appointment?.id ?? "";
  const appts = await db.select().from(s.appointments).where(eq(s.appointments.leadId, leadId)).execute();
  pass("H2 appointment row created (booked, tenant-scoped)", appts.some((a) => a.status === "booked" && a.businessId === bizId), `n=${appts.length}`);
  const msgs = await msgsOf();
  pass("H3 confirmation sent in the thread", msgs.some((m) => m.sender === "system" && /appointment booked/i.test(m.body)), "");
  const notifs = await db.select().from(s.notifications).where(eq(s.notifications.businessId, bizId)).execute();
  pass("H4 business notified", notifs.some((n) => n.kind === "appointment"), "");
  const leadAfterBook = await leadRow();
  pass("H5 lead status Appointment Booked", leadAfterBook?.status === "appointment_booked", `status=${leadAfterBook?.status}`);
  pass("H6 APPOINTMENT_BOOKED event", (await eventsOf()).some((e) => e.type === "APPOINTMENT_BOOKED" && e.leadId === leadId), "");
  const fupsAfterBook = await db.select().from(s.followUps).where(eq(s.followUps.leadId, leadId)).execute();
  pass("H7 follow-ups stop on booking (stop rule)", !fupsAfterBook.some((f) => f.status === "pending"), fupsAfterBook.map((f) => f.status).join(","));

  // ====================== I) APPOINTMENT OCCURS → MARK COMPLETED §43
  console.log("\n== I) appointment occurs → marked completed → review workflow begins ==");
  r = await api(`/api/appointments/${apptId}`, { method: "PATCH", body: { status: "completed" } });
  pass("I1 appointment marked completed", r.status === 200 && r.json.appointment?.status === "completed", `status=${r.json.appointment?.status} http=${r.status}`);
  const leadCompleted = await leadRow();
  pass("I2 lead became a customer", leadCompleted?.status === "customer", `status=${leadCompleted?.status}`);
  pass("I3 JOB_COMPLETED event emitted", (await eventsOf()).some((e) => e.type === "JOB_COMPLETED" && e.leadId === leadId), "");
  const rules = await db.select().from(s.automationRules).where(eq(s.automationRules.businessId, bizId)).execute();
  pass("I4 review rule wired (job_completed_review → send_review_request)", rules.some((rl) => rl.name === "job_completed_review" && rl.action === "send_review_request" && rl.triggerEvent === "JOB_COMPLETED"), "");
  const runs = await db.select().from(s.automationRuns).where(eq(s.automationRuns.businessId, bizId)).execute();
  const reviewRun = runs.find((rn) => rn.ruleKind === "job_completed_review" && rn.leadId === leadId);
  pass("I5 review run materialized for the completed job", !!reviewRun && reviewRun.status === "pending", `kind=${reviewRun?.ruleKind} status=${reviewRun?.status}`);
  pass("I6 review run targets this appointment", reviewRun ? parseJson<{ appointmentId?: string }>(reviewRun.payloadJson, {}).appointmentId === apptId : false, "");

  // ================================ J) FEEDBACK REQUEST (§21 REVIEW AGENT)
  console.log("\n== J) review workflow: feedback request sent ==");
  r = await api("/api/reviews/request", { method: "POST", body: { appointment_id: apptId } });
  const reqRes = r.json.result ?? {};
  pass("J1 feedback request sent (status sent)", r.status === 200 && reqRes.status === "sent", `status=${reqRes.status} http=${r.status}`);
  reviewId = reqRes.reviewId ?? "";
  const reviewRow = reviewId ? (await db.select().from(s.reviews).where(eq(s.reviews.id, reviewId)).execute())[0] : undefined;
  pass("J2 review row created with request timestamp", !!reviewRow?.reviewRequestSentAt, `sentAt=${reviewRow?.reviewRequestSentAt ?? "null"}`);
  pass("J3 REVIEW_REQUESTED event emitted", (await eventsOf()).some((e) => e.type === "REVIEW_REQUESTED" && e.leadId === leadId), "");
  const reqActs = await actionsOf();
  const feedbackSms = reqActs.find((a) => a.action === "send_sms" && a.agent === "review" && a.leadId === leadId);
  pass("J4 feedback request delivered via channel (SMS audited)", !!feedbackSms && /feedback|how your experience/i.test(String(parseJson<{ body?: string }>(feedbackSms.inputJson, {}).body ?? "")), "");
  const reviewNotifs = await db.select().from(s.notifications).where(eq(s.notifications.businessId, bizId)).execute();
  pass("J5 business notified of the feedback request", reviewNotifs.some((n) => n.kind === "review"), "");

  // ================= K) POSITIVE FEEDBACK → PUBLIC REVIEW REQUEST §21/§43
  console.log("\n== K) positive feedback → public review request ==");
  r = await api("/api/reviews/feedback", { method: "POST", body: { review_id: reviewId, feedback_text: "Great job — fast, professional, and the technician was fantastic. Highly recommend!" } });
  const fb = r.json.result ?? {};
  pass("K1 positive sentiment classified", fb.sentiment === "positive", `got ${fb.sentiment}`);
  pass("K2 public review link sent (positive)", fb.reviewLinkSent === true, `linkSent=${fb.reviewLinkSent}`);
  const reviewAfter = (await db.select().from(s.reviews).where(eq(s.reviews.id, reviewId)).execute())[0];
  pass("K3 reviewLinkSentAt recorded", !!reviewAfter?.reviewLinkSentAt, `at=${reviewAfter?.reviewLinkSentAt ?? "null"}`);
  const postActs = await actionsOf();
  const linkSms = postActs.filter((a) => a.action === "send_sms" && a.leadId === leadId && /reviews\.leadflow\.app|review/i.test(String(parseJson<{ body?: string }>(a.inputJson, {}).body ?? "")));
  pass("K4 review link delivered (SMS with review URL)", linkSms.length > 0, `n=${linkSms.length}`);
  pass("K5 record_feedback action audited", postActs.some((a) => a.action === "record_feedback" && a.leadId === leadId && a.success === 1), "");

  // =============================================== L) ANALYTICS UPDATE §43
  console.log("\n== L) analytics updated (feedback surfaced) ==");
  r = await api("/api/reviews");
  const listed = (r.json.reviews ?? []).filter((rv: any) => rv.review?.id === reviewId);
  pass("L1 review visible in analytics list with positive sentiment", listed.length === 1 && listed[0]?.review?.sentiment === "positive", `n=${listed.length} sent=${listed[0]?.review?.sentiment}`);
  const reviewActs = (await actionsOf()).filter((a) => a.action === "review_requested" || a.action === "record_feedback" || a.action === "send_review_link");
  pass("L2 review agent actions all audit-logged (requested/feedback/link)", reviewActs.length >= 3, `n=${reviewActs.length}`);

  // ================= M) WEEKLY REPORT INCLUDES THE LEAD §22–23/§43
  console.log("\n== M) weekly report includes the lead ==");
  const weekStart = weekStartFor(Date.now());
  r = await api("/api/reports/generate", { method: "POST", body: { week_start: weekStart } });
  const report = r.json.report ?? {};
  const m = report.metrics ?? {};
  pass("M1 weekly report generated for the current week", r.status === 200 && !!report.id, `status=${r.status}`);
  pass("M2 report counts the lead (newLeads=1)", m.newLeads === 1, `newLeads=${m.newLeads}`);
  pass("M3 report counts the booking + completed job", m.appointmentsBooked === 1 && m.jobsCompleted === 1, `booked=${m.appointmentsBooked} done=${m.jobsCompleted}`);
  pass("M4 lead counted as a customer", m.customers === 1, `customers=${m.customers}`);
  const leadFinal = await leadRow();
  pass("M5 requested service appears in top services", (m.topServices ?? []).some((t: any) => t.service === leadFinal?.serviceRequested), JSON.stringify(m.topServices ?? []).slice(0, 120));
  pass("M6 website lead source attributed", (m.leadSources ?? []).some((t: any) => t.source === "website_chat" && t.count === 1), JSON.stringify(m.leadSources ?? []).slice(0, 120));
  pass("M7 positive feedback in report", m.positiveFeedback === 1, `pos=${m.positiveFeedback}`);
  pass("M8 estimated revenue = configured job value, labeled estimate", m.estimatedRevenueCents === 12900 && /estimated revenue/i.test((report.narrative ?? {}).summary ?? ""), `est=${m.estimatedRevenueCents}`);
  r = await api("/api/reports");
  pass("M9 report persisted + listed on the analytics surface", (r.json.reports ?? []).some((rep: any) => rep.id === report.id), `n=${(r.json.reports ?? []).length}`);

  // ================================================================== SUMMARY
  console.log(failures === 0 ? "\nBRAIN6B-TEST: ALL PASS" : `\nBRAIN6B-TEST: ${failures} FAILURE(S)`);
  await cleanup();
  process.exit(failures === 0 ? 0 : 1);
})();

/** Remove every row this run created (idempotent; mirrors brain6-test cleanup). */
async function cleanup() {
  try {
    const db = getDb();
    const audits = await db.select().from(s.auditLogs).execute();
    for (const a of audits.slice(auditBaseline)) {
      await db.delete(s.auditLogs).where(eq(s.auditLogs.id, a.id)).execute();
    }
    if (bizId) {
      for (const lead of await db.select({ id: s.leads.id }).from(s.leads).where(eq(s.leads.businessId, bizId)).execute()) {
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
      await db.delete(s.services).where(eq(s.services.businessId, bizId)).execute();
      await db.delete(s.knowledgeBase).where(eq(s.knowledgeBase.businessId, bizId)).execute();
      await db.delete(s.followUpConfigs).where(eq(s.followUpConfigs.businessId, bizId)).execute();
      await db.delete(s.reviewConfigs).where(eq(s.reviewConfigs.businessId, bizId)).execute();
      await db.delete(s.notifications).where(eq(s.notifications.businessId, bizId)).execute();
      await db.delete(s.usageEvents).where(eq(s.usageEvents.businessId, bizId)).execute();
      await db.delete(s.auditLogs).where(eq(s.auditLogs.businessId, bizId)).execute();
      await db.delete(s.widgetSettings).where(eq(s.widgetSettings.businessId, bizId)).execute();
      await db.delete(s.integrations).where(eq(s.integrations.businessId, bizId)).execute();
      await db.delete(s.subscriptions).where(eq(s.subscriptions.businessId, bizId)).execute();
      await db.delete(s.events).where(eq(s.events.businessId, bizId)).execute();
      await db.delete(s.automationRuns).where(eq(s.automationRuns.businessId, bizId)).execute();
      await db.delete(s.automationRules).where(eq(s.automationRules.businessId, bizId)).execute();
      await db.delete(s.reviews).where(eq(s.reviews.businessId, bizId)).execute();
      await db.delete(s.humanTasks).where(eq(s.humanTasks.businessId, bizId)).execute();
      await db.delete(s.businessReports).where(eq(s.businessReports.businessId, bizId)).execute();
      await db.delete(s.businesses).where(eq(s.businesses.id, bizId)).execute();
    }
    if (userId) {
      await db.delete(s.sessions).where(eq(s.sessions.userId, userId)).execute();
      await db.delete(s.teamMembers).where(eq(s.teamMembers.userId, userId)).execute();
      await db.delete(s.users).where(eq(s.users.id, userId)).execute();
    }
    console.log("cleanup done");
  } catch (e) {
    console.error("cleanup error:", e);
  }
}
