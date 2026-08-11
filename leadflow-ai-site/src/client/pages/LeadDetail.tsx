/** Lead detail — full record, edit, status/score transitions, notes, assignment, next follow-up, conversations. */
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  api,
  fmtDateTime,
  money,
  scoreColor,
  statusColor,
  statusLabel,
  type Lead,
  type LeadDetail as LeadDetailData,
  type LeadScore,
  type LeadStatus,
} from "../api";
import { Badge, Button, Card, EmptyState, Field, Input, PageHeader, Select, Spinner, Textarea } from "../components/ui";
import { BookingModal } from "../components/BookingModal";
import { useAuth } from "../App";

const STATUSES: LeadStatus[] = ["new", "contacted", "qualified", "appointment_booked", "customer", "lost", "unqualified", "needs_human"];
const SCORES: LeadScore[] = ["hot", "warm", "cold"];

export function LeadDetail() {
  const { id = "" } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState<LeadDetailData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isOwner = user?.role === "owner" || user?.role === "admin";
  const [bookingOpen, setBookingOpen] = useState(false);

  const load = () => {
    api<LeadDetailData>(`/api/leads/${id}`)
      .then(setData)
      .catch((e) => setError(e.message));
  };

  useEffect(load, [id]);

  const save = async (patch: Record<string, unknown>) => {
    setBusy(true);
    setSaved(null);
    try {
      const res = await api<{ lead: Lead }>(`/api/leads/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
      setData((d) => (d ? { ...d, lead: { ...d.lead, ...res.lead } } : d));
      setSaved("Saved.");
      setBusy(false);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const openChat = async () => {
    setBusy(true);
    try {
      const bundle = await api<{ conversation: { id: string } }>(`/api/leads/${id}/chat`, { method: "POST" });
      navigate(`/app/conversations/${bundle.conversation.id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  if (error && !data) return <p className="text-sm text-red-600">{error}</p>;
  if (!data) return <Spinner label="Loading lead…" />;
  const { lead, conversations, appointments, team } = data;

  return (
    <div>
      <PageHeader
        title={`${lead.firstName} ${lead.lastName}`.trim() || "Untitled lead"}
        subtitle={`Created ${fmtDateTime(lead.createdAt)} · ${lead.source || "no source"}`}
        actions={
          <>
            <Button variant="secondary" onClick={() => navigate("/app/leads")}>
              ← All leads
            </Button>
            <Button onClick={openChat} disabled={busy}>
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
              </svg>
              Open AI chat
            </Button>
            <Button variant="secondary" onClick={() => setBookingOpen(true)} disabled={["customer", "lost", "unqualified"].includes(lead.status)}>
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" />
              </svg>
              Book appointment
            </Button>
          </>
        }
      />

      {bookingOpen ? (
        <BookingModal
          leadId={lead.id}
          leadName={`${lead.firstName} ${lead.lastName}`.trim()}
          open
          onClose={() => setBookingOpen(false)}
          onBooked={() => { setBookingOpen(false); load(); }}
        />
      ) : null}

      {error ? <p className="mb-3 text-sm text-red-600">{error}</p> : null}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        {/* Left: editable details */}
        <Card className="p-5 xl:col-span-2">
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <Badge className={`font-bold uppercase tracking-wide ${scoreColor[lead.score]}`}>{lead.score}</Badge>
            <Badge className={statusColor[lead.status]}>{statusLabel[lead.status]}</Badge>
            {lead.estimatedValueCents > 0 ? <span className="text-sm font-semibold text-slate-700">{money(lead.estimatedValueCents)} est.</span> : null}
            {saved ? <span className="ml-auto text-xs font-medium text-emerald-600">{saved}</span> : null}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="First name">
              <Input defaultValue={lead.firstName} key={`fn-${lead.updatedAt}`} onBlur={(e) => e.target.value !== lead.firstName && save({ firstName: e.target.value })} />
            </Field>
            <Field label="Last name">
              <Input defaultValue={lead.lastName} key={`ln-${lead.updatedAt}`} onBlur={(e) => e.target.value !== lead.lastName && save({ lastName: e.target.value })} />
            </Field>
            <Field label="Phone">
              <Input defaultValue={lead.phone} key={`ph-${lead.updatedAt}`} onBlur={(e) => e.target.value !== lead.phone && save({ phone: e.target.value })} />
            </Field>
            <Field label="Email">
              <Input type="email" defaultValue={lead.email} key={`em-${lead.updatedAt}`} onBlur={(e) => e.target.value !== lead.email && save({ email: e.target.value })} />
            </Field>
            <Field label="Service requested">
              <Input defaultValue={lead.serviceRequested} key={`sv-${lead.updatedAt}`} onBlur={(e) => e.target.value !== lead.serviceRequested && save({ serviceRequested: e.target.value })} />
            </Field>
            <Field label="Location">
              <Input defaultValue={lead.location} key={`lo-${lead.updatedAt}`} onBlur={(e) => e.target.value !== lead.location && save({ location: e.target.value })} />
            </Field>
            <Field label="Status">
              <Select defaultValue={lead.status} key={`st-${lead.updatedAt}`} onChange={(e) => save({ status: e.target.value as LeadStatus })}>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {statusLabel[s]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Score">
              <Select defaultValue={lead.score} key={`sc-${lead.updatedAt}`} onChange={(e) => save({ score: e.target.value as LeadScore })} disabled={!isOwner}>
                {SCORES.map((s) => (
                  <option key={s} value={s}>
                    {s.toUpperCase()}
                  </option>
                ))}
              </Select>
            </Field>
            {isOwner ? (
              <>
                <Field label="Estimated value ($)">
                  <Input
                    type="number"
                    min={0}
                    defaultValue={lead.estimatedValueCents ? lead.estimatedValueCents / 100 : ""}
                    key={`ev-${lead.updatedAt}`}
                    onBlur={(e) => {
                      const v = Math.round((Number(e.target.value) || 0) * 100);
                      if (v !== lead.estimatedValueCents) save({ estimatedValueCents: v });
                    }}
                  />
                </Field>
                <Field label="Assigned to">
                  <Select defaultValue={lead.assignedTo ?? ""} key={`as-${lead.updatedAt}`} onChange={(e) => save({ assignedTo: e.target.value || null })}>
                    <option value="">Unassigned</option>
                    {team.map((m) => (
                      <option key={m.userId} value={m.userId}>
                        {m.name} ({m.role})
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Next follow-up">
                  <NextFollowUpInput lead={lead} onSave={(v) => save({ nextFollowUpAt: v })} />
                </Field>
                <Field label="Source">
                  <Select defaultValue={lead.source} key={`so-${lead.updatedAt}`} onChange={(e) => save({ source: e.target.value })}>
                    {["manual", "website_chat", "phone", "referral", "sms", "email"].map((s) => (
                      <option key={s} value={s}>
                        {s.replace("_", " ")}
                      </option>
                    ))}
                  </Select>
                </Field>
              </>
            ) : null}
          </div>

          <div className="mt-5 border-t border-slate-100 pt-4">
            <h3 className="text-sm font-semibold text-slate-800">Notes</h3>
            {lead.notes ? (
              <pre className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-3 font-sans text-[13px] text-slate-600">{lead.notes}</pre>
            ) : (
              <p className="mt-2 text-sm text-slate-400">No notes yet.</p>
            )}
            <AddNoteForm onAdd={async (note) => save({ note })} />
          </div>
        </Card>

        {/* Right: conversations + appointments */}
        <div className="space-y-6">
          <Card className="p-5">
            <h3 className="text-sm font-semibold text-slate-800">Conversations</h3>
            {conversations.length === 0 ? (
              <div className="mt-3">
                <EmptyState title="No conversation yet" body="Click “Open AI chat” to have the AI receptionist start qualifying this lead." />
              </div>
            ) : (
              <div className="mt-3 space-y-2">
                {conversations.map((c) => (
                  <Link
                    key={c.id}
                    to={`/app/conversations/${c.id}`}
                    className="flex items-center justify-between rounded-lg border border-slate-100 bg-slate-50/60 px-3 py-2.5 text-sm hover:bg-indigo-50"
                  >
                    <span className="font-medium text-slate-700">
                      {c.channel} {c.aiEnabled ? "· AI active" : "· human held"}
                    </span>
                    <span className="text-xs text-slate-400">{c.status.replace("_", " ")}</span>
                  </Link>
                ))}
              </div>
            )}
          </Card>

          <Card className="p-5">
            <h3 className="text-sm font-semibold text-slate-800">Appointments</h3>
            {appointments.length === 0 ? (
              <p className="mt-3 text-sm text-slate-400">None yet — booking UI arrives in the next build.</p>
            ) : (
              <div className="mt-3 space-y-2">
                {appointments.map((a) => (
                  <div key={a.appointment.id} className="flex items-center justify-between rounded-lg border border-slate-100 bg-slate-50/60 px-3 py-2.5 text-sm">
                    <span className="font-medium text-slate-700">{a.serviceName ?? "Service"}</span>
                    <span className="text-xs text-slate-400">
                      {fmtDateTime(a.appointment.startAt)} · {a.appointment.status}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {lead.lastContactedAt ? (
            <p className="text-xs text-slate-400">Last contacted {fmtDateTime(lead.lastContactedAt)}</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function NextFollowUpInput({ lead, onSave }: { lead: Lead; onSave: (ms: number) => void }) {
  const [val, setVal] = useState(() => (lead.nextFollowUp ? new Date(lead.nextFollowUp.scheduledFor).toISOString().slice(0, 16) : ""));
  return (
    <div className="flex gap-2">
      <Input type="datetime-local" value={val} onChange={(e) => setVal(e.target.value)} />
      <Button
        type="button"
        variant="secondary"
        onClick={() => {
          if (!val) return;
          onSave(new Date(val).getTime());
        }}
        disabled={!val}
      >
        Set
      </Button>
      {lead.nextFollowUp ? (
        <Button
          type="button"
          variant="ghost"
          onClick={() => onSave(null as unknown as number)}
          title="Clear next follow-up"
        >
          Clear
        </Button>
      ) : null}
    </div>
  );
}

function AddNoteForm({ onAdd }: { onAdd: (note: string) => Promise<void> }) {
  const [note, setNote] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!note.trim()) return;
    await onAdd(note.trim());
    setNote("");
  };
  return (
    <form onSubmit={submit} className="mt-3 flex items-start gap-2">
      <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note… (visible to your team)" className="min-h-12 flex-1" />
      <Button type="submit" variant="secondary" disabled={!note.trim()}>
        Add
      </Button>
    </form>
  );
}
