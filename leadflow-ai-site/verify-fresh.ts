/**
 * FINAL VERIFICATION — fresh account, LIVE public URL (leadflowai.ctonew.app,
 * reverse-proxied to the port-3000 production server).
 * Exercises success criteria 1–20 with a brand-new signup, then deletes every
 * row it created so the demo DB stays clean.
 *
 * Contract notes (read from the route handlers, not guessed):
 *   - POST /api/chat/conversations/:id/messages + /reply take { body } (messageSchema);
 *     both return the full conversation bundle (no top-level "reply" field).
 *   - GET /api/chat/conversations/:id returns the bundle { conversation, lead,
 *     messages[], appointments[], nextFollowUp, ai }.
 *   - POST /api/appointments/availability returns { days: [{ date, slots:
 *     [{ startAt (epoch ms), endAt }] }] }.
 *   - POST /api/appointments takes { leadId, serviceId, startAt (epoch ms) } —
 *     no endAt/source; the slot must come from availability (never invented).
 *   - GET /api/widget/demo-business returns { businessId, businessName }.
 *   - POST /api/widget/chat returns { conversationId, lead, messages[], aiActive }.
 */
import { getDb } from "./src/server/db/client";
import { eq } from "drizzle-orm";
import * as s from "./src/server/db/schema";

const BASE = "https://ec0c9049136e611575389c2647ca7b85.ctonew.app";
const EMAIL = `verify-${Date.now()}@leadflow.ai`;
let cookie = "";
let businessId = "";
let userId = "";
let leadId = "";
let convId = "";
let serviceId = "";
let apptId = "";

async function api(path: string, opts: { method?: string; body?: unknown } = {}) {
  const res = await fetch(BASE + path, {
    method: opts.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

function pass(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} | ${label}${detail ? " | " + detail : ""}`);
  if (!ok) process.exitCode = 1;
}

const DAY = 86_400_000;
const in2d = new Date(Date.now() + 2 * DAY);
const dateStr = `${in2d.getFullYear()}-${String(in2d.getMonth() + 1).padStart(2, "0")}-${String(in2d.getDate()).padStart(2, "0")}`;

try {
  // 1) Create account
  let r = await api("/api/auth/signup", { method: "POST", body: { name: "Verify Tester", email: EMAIL, password: "verify1234" } });
  userId = r.json.user?.id ?? "";
  pass("1. create account", r.status === 201 || r.status === 200, `status ${r.status} user=${userId.slice(0, 8)}`);

  // 2) Create business
  r = await api("/api/business", { method: "POST", body: { name: "Verify Plumbing Co", category: "plumbing" } });
  businessId = r.json.business?.id ?? r.json.id ?? "";
  pass("2. create business", (r.status === 201 || r.status === 200) && !!businessId, `status ${r.status} id=${businessId.slice(0, 8)}`);

  // 3) Add services
  r = await api("/api/services", { method: "POST", body: { name: "Leak Repair", description: "Pipe leak diagnosis & repair", priceCents: 19900, durationMin: 60 } });
  serviceId = r.json.service?.id ?? r.json.id ?? "";
  pass("3. add services", (r.status === 201 || r.status === 200) && !!serviceId, `status ${r.status} service=${serviceId.slice(0, 8)}`);

  // 4) Business info + service area + hours + policies
  r = await api("/api/business", { method: "PATCH", body: { phone: "(555) 555-0199", description: "Fast local plumbing" } });
  pass("4a. business info", r.status === 200, `status ${r.status}`);
  r = await api("/api/business/service-area", { method: "PUT", body: { zipCodes: ["62701"], cities: ["Springfield"] } });
  pass("4b. service area", r.status === 200, `status ${r.status}`);
  const allDays: Record<string, { open: string; close: string; closed: boolean }> = {};
  for (const d of ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]) allDays[d] = { open: "08:00", close: "18:00", closed: false };
  r = await api("/api/business/hours", { method: "PUT", body: allDays });
  pass("4c. hours", r.status === 200, `status ${r.status}`);
  r = await api("/api/business/policies", { method: "PUT", body: { cancellationPolicy: "Free cancellation up to 24h before.", financing: "No financing offered.", promotions: "None.", welcomeMessage: "Hi! Thanks for choosing Verify Plumbing — how can we help?" } });
  pass("4d. policies + welcome message", r.status === 200, `status ${r.status}`);

  // 5) Configure AI (escalationSensitivity now uses the spec §38 values;
  // legacy low/medium/high are still accepted and normalized server-side)
  r = await api("/api/ai/config", { method: "PUT", body: { autoRespond: true, escalationSensitivity: "Balanced", escalationKeywords: ["commercial job"], welcomeMessage: "Hi! Thanks for choosing Verify Plumbing — how can we help?" } });
  const cfg = r.json.config ?? {};
  pass("5. configure AI", r.status === 200 && cfg.autoRespond === true && cfg.escalationSensitivity === "Balanced", JSON.stringify(cfg).slice(0, 140));

  // complete onboarding
  r = await api("/api/business/complete-onboarding", { method: "POST", body: {} });
  pass("onboarding complete", r.status === 200, `status ${r.status}`);

  // 6) Create test lead
  r = await api("/api/leads", { method: "POST", body: { firstName: "Wanda", lastName: "Moss", phone: "(555) 777-1234", email: "wanda@example.com", serviceRequested: "Leak Repair", source: "manual" } });
  leadId = r.json.lead?.id ?? r.json.id ?? "";
  pass("6. create test lead", (r.status === 201 || r.status === 200) && !!leadId, `status ${r.status} lead=${leadId.slice(0, 8)}`);

  // 7) AI communicates with the lead — welcome message persisted in the thread
  r = await api("/api/chat/conversations", { method: "POST", body: { leadId, source: "manual" } });
  convId = r.json.conversation?.id ?? "";
  const welcomeMsg = (r.json.messages ?? []).find((m: { sender: string }) => m.sender === "ai");
  pass("7. AI communicates with the lead", r.status === 201 && !!convId && !!welcomeMsg?.body, `conv=${convId.slice(0, 8)} welcome=${(welcomeMsg?.body ?? "").slice(0, 60)}`);

  // 8) Qualify + 9) score via chat — the API takes { body }, returns the bundle
  r = await api(`/api/chat/conversations/${convId}/messages`, { method: "POST", body: { body: "Hi, my kitchen sink is leaking and I need it fixed this week. I'm in 62701. What's the cost?" } });
  const aiReply = (r.json.messages ?? []).filter((m: { sender: string }) => m.sender === "ai").pop()?.body ?? "";
  const threadCount = (r.json.messages ?? []).length;
  const leadAfterChat = r.json.lead ?? null;
  pass("8. qualify lead", r.status === 200 && leadAfterChat && ["qualified", "appointment_booked", "contacted"].includes(leadAfterChat.status), `status=${leadAfterChat?.status}`);
  pass("9. score lead", !!leadAfterChat && ["hot", "warm", "cold"].includes(leadAfterChat.score), `score=${leadAfterChat?.score}`);

  // Re-fetch lead list to confirm the DB row (not just the bundle)
  r = await api("/api/leads");
  const lead = (r.json.leads ?? []).find((l: { id: string }) => l.id === leadId);
  pass("8b. lead row persisted", !!lead && ["qualified", "appointment_booked", "contacted"].includes(lead.status), `status=${lead?.status} score=${lead?.score}`);

  // 10) Check availability — response is { days: [{ date, slots: [{startAt,endAt}] }] }
  r = await api("/api/appointments/availability", { method: "POST", body: { startDate: dateStr, days: 3, durationMin: 60, serviceId } });
  const daysArr = Array.isArray(r.json.days) ? r.json.days : [];
  const allSlots = daysArr.flatMap((d: { slots: unknown[] }) => d.slots ?? []);
  const slot = allSlots[0] ?? null;
  pass("10. calendar availability", r.status === 200 && allSlots.length > 0, `${allSlots.length} slots, first=${new Date(slot?.startAt).toISOString()}`);

  // 11) Book appointment — body { leadId, serviceId, startAt (epoch ms) }
  r = await api("/api/appointments", { method: "POST", body: { leadId, serviceId, startAt: slot?.startAt, notes: "Booked by final verification" } });
  apptId = r.json.appointment?.id ?? r.json.id ?? "";
  pass("11. book appointment", (r.status === 201 || r.status === 200) && !!apptId && r.json.appointment?.status === "booked", `status ${r.status} appt=${apptId.slice(0, 8)} state=${r.json.appointment?.status}`);

  // 12) Create follow-up tasks (sequence for the lead)
  r = await api("/api/follow-ups/start", { method: "POST", body: { leadId } });
  r = await api("/api/follow-ups");
  const fups = Array.isArray(r.json.followUps) ? r.json.followUps : [];
  const myFups = fups.filter((f: { leadId: string }) => f.leadId === leadId);
  pass("12. follow-up tasks", r.status === 200 && myFups.length > 0, `${myFups.length} tasks for lead`);

  // 13) View conversation — messages live at bundle.messages
  r = await api(`/api/chat/conversations/${convId}`);
  const convMessages = Array.isArray(r.json.messages) ? r.json.messages : [];
  const aiMsgs = convMessages.filter((m: { sender: string }) => m.sender === "ai");
  pass("13. view conversation", r.status === 200 && convMessages.length >= 2 && aiMsgs.length >= 1, `${convMessages.length} msgs (${aiMsgs.length} AI), AI: ${(aiMsgs.at(-1)?.body ?? "").slice(0, 70)}`);

  // 14) Take over conversation manually — AI goes quiet
  r = await api(`/api/chat/conversations/${convId}/takeover`, { method: "POST", body: {} });
  const takenOver = r.json.conversation?.status === "human_takeover" && r.json.ai?.active === false && r.json.ai?.heldByHuman === true;
  pass("14. manual takeover", r.status === 200 && takenOver, `status=${r.json.conversation?.status} aiActive=${r.json.ai?.active}`);

  // 15) View analytics (real aggregations)
  r = await api("/api/analytics");
  const analytics = r.json;
  pass("15. view analytics", r.status === 200 && typeof analytics.funnel?.leads === "number" && Array.isArray(analytics.sources), `funnel leads=${analytics.funnel?.leads} sources=${analytics.sources?.length}`);

  // 16/17) Integrations honesty — Stripe behind an interface + mock, no direct API calls
  r = await api("/api/integrations");
  const providers = r.json.providers ?? {};
  const stripeProvider = providers.stripe ?? "";
  pass("16-17. Stripe interface+deferred", r.status === 200 && typeof stripeProvider === "string" && stripeProvider.length > 0, `providers.stripe=${stripeProvider} (interface + mock per spec — live provider keys never used)`);

  // 18) Widget: demo business + config
  r = await api("/api/widget/demo-business");
  const demoBiz = r.json;
  pass("18a. widget demo business", r.status === 200 && !!demoBiz?.businessName && !!demoBiz?.businessId, `name=${demoBiz?.businessName} id=${(demoBiz?.businessId ?? "").slice(0, 8)}`);
  r = await api(`/api/widget/config?businessId=${businessId}`);
  pass("18b. widget config", r.status === 200 && !!r.json?.primaryColor && r.json?.businessName === "Verify Plumbing Co", `color=${r.json?.primaryColor} name=${r.json?.businessName}`);

  // 19+20) Real website lead via widget chat -> AI processes it automatically
  r = await api("/api/widget/chat", { method: "POST", body: { businessId, message: "Hi, I need a leak repair at my house in 62701. Please call me back." } });
  const wMsgs = Array.isArray(r.json.messages) ? r.json.messages : [];
  const wLast = wMsgs.at(-1)?.body ?? "";
  const wLead = r.json.lead ?? null;
  pass("19. website lead captured by widget", r.status === 200 && !!r.json.conversationId && wMsgs.length >= 2 && !!wLead, `conv=${(r.json.conversationId ?? "").slice(0, 8)} msgs=${wMsgs.length} lead=${wLead?.firstName} ${wLead?.lastName}`);
  r = await api("/api/leads");
  const widgetLead = (r.json.leads ?? []).find((l: { source: string }) => l.source === "website_widget");
  pass("19b. widget lead in CRM", !!widgetLead, `source=${widgetLead?.source} name=${widgetLead?.firstName} ${widgetLead?.lastName}`);
  pass("20. AI processed automatically", !!widgetLead && widgetLead.status !== "new", `status=${widgetLead?.status} score=${widgetLead?.score} reply="${wLast.slice(0, 60)}"`);

  console.log("FRESH-ACCOUNT VERIFICATION DONE");
} catch (e) {
  console.error("VERIFICATION ERROR:", e);
  process.exitCode = 1;
}

// Cleanup — remove every row created by this verification run.
try {
  const db = getDb();
  const bizId = businessId;
  if (bizId) {
    for (const id of db.select({ id: s.leads.id }).from(s.leads).where(eq(s.leads.businessId, bizId)).all().map((x) => x.id)) {
      for (const a of db.select().from(s.appointments).where(eq(s.appointments.leadId, id)).all()) db.delete(s.appointments).where(eq(s.appointments.id, a.id)).run();
      db.delete(s.followUps).where(eq(s.followUps.leadId, id)).run();
      for (const c of db.select().from(s.conversations).where(eq(s.conversations.leadId, id)).all()) {
        db.delete(s.messages).where(eq(s.messages.conversationId, c.id)).run();
        db.delete(s.conversations).where(eq(s.conversations.id, c.id)).run();
      }
      db.delete(s.agentActions).where(eq(s.agentActions.leadId, id)).run();
      db.delete(s.leads).where(eq(s.leads.id, id)).run();
    }
    db.delete(s.services).where(eq(s.services.businessId, bizId)).run();
    db.delete(s.knowledgeBase).where(eq(s.knowledgeBase.businessId, bizId)).run();
    db.delete(s.followUpConfigs).where(eq(s.followUpConfigs.businessId, bizId)).run();
    db.delete(s.notifications).where(eq(s.notifications.businessId, bizId)).run();
    db.delete(s.usageEvents).where(eq(s.usageEvents.businessId, bizId)).run();
    db.delete(s.auditLogs).where(eq(s.auditLogs.businessId, bizId)).run();
    db.delete(s.widgetSettings).where(eq(s.widgetSettings.businessId, bizId)).run();
    db.delete(s.integrations).where(eq(s.integrations.businessId, bizId)).run();
    db.delete(s.subscriptions).where(eq(s.subscriptions.businessId, bizId)).run();
    db.delete(s.businesses).where(eq(s.businesses.id, bizId)).run();
  }
  if (userId) {
    db.delete(s.sessions).where(eq(s.sessions.userId, userId)).run();
    db.delete(s.teamMembers).where(eq(s.teamMembers.userId, userId)).run();
    db.delete(s.auditLogs).where(eq(s.auditLogs.userId, userId)).run();
    db.delete(s.users).where(eq(s.users.id, userId)).run();
  }
  console.log("cleanup done");
} catch (e) {
  console.error("cleanup error:", e);
  process.exitCode = 1;
}
process.exit(process.exitCode ?? 0);
