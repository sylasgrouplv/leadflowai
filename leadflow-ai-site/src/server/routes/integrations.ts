/**
 * Integrations routes — surface the provider layer and demo the mock calendar.
 * The calendar endpoint proves availability is real data: slots come from the
 * business's configured hours minus real booked appointments (never invented).
 */
import { Hono } from "hono";
import { z } from "zod";
import * as repo from "../db/repo";
import { attachUser, HttpError, resolveBusiness } from "../auth/guards";
import { getCalendarProvider, getAiProvider, getSmsProvider, getEmailProvider, getCrmProvider, getStripeProvider } from "../integrations";
import { serializeBusiness } from "./auth";

export const integrationRoutes = new Hono();
integrationRoutes.use("*", attachUser);

/** Status of the six provider interfaces (mock names for now) + DB rows. */
integrationRoutes.get("/", async (c) => {
  const business = await resolveBusiness(c);
  const rows = await repo.listIntegrations(business.id);
  return c.json({
    providers: {
      ai: getAiProvider().name,
      sms: getSmsProvider().name,
      email: getEmailProvider().name,
      calendar: getCalendarProvider().name,
      crm: getCrmProvider().name,
      stripe: getStripeProvider().name,
    },
    integrations: rows,
  });
});

const availabilitySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
  durationMin: z.coerce.number().int().min(15).max(480).default(60),
});

/** Mock-calendar availability for a day: hours minus real bookings. */
integrationRoutes.get("/availability", async (c) => {
  const business = await resolveBusiness(c);
  const parsed = availabilitySchema.safeParse(c.req.query());
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "date (YYYY-MM-DD) required");

  const serialized = serializeBusiness(business);
  const dayStart = Date.parse(`${parsed.data.date}T00:00:00Z`);
  const dayEnd = dayStart + 24 * 60 * 60 * 1000;
  const booked = await repo.listOverlappingAppointments(business.id, dayStart, dayEnd);

  const provider = getCalendarProvider();
  const slots = await provider.getAvailability({
    businessId: business.id,
    date: parsed.data.date,
    durationMin: parsed.data.durationMin,
    hours: serialized.hours,
    booked: booked.map((b) => ({ startAt: b.startAt, endAt: b.endAt })),
  });
  return c.json({ date: parsed.data.date, durationMin: parsed.data.durationMin, booked: booked.length, slots });
});
