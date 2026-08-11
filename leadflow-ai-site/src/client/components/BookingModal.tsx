/**
 * BookingModal — the Appointment Agent UI (spec §8): pick service → pick a
 * day with real open slots → pick a time → confirm. Availability is fetched
 * from /api/appointments/availability (calendar provider minus bookings), so
 * the app NEVER invents availability. On confirm the backend re-verifies the
 * slot (no double-booking), creates the appointment, updates the lead,
 * sends mock confirmations, and notifies the owner.
 */
import { useEffect, useMemo, useState } from "react";
import { api, fmtDateTime, fmtTime, type Appointment, type DaySlots, type Service } from "../api";
import { Button, Field, Select, Spinner } from "./ui";

interface BookingModalProps {
  leadId: string;
  leadName?: string;
  initialServiceId?: string;
  open: boolean;
  onClose: () => void;
  /** Called with the created appointment so callers can refresh their data. */
  onBooked?: (appointment: Appointment) => void;
}

export function BookingModal({ leadId, leadName, initialServiceId, open, onClose, onBooked }: BookingModalProps) {
  const [services, setServices] = useState<Service[]>([]);
  const [serviceId, setServiceId] = useState<string>("");
  const [days, setDays] = useState<DaySlots[]>([]);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Appointment | null>(null);
  const [busy, setBusy] = useState(false);

  // Load services when opened.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setDone(null);
    setSelectedSlot(null);
    setSelectedDate(null);
    setDays([]);
    api<{ services: Service[] }>("/api/services")
      .then((r) => {
        const active = r.services.filter((s) => s.active === 1);
        setServices(active);
        const preferred = initialServiceId && active.some((s) => s.id === initialServiceId) ? initialServiceId : active[0]?.id ?? "";
        setServiceId(preferred);
        if (preferred) fetchDays(preferred);
      })
      .catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const fetchDays = async (svcId: string) => {
    setChecking(true);
    setError(null);
    setSelectedDate(null);
    setSelectedSlot(null);
    try {
      const r = await api<{ days: DaySlots[] }>("/api/appointments/availability", {
        method: "POST",
        body: JSON.stringify({ serviceId: svcId, days: 7 }),
      });
      setDays(r.days);
    } catch (e) {
      setError((e as Error).message);
      setDays([]);
    } finally {
      setChecking(false);
    }
  };

  const onServiceChange = (id: string) => {
    setServiceId(id);
    fetchDays(id);
  };

  const selectedDay = useMemo(() => days.find((d) => d.date === selectedDate) ?? null, [days, selectedDate]);

  const confirm = async () => {
    if (!selectedSlot || !serviceId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ appointment: Appointment }>("/api/appointments", {
        method: "POST",
        body: JSON.stringify({ leadId, serviceId, startAt: selectedSlot }),
      });
      setDone(res.appointment);
      onBooked?.(res.appointment);
    } catch (e) {
      setError((e as Error).message);
      // The slot may have been taken — refresh availability.
      fetchDays(serviceId);
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="text-lg font-bold text-slate-900">Book an appointment</h2>
            <p className="text-sm text-slate-500">
              {leadName ? `For ${leadName}` : "New appointment"} · real availability from your calendar
            </p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600" aria-label="Close">
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {done ? (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
            <p className="text-sm font-semibold text-emerald-800">✓ Appointment booked</p>
            <p className="mt-1 text-sm text-emerald-700">{fmtDateTime(done.startAt)}</p>
            <p className="mt-0.5 text-xs text-emerald-600">
              Confirmation sent{/* via SMS/email (mock) */} and the lead's status is now “Appointment Booked”.
            </p>
            <Button className="mt-4 w-full" onClick={onClose}>
              Done
            </Button>
          </div>
        ) : (
          <>
            {error ? <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p> : null}

            <Field label="Service">
              <Select value={serviceId} onChange={(e) => onServiceChange(e.target.value)} disabled={checking || services.length === 0}>
                {services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {s.durationMin} min
                  </option>
                ))}
              </Select>
            </Field>

            <div className="mt-4">
              <p className="mb-1.5 text-sm font-medium text-slate-700">Pick a day</p>
              {checking ? (
                <Spinner label="Checking your calendar…" />
              ) : days.length === 0 ? (
                <p className="rounded-lg bg-slate-50 px-3 py-4 text-center text-sm text-slate-400">
                  No open times in the next 7 days. Try again later or call the lead.
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {days.map((d) => (
                    <button
                      key={d.date}
                      onClick={() => {
                        setSelectedDate(d.date);
                        setSelectedSlot(null);
                      }}
                      className={`rounded-lg border px-3 py-2 text-left text-xs font-medium transition-colors ${
                        selectedDate === d.date ? "border-indigo-600 bg-indigo-50 text-indigo-700" : "border-slate-200 bg-white text-slate-600 hover:border-indigo-300"
                      }`}
                    >
                      <span className="block text-[11px] uppercase tracking-wide text-slate-400">{new Date(`${d.date}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "short" })}</span>
                      <span className="block text-sm font-semibold">{new Date(`${d.date}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
                      <span className="block text-[11px] text-slate-400">{d.slots.length} open</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {selectedDay ? (
              <div className="mt-4">
                <p className="mb-1.5 text-sm font-medium text-slate-700">
                  Times on {new Date(`${selectedDay.date}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}
                </p>
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                  {selectedDay.slots.map((s) => (
                    <button
                      key={s.startAt}
                      onClick={() => setSelectedSlot(s.startAt)}
                      className={`rounded-lg border px-2 py-2 text-sm font-semibold transition-colors ${
                        selectedSlot === s.startAt ? "border-indigo-600 bg-indigo-600 text-white" : "border-slate-200 bg-white text-slate-700 hover:border-indigo-300"
                      }`}
                    >
                      {fmtTime(s.startAt)}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="mt-6 flex gap-2">
              <Button variant="secondary" className="flex-1" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button className="flex-1" onClick={confirm} disabled={!selectedSlot || busy}>
                {busy ? "Booking…" : "Confirm appointment"}
              </Button>
            </div>
            <p className="mt-2 text-center text-[11px] text-slate-400">Times come from your live calendar — we never invent availability.</p>
          </>
        )}
      </div>
    </div>
  );
}
