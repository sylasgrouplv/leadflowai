/**
 * Smoke test — booking flow + follow-up engine (run with bun from site dir).
 * Exercises the real DB, the calendar provider, and the scheduler without HTTP.
 */
import { runMigrations } from "./src/server/db/migrate";
import * as repo from "./src/server/db/repo";
import { bookAppointmentAction, checkCalendarAction, updateAppointmentStatusAction } from "./src/server/appointments/agent";
import { runFollowUpScheduler, startSequence, stopSequence, optOutLead } from "./src/server/followups/engine";

runMigrations();
const owner = await repo.getUserByEmail("demo@leadflow.ai");
if (!owner) {
  console.log("SKIP: no demo user (run bun run db:seed)");
  process.exit(0);
}
const business = await repo.getBusinessForUser(owner.id)!;
const bizId = business!.id;
const services = await repo.listServices(bizId);
const service = services.find((s) => s.name === "AC Tune-Up") ?? services[0];
console.log("business:", business!.name, "service:", service.name, service.durationMin, "min");

// 1) Availability — must be real slots from the calendar provider
const days = await checkCalendarAction(bizId, { serviceId: service.id, days: 3 });
console.log("availability days with slots:", days.length);
for (const d of days.slice(0, 2)) console.log(" ", d.date, "->", d.slots.length, "slots");
if (!days.length) throw new Error("no availability found — something is wrong");

// 2) Create a fresh lead and book the first real slot
const lead = await repo.createLead({ businessId: bizId, firstName: "Smoke", lastName: "Test", phone: "(555) 000-1111", email: "smoke@example.com", serviceRequested: service.name, location: "62701", status: "qualified", score: "warm" });
const slot = days[0].slots[0];
const booked = await bookAppointmentAction(bizId, { leadId: lead.id, serviceId: service.id, startAt: slot.startAt });
console.log("booked appointment:", booked.appointment.id, "status", booked.appointment.status, "| conf sms:", booked.confirmation.sms, "email:", booked.confirmation.email);
const leadAfter = await repo.getLeadById(bizId, lead.id);
console.log("lead status after booking:", leadAfter!.status);
const notifs = await repo.listNotifications(bizId, 5);
console.log("latest notification:", notifs[0]?.title);
const actions = await repo.listAgentActions(bizId, 8);
console.log("recent agent actions:", actions.slice(0, 6).map((a) => `${a.agent}/${a.action}`).join(", "));

// 3) Double-book protection: same slot again must fail
try {
  await bookAppointmentAction(bizId, { leadId: lead.id, serviceId: service.id, startAt: slot.startAt });
  console.log("FAIL: double-booking was allowed!");
} catch (e) {
  console.log("double-book correctly rejected:", (e as Error).message.slice(0, 60));
}

// 4) Follow-up sequence on an UNBOOKED lead: start -> due -> scheduler sends -> advances
const lead0 = await repo.createLead({ businessId: bizId, firstName: "Follow", lastName: "Up", phone: "(555) 333-4444", email: "followup@example.com", serviceRequested: "AC Repair", status: "qualified", score: "warm" });
const seq = await startSequence(bizId, lead0.id);
console.log("sequence started:", seq.started, "->", seq.reason ?? "");
let fups = (await repo.listFollowUpsWithLead(bizId, 500)).filter((r) => r.followUp.leadId === lead0.id);
console.log("follow-ups for lead0:", fups.map((r) => `${r.followUp.templateKey}/${r.followUp.status}@${new Date(r.followUp.scheduledFor).toISOString().slice(0, 10)}`).join(", "));
const pending0 = fups.find((r) => r.followUp.status === "pending");
if (pending0) {
  await repo.updateFollowUp(bizId, pending0.followUp.id, { scheduledFor: Date.now() - 1000 });
  const run = await runFollowUpScheduler();
  console.log("scheduler run:", JSON.stringify(run));
  fups = (await repo.listFollowUpsWithLead(bizId, 500)).filter((r) => r.followUp.leadId === lead0.id);
  console.log("follow-ups after run:", fups.map((r) => `${r.followUp.templateKey}/${r.followUp.status}@${new Date(r.followUp.scheduledFor).toISOString().slice(0, 10)}`).join(", "));
}

// 5) Stop rules: opt out -> pending cancelled; customer status at scheduler time -> cancelled
const lead2 = await repo.createLead({ businessId: bizId, firstName: "Stop", lastName: "Rule", phone: "(555) 111-2222", email: "stop@example.com", status: "qualified" });
await startSequence(bizId, lead2.id);
await optOutLead(bizId, lead2.id, "all");
const fups2 = (await repo.listFollowUpsWithLead(bizId, 500)).filter((r) => r.followUp.leadId === lead2.id);
console.log("opt-out stop rule:", fups2.map((r) => `${r.followUp.templateKey}/${r.followUp.status}`).join(", "));

const lead3 = await repo.createLead({ businessId: bizId, firstName: "Customer", lastName: "Rule", phone: "(555) 222-3333", status: "qualified" });
await startSequence(bizId, lead3.id);
await repo.updateLead(bizId, lead3.id, { status: "customer" });
await runFollowUpScheduler(Date.now() + 10 * 24 * 3600_000); // make all due
const fups3 = (await repo.listFollowUpsWithLead(bizId, 500)).filter((r) => r.followUp.leadId === lead3.id);
console.log("customer stop rule:", fups3.map((r) => `${r.followUp.templateKey}/${r.followUp.status}`).join(", "));

// 6) Status management
const upd = await updateAppointmentStatusAction(bizId, { appointmentId: booked.appointment.id, status: "completed" });
const leadAfterComplete = await repo.getLeadById(bizId, lead.id);
console.log("completed appointment -> lead status:", leadAfterComplete!.status);

console.log("SMOKE TEST OK");

// Cleanup — remove all rows this smoke test created so the demo DB stays tidy.
import { getDb } from "./src/server/db/client";
import { eq, inArray } from "drizzle-orm";
import * as s from "./src/server/db/schema";
const db = getDb();
const smokeLeadIds = [lead.id, lead0.id, lead2.id, lead3.id];
for (const id of smokeLeadIds) {
  const appts = db.select().from(s.appointments).where(eq(s.appointments.leadId, id)).all();
  for (const a of appts) db.delete(s.appointments).where(eq(s.appointments.id, a.id)).run();
  db.delete(s.followUps).where(eq(s.followUps.leadId, id)).run();
  const convs = db.select().from(s.conversations).where(eq(s.conversations.leadId, id)).all();
  for (const c of convs) db.delete(s.messages).where(eq(s.messages.conversationId, c.id)).run();
  for (const c of convs) db.delete(s.conversations).where(eq(s.conversations.id, c.id)).run();
  db.delete(s.agentActions).where(eq(s.agentActions.leadId, id)).run();
  db.delete(s.notifications).where(eq(s.notifications.businessId, bizId)).run(); // smoke created notifications
  db.delete(s.leads).where(eq(s.leads.id, id)).run();
}
console.log("cleanup done");
process.exit(0);
