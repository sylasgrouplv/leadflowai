/**
 * Appointments — upcoming + past appointments (lead, service, date/time,
 * status, value), status management (booked → confirmed/completed/cancelled/
 * no-show), reschedule, detail with lead info, and "New appointment" booking
 * from any lead via the shared BookingModal.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, appointmentStatusColor, appointmentStatusLabel, fmtDateTime, money, type Appointment, type AppointmentListItem, type AppointmentStatus, type Lead } from "../api";
import { Badge, Button, Card, EmptyState, PageHeader, Select, Spinner } from "../components/ui";
import { BookingModal } from "../components/BookingModal";
import { useAuth } from "../App";

type Scope = "upcoming" | "past";

const MANAGEABLE: AppointmentStatus[] = ["booked", "confirmed"];

export function Appointments() {
  const { user } = useAuth();
  const isOwner = user?.role === "owner" || user?.role === "admin";
  const [scope, setScope] = useState<Scope>("upcoming");
  const [items, setItems] = useState<AppointmentListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<AppointmentListItem | null>(null);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [newForLead, setNewForLead] = useState<Lead | null>(null);
  const [bookingOpen, setBookingOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<{ appointments: AppointmentListItem[] }>(`/api/appointments?scope=${scope}`)
      .then((r) => setItems(r.appointments))
      .catch((e) => setError(e.message));
  }, [scope]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  const changeStatus = async (a: AppointmentListItem, status: AppointmentStatus) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/appointments/${a.appointment.id}`, { method: "PATCH", body: JSON.stringify({ status }) });
      load();
      setSelected((s) => (s?.appointment.id === a.appointment.id ? { ...s, appointment: { ...s.appointment, status } } : s));
      setBusy(false);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const openNewBooking = async () => {
    setError(null);
    try {
      const r = await api<{ leads: Lead[] }>("/api/leads");
      setLeads(r.leads.filter((l) => !["customer", "lost", "unqualified"].includes(l.status)));
      setNewForLead(null);
      setBookingOpen(true);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const shown = useMemo(() => items ?? [], [items]);

  return (
    <div>
      <PageHeader
        title="Appointments"
        subtitle="Booked, confirmed, completed, cancelled and no-show visits — with real availability."
        actions={
          <Button onClick={openNewBooking}>
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            New appointment
          </Button>
        }
      />

      {error ? <p className="mb-3 text-sm text-red-600">{error}</p> : null}

      {/* Scope tabs */}
      <div className="mb-4 flex gap-1 rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
        {(["upcoming", "past"] as Scope[]).map((s) => (
          <button
            key={s}
            onClick={() => setScope(s)}
            className={`flex-1 rounded-lg px-4 py-2 text-sm font-semibold capitalize transition-colors ${scope === s ? "bg-indigo-600 text-white" : "text-slate-500 hover:bg-slate-50"}`}
          >
            {s}
          </button>
        ))}
      </div>

      {!items ? (
        <Spinner label="Loading appointments…" />
      ) : shown.length === 0 ? (
        <EmptyState title={scope === "upcoming" ? "Nothing scheduled" : "No past appointments"} body="Book a visit from a lead's conversation or use “New appointment”." />
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50/60 text-left text-xs uppercase tracking-wide text-slate-400">
                <th className="px-4 py-2.5 font-medium">Lead</th>
                <th className="px-4 py-2.5 font-medium">Service</th>
                <th className="px-4 py-2.5 font-medium">When</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Value</th>
                <th className="px-4 py-2.5 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {shown.map((row) => {
                const a = row.appointment;
                const manageable = MANAGEABLE.includes(a.status);
                return (
                  <tr key={a.id} className="hover:bg-slate-50/50">
                    <td className="px-4 py-3">
                      <button onClick={() => setSelected(row)} className="text-left font-medium text-slate-800 hover:text-indigo-600">
                        {row.lead ? `${row.lead.firstName} ${row.lead.lastName}`.trim() || "Unnamed lead" : "—"}
                      </button>
                      <p className="text-xs text-slate-400">{row.lead?.phone || row.lead?.email || ""}</p>
                    </td>
                    <td className="px-4 py-3 text-slate-600">{row.serviceName ?? "—"}</td>
                    <td className="px-4 py-3 text-slate-600">{fmtDateTime(a.startAt)}</td>
                    <td className="px-4 py-3">
                      <Badge className={appointmentStatusColor[a.status]}>{appointmentStatusLabel[a.status]}</Badge>
                    </td>
                    <td className="px-4 py-3 text-slate-600">{row.lead?.estimatedValueCents ? money(row.lead.estimatedValueCents) : "—"}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1.5">
                        {manageable ? (
                          <>
                            <Button variant="secondary" className="!px-2.5 !py-1 text-xs" onClick={() => setSelected(row)}>
                              Detail
                            </Button>
                            <Button variant="secondary" className="!px-2.5 !py-1 text-xs" onClick={() => changeStatus(row, "confirmed")} disabled={busy || a.status === "confirmed"}>
                              Confirm
                            </Button>
                            <Button variant="secondary" className="!px-2.5 !py-1 text-xs" onClick={() => changeStatus(row, "completed")} disabled={busy}>
                              Complete
                            </Button>
                            <Button variant="secondary" className="!px-2.5 !py-1 text-xs" onClick={() => changeStatus(row, "no_show")} disabled={busy}>
                              No-show
                            </Button>
                            <Button variant="danger" className="!px-2.5 !py-1 text-xs" onClick={() => changeStatus(row, "cancelled")} disabled={busy}>
                              Cancel
                            </Button>
                          </>
                        ) : (
                          <Button variant="secondary" className="!px-2.5 !py-1 text-xs" onClick={() => setSelected(row)}>
                            View
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

      {/* Detail drawer */}
      {selected ? <DetailPanel item={selected} isOwner={isOwner} onClose={() => setSelected(null)} onChanged={() => load()} /> : null}

      {/* New-appointment booking flow */}
      {bookingOpen ? (
        <NewBookingModal leads={leads} onClose={() => setBookingOpen(false)} onLeadChosen={(lead) => setNewForLead(lead)} />
      ) : null}
      {newForLead ? <BookingModal leadId={newForLead.id} leadName={`${newForLead.firstName} ${newForLead.lastName}`.trim()} open onClose={() => { setNewForLead(null); setBookingOpen(false); }} onBooked={() => { setNewForLead(null); setBookingOpen(false); load(); }} /> : null}
    </div>
  );
}

/** Step 1 of new booking: pick a lead. */
function NewBookingModal({ leads, onClose, onLeadChosen }: { leads: Lead[]; onClose: () => void; onLeadChosen: (lead: Lead) => void }) {
  const [leadId, setLeadId] = useState("");
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-bold text-slate-900">New appointment</h2>
        <p className="mb-4 text-sm text-slate-500">Which lead is this visit for?</p>
        <Select value={leadId} onChange={(e) => setLeadId(e.target.value)}>
          <option value="">Choose a lead…</option>
          {leads.map((l) => (
            <option key={l.id} value={l.id}>
              {`${l.firstName} ${l.lastName}`.trim() || "Unnamed"} · {l.serviceRequested || "no service"} · {l.phone || l.email || "no contact"}
            </option>
          ))}
        </Select>
        {leads.length === 0 ? <p className="mt-2 text-xs text-amber-600">No active leads — create a lead first.</p> : null}
        <div className="mt-6 flex gap-2">
          <Button variant="secondary" className="flex-1" onClick={onClose}>
            Cancel
          </Button>
          <Button className="flex-1" disabled={!leadId} onClick={() => onLeadChosen(leads.find((l) => l.id === leadId)!) }>
            Choose service &amp; time
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Right-hand detail panel with lead info + status management + reschedule. */
function DetailPanel({ item, isOwner, onClose, onChanged }: { item: AppointmentListItem; isOwner: boolean; onClose: () => void; onChanged: () => void }) {
  const a = item.appointment;
  const lead = item.lead;
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (status: AppointmentStatus) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/appointments/${a.id}`, { method: "PATCH", body: JSON.stringify({ status }) });
      onChanged();
      setBusy(false);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-slate-900/30" onClick={onClose}>
      <div className="scroll-thin h-full w-full max-w-md overflow-y-auto bg-white p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between">
          <h2 className="text-lg font-bold text-slate-900">Appointment detail</h2>
          <button onClick={onClose} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600">
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        {error ? <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p> : null}

        <div className="space-y-4">
          <div className="rounded-xl border border-slate-100 bg-slate-50/60 p-4">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-slate-800">{item.serviceName ?? "Service"}</p>
              <Badge className={appointmentStatusColor[a.status]}>{appointmentStatusLabel[a.status]}</Badge>
            </div>
            <p className="mt-1 text-sm text-slate-600">{fmtDateTime(a.startAt)}</p>
            {a.notes ? <p className="mt-2 whitespace-pre-wrap rounded-lg bg-white p-2 text-xs text-slate-500">{a.notes}</p> : null}
          </div>

          {lead ? (
            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">Lead</p>
              <p className="text-sm font-semibold text-slate-800">
                {`${lead.firstName} ${lead.lastName}`.trim() || "Unnamed lead"}
              </p>
              <dl className="mt-1 space-y-1 text-[13px]">
                <Info label="Phone" value={lead.phone || "—"} />
                <Info label="Email" value={lead.email || "—"} />
                <Info label="Service requested" value={lead.serviceRequested || "—"} />
                <Info label="Location" value={lead.location || "—"} />
                <Info label="Status" value={`${lead.status} · ${lead.score}`} />
                <Info label="Est. value" value={lead.estimatedValueCents ? money(lead.estimatedValueCents) : "—"} />
              </dl>
            </div>
          ) : (
            <p className="text-sm text-slate-400">No lead attached.</p>
          )}

          {MANAGEABLE.includes(a.status) ? (
            <div className="space-y-2 border-t border-slate-100 pt-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Manage</p>
              <div className="grid grid-cols-2 gap-2">
                <Button variant="secondary" onClick={() => act("confirmed")} disabled={busy || a.status === "confirmed"}>
                  Confirm
                </Button>
                <Button variant="secondary" onClick={() => act("completed")} disabled={busy}>
                  Complete
                </Button>
                <Button variant="secondary" onClick={() => act("no_show")} disabled={busy}>
                  No-show
                </Button>
                <Button variant="danger" onClick={() => act("cancelled")} disabled={busy}>
                  Cancel
                </Button>
              </div>
              <Button variant="secondary" className="w-full" onClick={() => setRescheduleOpen((v) => !v)} disabled={busy}>
                {rescheduleOpen ? "Close reschedule" : "Reschedule…"}
              </Button>
              {rescheduleOpen ? (
                <RescheduleForm appointmentId={a.id} initialServiceId={a.serviceId} onDone={() => { setRescheduleOpen(false); onChanged(); }} />
              ) : null}
            </div>
          ) : null}

          {!isOwner ? <p className="text-xs text-slate-400">Employees can view and manage appointments but not billing or settings.</p> : null}
        </div>
      </div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-slate-400">{label}</dt>
      <dd className="truncate text-right font-medium text-slate-700">{value}</dd>
    </div>
  );
}

/** Reschedule: pick a new slot for the same service (real availability). */
function RescheduleForm({ appointmentId, initialServiceId, onDone }: { appointmentId: string; initialServiceId: string | null; onDone: () => void }) {
  const [days, setDays] = useState<{ date: string; slots: { startAt: number; endAt: number }[] }[] | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [slot, setSlot] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ days: { date: string; slots: { startAt: number; endAt: number }[] }[] }>("/api/appointments/availability", {
      method: "POST",
      body: JSON.stringify({ serviceId: initialServiceId, days: 7 }),
    })
      .then((r) => setDays(r.days))
      .catch((e) => setError(e.message));
  }, [initialServiceId]);

  const day = days?.find((d) => d.date === date) ?? null;

  const save = async () => {
    if (!slot) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/appointments/${appointmentId}`, { method: "PATCH", body: JSON.stringify({ startAt: slot }) });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-slate-100 bg-slate-50/60 p-3">
      <p className="mb-2 text-xs font-semibold text-slate-600">Pick a new time</p>
      {error ? <p className="mb-2 text-xs text-red-600">{error}</p> : null}
      {!days ? <Spinner label="Checking availability…" /> : days.length === 0 ? <p className="text-xs text-slate-400">No open times in the next 7 days.</p> : (
        <>
          <div className="flex flex-wrap gap-1.5">
            {days.map((d) => (
              <button key={d.date} onClick={() => { setDate(d.date); setSlot(null); }} className={`rounded-lg border px-2 py-1 text-[11px] font-medium ${date === d.date ? "border-indigo-600 bg-indigo-50 text-indigo-700" : "border-slate-200 bg-white text-slate-600"}`}>
                {new Date(`${d.date}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
              </button>
            ))}
          </div>
          {day ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {day.slots.map((s) => (
                <button key={s.startAt} onClick={() => setSlot(s.startAt)} className={`rounded-lg border px-2 py-1 text-xs font-semibold ${slot === s.startAt ? "border-indigo-600 bg-indigo-600 text-white" : "border-slate-200 bg-white text-slate-700"}`}>
                  {new Date(s.startAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
                </button>
              ))}
            </div>
          ) : null}
          <Button className="mt-3 w-full !py-1.5 text-xs" onClick={save} disabled={!slot || busy}>
            {busy ? "Saving…" : "Move appointment"}
          </Button>
        </>
      )}
    </div>
  );
}
