/**
 * Appointment Agent (spec §8) — the booking flow behind every surface:
 * Conversation Center "Book Appointment", lead detail booking, and the
 * Appointments page. Follows the §26 action framework: every mutation is a
 * validated backend function that logs an agent_actions row.
 *
 * Availability rules (safety rule 2 — NEVER invent availability):
 *   - slots come ONLY from the calendar provider (business hours minus
 *     hash-seeded busy blocks) minus real bookings (listOverlappingAppointments),
 *   - bookAppointmentAction re-verifies the exact slot through the provider
 *     and re-checks overlaps at write time, so two concurrent bookings can
 *     never double-book.
 *
 * Side effects of a successful booking (spec §8 a–f):
 *   - appointment row created (validated),
 *   - agent_actions logged (check_calendar / book_appointment),
 *   - lead status -> appointment_booked,
 *   - confirmation SMS + email sent via mock providers (logged),
 *   - confirmation message appended to the conversation thread,
 *   - notification created for the business owner,
 *   - pending follow-ups cancelled (stop rule: books appointment),
 *   - CRM status sync (mock).
 */
import { z } from "zod";
import * as repo from "../db/repo";
import { getCalendarProvider, getCrmProvider, getEmailProvider, getSmsProvider } from "../integrations";
import { setStatusAction, type LeadRow } from "../ai/qualify";
import { emitEvent } from "../ai/events";
import type { AvailabilitySlot } from "../integrations/types";
import type { appointments } from "../db/schema";

const DAY_MS = 24 * 60 * 60 * 1000;

function toDateStrUTC(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function dayStartUTC(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

export function parseHours(hoursJson: string | null): Record<string, { open: string; close: string; closed: boolean }> {
  try {
    const parsed = JSON.parse(hoursJson || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Next `count` UTC date strings starting at startDate (defaults to today). */
export function nextDateStrings(startDate?: string, count = 5): string[] {
  const start = startDate ? Date.parse(`${startDate}T00:00:00Z`) : dayStartUTC(toDateStrUTC(Date.now()));
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(toDateStrUTC(start + i * DAY_MS));
  return out;
}

// ---------------------------------------------------------------------------
// Availability (checked, logged — spec §26 check_calendar)
// ---------------------------------------------------------------------------

export interface DaySlots {
  date: string;
  slots: AvailabilitySlot[];
}

export async function checkCalendarAction(
  businessId: string,
  opts: { serviceId?: string | null; durationMin?: number; startDate?: string; days?: number; leadId?: string }
): Promise<DaySlots[]> {
  const service = opts.serviceId ? await repo.getServiceById(businessId, opts.serviceId) : null;
  let durationMin = opts.durationMin;
  if (!durationMin && service) durationMin = service.durationMin;
  if (!durationMin) durationMin = 60;

  const business = await repo.getBusinessById(businessId);
  if (!business) return [];
  const hours = parseHours(business.hoursJson);
  const dates = nextDateStrings(opts.startDate, Math.min(Math.max(opts.days ?? 3, 1), 14));
  const provider = getCalendarProvider();

  const days: DaySlots[] = [];
  for (const date of dates) {
    const start = dayStartUTC(date);
    const booked = await repo.listOverlappingAppointments(businessId, start, start + DAY_MS);
    const slots = await provider.getAvailability({
      businessId,
      date,
      durationMin,
      hours,
      booked: booked.map((b) => ({ startAt: b.startAt, endAt: b.endAt })),
    });
    if (slots.length) days.push({ date, slots });
  }

  await repo.logAgentAction(businessId, {
    agent: "appointment",
    action: "check_calendar",
    leadId: opts.leadId,
    input: { serviceId: opts.serviceId ?? null, durationMin, startDate: opts.startDate ?? null, days: dates.length },
    result: { days: days.map((d) => ({ date: d.date, slots: d.slots.length })) },
    success: true,
  });
  return days;
}

// ---------------------------------------------------------------------------
// Booking (validated + logged — spec §26 book_appointment)
// ---------------------------------------------------------------------------

const bookInput = z.object({
  leadId: z.string().uuid(),
  serviceId: z.string().uuid().nullable().optional(),
  startAt: z.number().int().positive(),
  notes: z.string().max(2000).optional(),
});

export interface BookedAppointment {
  appointment: NonNullable<Awaited<ReturnType<typeof repo.getAppointmentById>>>;
  lead: LeadRow;
  serviceName: string | null;
  confirmation: { sms: boolean; email: boolean };
}

export async function bookAppointmentAction(businessId: string, input: z.infer<typeof bookInput>): Promise<BookedAppointment> {
  const parsed = bookInput.safeParse(input);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid booking input");
  }
  const { leadId, serviceId, startAt, notes } = parsed.data;

  const lead = await repo.getLeadById(businessId, leadId);
  if (!lead) throw new Error("Lead not found");
  const service = serviceId ? await repo.getServiceById(businessId, serviceId) : null;
  if (serviceId && !service) throw new Error("Service not found");
  const durationMin = service?.durationMin ?? 60;
  const endAt = startAt + durationMin * 60_000;

  // 1) The slot must be in the future.
  if (startAt < Date.now() - 60_000) throw new Error("That time is in the past — pick an upcoming slot.");
  // 2) Re-verify through the calendar provider (business hours, busy blocks,
  //    real bookings) — never invent, never double-book.
  const business = await repo.getBusinessById(businessId);
  if (!business) throw new Error("Business not found");
  const hours = parseHours(business.hoursJson);
  const date = toDateStrUTC(startAt);
  const booked = await repo.listOverlappingAppointments(businessId, startAt, endAt);
  if (booked.length) throw new Error("That time was just taken — pick another slot.");
  const open = await getCalendarProvider().getAvailability({ businessId, date, durationMin, hours, booked: [] });
  const ok = open.some((s) => s.startAt === startAt && s.endAt === endAt);
  if (!ok) throw new Error("That time isn't available — pick a slot from the list.");

  // 3) Create the appointment row.
  let appointment = await repo.createAppointment({
    businessId,
    leadId,
    serviceId: service?.id ?? null,
    startAt,
    endAt,
    status: "booked",
    notes: notes ?? "",
  });
  const serviceName = service?.name ?? null;

  // 4) Confirm on the external calendar (mock — never touches a real calendar).
  let providerEventId = "";
  try {
    const res = await getCalendarProvider().book({ businessId, leadId, serviceId: service?.id ?? null, startAt, endAt });
    providerEventId = res.id;
  } catch (e) {
    console.error("[appointment] calendar.book failed:", e);
  }

  // 4b) Persist the real provider event id so a real provider (e.g. Google
  //     Calendar) can resolve/cancel the event later. The provider contract is
  //     DB-free, so the appointment layer owns this storage. The mock returns a
  //     mock id too — we store whatever the provider returns, never a synthetic
  //     value fabricated by the call site.
  if (providerEventId) {
    appointment = (await repo.updateAppointmentProviderEventId(businessId, appointment.id, providerEventId)) ?? appointment;
  }

  // 5) Lead status -> Appointment Booked (logged action).
  await setStatusAction(businessId, leadId, "appointment_booked");

  // 6) Stop follow-ups: a booked lead stops receiving sequence messages (spec §9).
  await repo.cancelFollowUpsForLead(businessId, leadId);

  // 7) Confirmation via mock SMS/email (logged), plus a thread message.
  const confirmation = await sendConfirmation(businessId, lead, appointment, serviceName);
  await appendThreadMessage(businessId, lead, appointment, serviceName);

  // 8) Notify the owner (surfaced in the in-app notification bell).
  await repo.createNotification(businessId, {
    kind: "appointment",
    title: `Appointment booked — ${lead.firstName} ${lead.lastName}`.trim(),
    body: `${serviceName ?? "Service"} on ${fmtShort(appointment.startAt)}${lead.phone ? ` · ${lead.phone}` : ""}`,
  });

  // 9) CRM status sync (mock provider).
  try {
    await getCrmProvider().updateLeadStatus(lead.id, "appointment_booked");
  } catch {
    /* CRM is best-effort in the MVP */
  }

  await repo.logAgentAction(businessId, {
    agent: "appointment",
    action: "book_appointment",
    leadId,
    input: { serviceId: service?.id ?? null, startAt, endAt, providerEventId },
    result: { appointmentId: appointment.id, leadStatus: "appointment_booked", confirmation },
    success: true,
  });

  await repo.audit(businessId, null, "appointment.book", "appointment", appointment.id, { leadId, serviceId, startAt });
  // Spec §30: a booking is an event — the automation engine cancels pending
  // follow-ups on it (existing stop rule, now event-driven too).
  await emitEvent({
    type: "APPOINTMENT_BOOKED",
    businessId,
    leadId,
    payload: { appointmentId: appointment.id, serviceId: service?.id ?? null, startAt, endAt, serviceName },
  });
  return { appointment, lead, serviceName, confirmation };
}

// ---------------------------------------------------------------------------
// Confirmation + thread message
// ---------------------------------------------------------------------------

async function sendConfirmation(
  businessId: string,
  lead: LeadRow,
  appointment: NonNullable<Awaited<ReturnType<typeof repo.getAppointmentById>>>,
  serviceName: string | null
): Promise<{ sms: boolean; email: boolean }> {
  const out = { sms: false, email: false };
  const line = `${serviceName ?? "your appointment"} on ${fmtShort(appointment.startAt)}`;
  const smsBody = `Hi ${lead.firstName || "there"}! Your ${line} is confirmed with your service provider. Reply STOP to opt out of texts.`;
  const emailSubject = `Appointment confirmed — ${serviceName ?? "your visit"}`;
  const emailHtml = `<p>Hi ${lead.firstName || "there"},</p><p>Your ${line} is confirmed. We look forward to seeing you!</p><p style="color:#888;font-size:12px">Sent by LeadFlow AI (demo mock). Reply "STOP" to opt out.</p>`;

  if (lead.phone) {
    try {
      const res = await getSmsProvider().send({ to: lead.phone, body: smsBody });
      await repo.logAgentAction(businessId, {
        agent: "appointment",
        action: "send_sms",
        leadId: lead.id,
        input: { to: lead.phone, body: smsBody },
        result: { provider: getSmsProvider().name, id: res.id },
        success: true,
      });
      out.sms = true;
    } catch (e) {
      console.error("[appointment] sms failed:", e);
    }
  }
  if (lead.email) {
    try {
      const res = await getEmailProvider().send({ to: lead.email, subject: emailSubject, html: emailHtml });
      await repo.logAgentAction(businessId, {
        agent: "appointment",
        action: "send_email",
        leadId: lead.id,
        input: { to: lead.email, subject: emailSubject },
        result: { provider: getEmailProvider().name, id: res.id },
        success: true,
      });
      out.email = true;
    } catch (e) {
      console.error("[appointment] email failed:", e);
    }
  }
  return out;
}

/** Append a system confirmation message to the lead's active conversation (creates one if none). */
async function appendThreadMessage(
  businessId: string,
  lead: LeadRow,
  appointment: NonNullable<Awaited<ReturnType<typeof repo.getAppointmentById>>>,
  serviceName: string | null
) {
  const convs = await repo.listConversations(businessId, { leadIds: [lead.id] });
  const active = convs.find((c) => c.conversation.status !== "closed");
  const conversation = active ? active.conversation : await repo.createConversation(businessId, { leadId: lead.id, status: "ai_handling" });
  const body = `✅ Appointment booked — ${serviceName ?? "your visit"} on ${fmtShort(appointment.startAt)}. We'll send a reminder before the visit.`;
  await repo.addMessage(businessId, { conversationId: conversation.id, sender: "system", body });
}

// ---------------------------------------------------------------------------
// Status management / cancel / reschedule (validated + logged)
// ---------------------------------------------------------------------------

export async function updateAppointmentStatusAction(
  businessId: string,
  input: { appointmentId: string; status: (typeof appointments.$inferSelect)["status"] }
): Promise<{ appointment: NonNullable<Awaited<ReturnType<typeof repo.getAppointmentById>>>; lead: LeadRow | null }> {
  const appointment = await repo.getAppointmentById(businessId, input.appointmentId);
  if (!appointment) throw new Error("Appointment not found");
  const allowed = ["booked", "confirmed", "completed", "cancelled", "no_show"] as const;
  if (!(allowed as readonly string[]).includes(input.status)) throw new Error("Invalid appointment status");

  const updated = await repo.updateAppointment(businessId, input.appointmentId, { status: input.status });
  if (!updated) throw new Error("Appointment not found");

  let lead: LeadRow | null = null;
  if (appointment.leadId) lead = await repo.getLeadById(businessId, appointment.leadId);
  const service = appointment.serviceId ? await repo.getServiceById(businessId, appointment.serviceId) : null;

  if (input.status === "cancelled") {
    // Pass the persisted provider event id (Google) when present; older
    // mock/pre-migration rows carry no id, so skip the provider call rather
    // than fabricate a synthetic event id that would never match a real event.
    if (appointment.providerEventId) {
      try {
        await getCalendarProvider().cancel(businessId, appointment.providerEventId);
      } catch (e) {
        console.error("[appointment] calendar.cancel failed:", e);
      }
    }
    await repo.createNotification(businessId, {
      kind: "appointment",
      title: `Appointment cancelled — ${lead ? `${lead.firstName} ${lead.lastName}`.trim() : "lead"}`,
      body: `${service?.name ?? "Service"} on ${fmtShort(appointment.startAt)}`,
    });
    await emitEvent({
      type: "APPOINTMENT_CANCELLED",
      businessId,
      leadId: appointment.leadId,
      payload: { appointmentId: appointment.id, status: input.status, serviceId: appointment.serviceId ?? null, startAt: appointment.startAt },
    });
  } else if (input.status === "completed" && lead) {
    // Completed job -> customer, stop follow-ups (spec §9 stop rule).
    await setStatusAction(businessId, lead.id, "customer");
    await repo.cancelFollowUpsForLead(businessId, lead.id);
    await repo.createNotification(businessId, {
      kind: "appointment",
      title: `Job completed — ${lead.firstName} ${lead.lastName}`.trim(),
      body: `${service?.name ?? "Service"} · lead is now a customer`,
    });
    // Spec §30 + Brain 4 handoff: JOB_COMPLETED is emitted here; the Review
    // Agent (Brain 4) subscribes to it to start the review workflow.
    await emitEvent({
      type: "JOB_COMPLETED",
      businessId,
      leadId: lead.id,
      payload: { appointmentId: appointment.id, serviceId: appointment.serviceId ?? null, serviceName: service?.name ?? null, completedAt: repo.now() },
    });
  }

  await repo.logAgentAction(businessId, {
    agent: "appointment",
    action: "update_appointment_status",
    leadId: appointment.leadId ?? undefined,
    input: { appointmentId: input.appointmentId, status: input.status },
    result: { ok: true },
    success: true,
  });
  return { appointment: updated, lead };
}

export async function rescheduleAppointmentAction(
  businessId: string,
  input: { appointmentId: string; startAt: number }
): Promise<{ appointment: NonNullable<Awaited<ReturnType<typeof repo.getAppointmentById>>> }> {
  const appointment = await repo.getAppointmentById(businessId, input.appointmentId);
  if (!appointment) throw new Error("Appointment not found");
  if (["completed", "cancelled", "no_show"].includes(appointment.status)) throw new Error("Can't reschedule a closed appointment");
  if (input.startAt < Date.now() - 60_000) throw new Error("That time is in the past");

  const service = appointment.serviceId ? await repo.getServiceById(businessId, appointment.serviceId) : null;
  const durationMin = service?.durationMin ?? 60;
  const endAt = input.startAt + durationMin * 60_000;
  const date = toDateStrUTC(input.startAt);

  const business = await repo.getBusinessById(businessId);
  if (!business) throw new Error("Business not found");
  const hours = parseHours(business.hoursJson);
  // Exclude this appointment's own interval when checking overlaps.
  const booked = (await repo.listOverlappingAppointments(businessId, input.startAt, endAt)).filter((b) => b.id !== appointment.id);
  if (booked.length) throw new Error("That time is taken — pick another slot.");
  const open = await getCalendarProvider().getAvailability({ businessId, date, durationMin, hours, booked: [] });
  const ok = open.some((s) => s.startAt === input.startAt && s.endAt === endAt);
  if (!ok) throw new Error("That time isn't available — pick a slot from the list.");

  const updated = await repo.updateAppointment(businessId, input.appointmentId, { startAt: input.startAt, endAt, status: "booked" });
  if (!updated) throw new Error("Appointment not found");

  const lead = appointment.leadId ? await repo.getLeadById(businessId, appointment.leadId) : null;
  if (lead) await sendConfirmation(businessId, lead, updated, service?.name ?? null);
  await repo.createNotification(businessId, {
    kind: "appointment",
    title: `Appointment rescheduled — ${lead ? `${lead.firstName} ${lead.lastName}`.trim() : "lead"}`,
    body: `${service?.name ?? "Service"} moved to ${fmtShort(input.startAt)}`,
  });
  // Phase 1b (Chunk D): a reschedule re-emits APPOINTMENT_BOOKED so the
  // automation engine refreshes the appointment reminder for the NEW time —
  // the reminder rule's idempotency cancels the stale pending reminder and
  // schedules a fresh one (never reminds at the old time).
  await emitEvent({
    type: "APPOINTMENT_BOOKED",
    businessId,
    leadId: appointment.leadId,
    payload: { appointmentId: appointment.id, serviceId: appointment.serviceId ?? null, startAt: input.startAt, endAt, serviceName: service?.name ?? null },
  });
  await repo.logAgentAction(businessId, {
    agent: "appointment",
    action: "reschedule_appointment",
    leadId: appointment.leadId ?? undefined,
    input: { appointmentId: input.appointmentId, startAt: input.startAt },
    result: { ok: true },
    success: true,
  });
  return { appointment: updated };
}

// ---------------------------------------------------------------------------

export function fmtShort(ms: number): string {
  return new Date(ms).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
