/**
 * Calendar provider — mock (Google-style availability).
 *
 * Deterministic + honest:
 *   - slots only inside the business's configured weekly hours
 *   - never overlaps `booked` intervals (never double-books)
 *   - a deterministic hash of businessId+date blocks 0–2 "already busy"
 *     windows, so the mock behaves like a real calendar without randomness
 *     (same day always yields the same availability).
 */
import { createHash } from "node:crypto";
import type { AvailabilitySlot, CalendarProvider, CalendarBookInput } from "./types";

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

function hashInt(...parts: string[]): number {
  const h = createHash("sha256").update(parts.join("|")).digest();
  return h.readUInt32BE(0);
}

function parseHM(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

function dayStartUTC(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

export class MockCalendarProvider implements CalendarProvider {
  readonly name = "mock-calendar";

  async getAvailability(input: {
    businessId: string;
    date: string;
    durationMin: number;
    hours: Record<string, { open: string; close: string; closed: boolean }>;
    booked: AvailabilitySlot[];
  }): Promise<AvailabilitySlot[]> {
    const { businessId, date, durationMin, hours, booked } = input;
    const weekday = WEEKDAYS[new Date(Date.parse(`${date}T12:00:00Z`)).getUTCDay()];
    const day = hours[weekday];
    if (!day || day.closed) return [];

    const openMin = parseHM(day.open);
    const closeMin = parseHM(day.close);
    if (!openMin && !closeMin) return [];
    if (closeMin - openMin < durationMin) return [];

    // Deterministic "already busy" windows (2–3h each) seeded by business+date.
    const busyWindows: Array<{ start: number; end: number }> = [];
    const nBusy = hashInt(businessId, date, "n") % 3; // 0..2
    for (let i = 0; i < nBusy; i++) {
      const lenMin = 120 + (hashInt(businessId, date, `len${i}`) % 60);
      const span = closeMin - openMin - lenMin;
      if (span <= 0) continue;
      const start = openMin + (hashInt(businessId, date, `pos${i}`) % span);
      busyWindows.push({ start, end: start + lenMin });
    }

    const dayStart = dayStartUTC(date);
    const slots: AvailabilitySlot[] = [];
    for (let s = openMin; s + durationMin <= closeMin; s += 30) {
      const slotStart = dayStart + s * 60_000;
      const slotEnd = slotStart + durationMin * 60_000;
      const busy = busyWindows.some((b) => slotStart < dayStart + b.end * 60_000 && slotEnd > dayStart + b.start * 60_000);
      const taken = booked.some((b) => slotStart < b.endAt && slotEnd > b.startAt);
      if (!busy && !taken) slots.push({ startAt: slotStart, endAt: slotEnd });
    }
    return slots;
  }

  async book(input: CalendarBookInput) {
    return { id: `mock_cal_${createHash("sha256").update(`${input.businessId}|${input.startAt}`).digest("hex").slice(0, 16)}` };
  }

  async cancel(businessId: string, providerEventId: string) {
    console.log(`[mock-calendar] cancelled ${providerEventId} for business ${businessId}`);
  }
}
