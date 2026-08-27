/**
 * Calendar provider event id persistence (scope §2.5 / task 3).
 *
 * Verifies the database/call-site groundwork so a real Google Calendar
 * provider can land later without a migration surprise:
 *   1. booking an appointment persists the provider's returned event id,
 *   2. the persisted id is the provider's book() id — NOT a synthetic
 *      `mock_cal_${startAt}` fabricated at the call site,
 *   3. cancel/reschedule keep using the persisted id (never wiped / never
 *      re-fabricated),
 *   4. the repo helper updateAppointmentProviderEventId round-trips.
 *
 * Hermetic: SQLite (no DATABASE_URL), mock calendar provider, no real keys.
 * Style matches auto-test.ts / brain4-test.ts — in-process repo + agent calls.
 *
 * Run:  cd /home/agent-lead/leadflowai/leadflow-ai-site && unset DATABASE_URL && bun run provider-event-id-test.ts
 */
import { createHash } from "node:crypto";
import { runMigrations } from "./src/server/db/migrate";
import * as repo from "./src/server/db/repo";
import { getDb } from "./src/server/db/client";
import * as s from "./src/server/db/schema";
import { and, eq } from "drizzle-orm";
import {
  bookAppointmentAction,
  checkCalendarAction,
  updateAppointmentStatusAction,
  rescheduleAppointmentAction,
} from "./src/server/appointments/agent";

runMigrations();
let failures = 0;
function pass(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} | ${label}${detail ? " | " + detail : ""}`);
  if (!ok) failures += 1;
}
const db = getDb();

const HOURS = {
  monday: { open: "08:00", close: "18:00", closed: false },
  tuesday: { open: "08:00", close: "18:00", closed: false },
  wednesday: { open: "08:00", close: "18:00", closed: false },
  thursday: { open: "08:00", close: "18:00", closed: false },
  friday: { open: "08:00", close: "18:00", closed: false },
  saturday: { open: "09:00", close: "13:00", closed: false },
  sunday: { open: "00:00", close: "00:00", closed: true },
};

/** Tenant-scoped cleanup (FK-safe), same pattern as reminder-test. */
async function wipeBusiness(id: string) {
  for (const lead of await db.select({ id: s.leads.id }).from(s.leads).where(eq(s.leads.businessId, id)).execute()) {
    for (const a of await db.select().from(s.appointments).where(eq(s.appointments.leadId, lead.id)).execute()) await db.delete(s.appointments).where(eq(s.appointments.id, a.id)).execute();
    for (const c of await db.select().from(s.conversations).where(eq(s.conversations.leadId, lead.id)).execute()) {
      await db.delete(s.messages).where(eq(s.messages.conversationId, c.id)).execute();
      await db.delete(s.conversations).where(eq(s.conversations.id, c.id)).execute();
    }
    await db.delete(s.agentActions).where(eq(s.agentActions.leadId, lead.id)).execute();
    await db.delete(s.followUps).where(eq(s.followUps.leadId, lead.id)).execute();
    await db.delete(s.events).where(eq(s.events.leadId, lead.id)).execute();
    await db.delete(s.leads).where(eq(s.leads.id, lead.id)).execute();
  }
  await db.delete(s.humanTasks).where(eq(s.humanTasks.businessId, id)).execute();
  await db.delete(s.events).where(eq(s.events.businessId, id)).execute();
  await db.delete(s.automationRuns).where(eq(s.automationRuns.businessId, id)).execute();
  await db.delete(s.notifications).where(eq(s.notifications.businessId, id)).execute();
  await db.delete(s.auditLogs).where(eq(s.auditLogs.businessId, id)).execute();
  await db.delete(s.services).where(eq(s.services.businessId, id)).execute();
  await db.delete(s.businesses).where(eq(s.businesses.id, id)).execute();
}

/** Expected id the mock calendar's book() returns for (businessId, startAt). */
function expectedMockId(bizId: string, startAt: number): string {
  return `mock_cal_${createHash("sha256").update(`${bizId}|${startAt}`).digest("hex").slice(0, 16)}`;
}

(async () => {
  const stamp = Date.now();
  const owner = await repo.createUser({
    name: "ProviderEventId Owner",
    email: `peid-owner-${stamp}@test.local`,
    passwordHash: "$2b$10$test",
    role: "owner",
  });
  const business = await repo.createBusiness({
    ownerId: owner.id,
    name: "ProviderEventId Co",
    category: "home_services",
  });
  await repo.updateBusiness(business.id, { hoursJson: JSON.stringify(HOURS) });
  const bizId = business.id;
  const service = await repo.addService(bizId, { name: "AC Tune-Up", description: "Tune-up", priceCents: 9900, durationMin: 60 });
  const svcId = service.id;
  const lead = await repo.createLead({
    businessId: bizId,
    firstName: "EventId",
    lastName: "Test",
    phone: "555-0101",
    email: "",
    source: "website_chat",
    serviceRequested: "AC Tune-Up",
  });

  // Pick two distinct future slots so we can book + reschedule without overlap.
  const days = await checkCalendarAction(bizId, { serviceId: svcId, days: 14 });
  const slots = days.flatMap((d) => d.slots).filter((s) => s.startAt > Date.now() + 60_000);
  pass("mock calendar returns future bookable slots", slots.length >= 2, `slots=${slots.length}`);
  if (slots.length < 2) {
    console.log(`${failures} failure(s)`);
    process.exit(failures ? 1 : 0);
  }
  const slotA = slots[0].startAt;
  const slotB = slots.find((s) => s.startAt !== slotA)!.startAt;

  // --- T1: booking persists the provider's returned event id ---
  const booked = await bookAppointmentAction(bizId, { leadId: lead.id, serviceId: svcId, startAt: slotA, notes: "" });
  const stored = booked.appointment.providerEventId;
  const expected = expectedMockId(bizId, slotA);
  pass("T1 book persists providerEventId (== mock book id)", !!stored && stored === expected, `stored=${stored}`);

  // --- T2: it is NOT the old fabricated `mock_cal_${startAt}` value ---
  pass("T2 persisted id != old fabricated mock_cal_${startAt}", stored !== `mock_cal_${slotA}`, `stored=${stored}`);

  const bookedId = booked.appointment.id;

  // --- T3: repo updateAppointmentProviderEventId round-trips a chosen id ---
  const chosen = "google_event_abc123";
  let row = await repo.updateAppointmentProviderEventId(bizId, bookedId, chosen);
  pass("T3 updateAppointmentProviderEventId persists chosen id", row?.providerEventId === chosen, `row=${row?.providerEventId}`);
  // restore the booked id (so reschedule/cancel below use the real flow)
  row = await repo.updateAppointmentProviderEventId(bizId, bookedId, stored) ?? row;
  pass("T3b restore booked providerEventId", row?.providerEventId === stored, `row=${row?.providerEventId}`);

  // --- T4: reschedule retains the persisted id (updates time, keeps id) ---
  const resched = await rescheduleAppointmentAction(bizId, { appointmentId: bookedId, startAt: slotB });
  pass("T4 reschedule keeps persisted providerEventId", resched.appointment.providerEventId === stored, `id=${resched.appointment.providerEventId}`);
  pass("T4b reschedule moved startAt", resched.appointment.startAt === slotB, `startAt=${resched.appointment.startAt}`);

  // --- T5: cancel retains the persisted id and marks the row cancelled ---
  const cancelled = await updateAppointmentStatusAction(bizId, { appointmentId: bookedId, status: "cancelled" });
  pass("T5 cancel sets status cancelled", cancelled.appointment.status === "cancelled", `status=${cancelled.appointment.status}`);
  const afterCancel = await repo.getAppointmentById(bizId, bookedId);
  pass("T5b cancel keeps persisted providerEventId (used for provider.cancel)", afterCancel?.providerEventId === stored, `id=${afterCancel?.providerEventId}`);

  await wipeBusiness(bizId);
  console.log(failures ? `\n${failures} failure(s)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
})();
