/**
 * Appointment routes — list/manage appointments + the booking flow.
 *
 *   GET    /api/appointments?scope=upcoming|past|all   list (lead, service, value, status)
 *   GET    /api/appointments/:id                       detail
 *   POST   /api/appointments/availability              real slots (business hours − bookings − busy)
 *   POST   /api/appointments                           book (validated agent action)
 *   PATCH  /api/appointments/:id                       status change | reschedule | notes
 *   POST   /api/appointments/:id/cancel                cancel
 *
 * Role guards: employees see/manage appointments only for leads assigned to
 * them (spec role rules — employees may manage appointments, not billing/settings).
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import * as repo from "../db/repo";
import { attachUser, HttpError, requireUser, resolveBusiness } from "../auth/guards";
import { bookAppointmentAction, checkCalendarAction, rescheduleAppointmentAction, updateAppointmentStatusAction } from "../appointments/agent";

const availabilitySchema = z.object({
  serviceId: z.string().uuid().nullable().optional(),
  durationMin: z.number().int().min(15).max(600).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  days: z.number().int().min(1).max(14).optional(),
});

const bookSchema = z.object({
  leadId: z.string().uuid(),
  serviceId: z.string().uuid().nullable().optional(),
  startAt: z.number().int().positive(),
  notes: z.string().max(2000).optional(),
});

const updateSchema = z.object({
  status: z.enum(["booked", "confirmed", "completed", "cancelled", "no_show"]).optional(),
  startAt: z.number().int().positive().optional(),
  notes: z.string().max(2000).optional(),
});

export const appointmentRoutes = new Hono();
appointmentRoutes.use("*", attachUser);

/** Resolve business + enforce the employee's assigned-lead scope for a lead. */
async function assertLeadAccess(c: Context, businessId: string, leadId: string | null) {
  const user = await requireUser(c);
  if (user.role !== "employee" || !leadId) return;
  const lead = await repo.getLeadById(businessId, leadId);
  if (!lead || lead.assignedTo !== user.id) {
    throw new HttpError(403, "You can only book appointments for leads assigned to you.");
  }
}

async function assertAppointmentAccess(c: Context, businessId: string, appointment: { leadId: string | null }) {
  const user = await requireUser(c);
  if (user.role !== "employee" || !appointment.leadId) return;
  const lead = await repo.getLeadById(businessId, appointment.leadId);
  if (!lead || lead.assignedTo !== user.id) {
    throw new HttpError(403, "You can only manage appointments for leads assigned to you.");
  }
}

appointmentRoutes.get("/", async (c) => {
  const business = await resolveBusiness(c);
  const user = await requireUser(c);
  const scope = c.req.query("scope") === "past" ? "past" : c.req.query("scope") === "all" ? "all" : "upcoming";
  let rows = await repo.listAppointments(business.id, { scope });
  if (user.role === "employee") {
    rows = rows.filter((r) => r.lead?.assignedTo === user.id);
  }
  return c.json({ appointments: rows });
});

appointmentRoutes.get("/:id", async (c) => {
  const business = await resolveBusiness(c);
  const appointment = await repo.getAppointmentById(business.id, c.req.param("id"));
  if (!appointment) throw new HttpError(404, "Appointment not found");
  await assertAppointmentAccess(c, business.id, appointment);
  const [lead, service] = await Promise.all([
    appointment.leadId ? repo.getLeadById(business.id, appointment.leadId) : Promise.resolve(null),
    appointment.serviceId ? repo.getServiceById(business.id, appointment.serviceId) : Promise.resolve(null),
  ]);
  return c.json({ appointment, lead, serviceName: service?.name ?? null });
});

/** Real availability — the ONLY source of bookable times (never invented). */
appointmentRoutes.post("/availability", async (c) => {
  const business = await resolveBusiness(c);
  const body = await c.req.json().catch(() => null);
  const parsed = availabilitySchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid input");
  const days = await checkCalendarAction(business.id, parsed.data);
  return c.json({ days });
});

appointmentRoutes.post("/", async (c) => {
  const business = await resolveBusiness(c);
  const user = await requireUser(c);
  const body = await c.req.json().catch(() => null);
  const parsed = bookSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid input");
  await assertLeadAccess(c, business.id, parsed.data.leadId);
  try {
    const booked = await bookAppointmentAction(business.id, parsed.data);
    // Kick off the appointment-confirmation flow's follow-up stop (already done
    // inside the action) — nothing further needed here.
    return c.json({ ...booked, bookedBy: user.id }, 201);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
});

appointmentRoutes.patch("/:id", async (c) => {
  const business = await resolveBusiness(c);
  const appointment = await repo.getAppointmentById(business.id, c.req.param("id"));
  if (!appointment) throw new HttpError(404, "Appointment not found");
  await assertAppointmentAccess(c, business.id, appointment);
  const body = await c.req.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid input");

  if (parsed.data.startAt !== undefined && parsed.data.startAt !== appointment.startAt) {
    try {
      const res = await rescheduleAppointmentAction(business.id, { appointmentId: appointment.id, startAt: parsed.data.startAt });
      return c.json(res);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  }
  if (parsed.data.status !== undefined && parsed.data.status !== appointment.status) {
    try {
      const res = await updateAppointmentStatusAction(business.id, { appointmentId: appointment.id, status: parsed.data.status });
      return c.json(res);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  }
  if (parsed.data.notes !== undefined) {
    const updated = await repo.updateAppointment(business.id, appointment.id, { notes: parsed.data.notes });
    return c.json({ appointment: updated });
  }
  return c.json({ appointment });
});

appointmentRoutes.post("/:id/cancel", async (c) => {
  const business = await resolveBusiness(c);
  const appointment = await repo.getAppointmentById(business.id, c.req.param("id"));
  if (!appointment) throw new HttpError(404, "Appointment not found");
  await assertAppointmentAccess(c, business.id, appointment);
  try {
    const res = await updateAppointmentStatusAction(business.id, { appointmentId: appointment.id, status: "cancelled" });
    return c.json(res);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
});

/** Booked leads are done with follow-ups — convenience used by the UI when a
 * lead books from the lead page (the booking action already handles it). */
appointmentRoutes.post("/:id/complete", async (c) => {
  const business = await resolveBusiness(c);
  const appointment = await repo.getAppointmentById(business.id, c.req.param("id"));
  if (!appointment) throw new HttpError(404, "Appointment not found");
  await assertAppointmentAccess(c, business.id, appointment);
  try {
    const res = await updateAppointmentStatusAction(business.id, { appointmentId: appointment.id, status: "completed" });
    return c.json(res);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
});
