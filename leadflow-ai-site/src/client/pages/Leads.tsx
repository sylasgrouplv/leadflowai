/** Leads — searchable/filterable pipeline with HOT/WARM/COLD scoring and manual test-lead creation. */
import { useEffect, useState, type FormEvent, type MouseEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  api,
  fmtDate,
  fmtDateTime,
  money,
  scoreColor,
  statusColor,
  statusLabel,
  type Lead,
  type LeadScore,
  type LeadStatus,
} from "../api";
import { Badge, Button, Card, EmptyState, Field, Input, PageHeader, Select, Spinner } from "../components/ui";
import { useAuth } from "../App";

const STATUS_OPTIONS: { value: LeadStatus | ""; label: string }[] = [
  { value: "", label: "All statuses" },
  ...(["new", "contacted", "qualified", "appointment_booked", "customer", "lost", "unqualified", "needs_human"] as LeadStatus[]).map((s) => ({
    value: s,
    label: statusLabel[s],
  })),
];

const SCORE_OPTIONS: { value: LeadScore | ""; label: string }[] = [
  { value: "", label: "All scores" },
  { value: "hot", label: "HOT" },
  { value: "warm", label: "WARM" },
  { value: "cold", label: "COLD" },
];

export function Leads() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<string>("");
  const [score, setScore] = useState<string>("");
  const [sort, setSort] = useState<string>("newest");
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);

  const load = () => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (status) params.set("status", status);
    if (score) params.set("score", score);
    params.set("sort", sort);
    api<{ leads: Lead[] }>(`/api/leads?${params.toString()}`)
      .then((r) => setLeads(r.leads))
      .catch((e) => setError(e.message));
  };

  useEffect(() => {
    const t = setTimeout(load, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [q, status, score, sort]);

  const openChat = async (lead: Lead, e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      const bundle = await api<{ conversation: { id: string } }>(`/api/leads/${lead.id}/chat`, { method: "POST" });
      navigate(`/app/conversations/${bundle.conversation.id}`);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div>
      <PageHeader
        title="Leads"
        subtitle="Everyone in your pipeline — every row is a real lead from your database."
        actions={
          user?.role === "owner" || user?.role === "admin" ? (
            <Button onClick={() => setShowCreate(true)}>
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
              Create Test Lead
            </Button>
          ) : undefined
        }
      />

      {/* Filters */}
      <Card className="mb-4 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-52 flex-1">
            <svg className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
            </svg>
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, phone, email, service, location…" className="pl-9" />
          </div>
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-40">
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <Select value={score} onChange={(e) => setScore(e.target.value)} className="w-36">
            {SCORE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <Select value={sort} onChange={(e) => setSort(e.target.value)} className="w-36">
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </Select>
        </div>
      </Card>

      {error ? <p className="mb-3 text-sm text-red-600">{error}</p> : null}

      {!leads ? (
        <Spinner label="Loading leads…" />
      ) : leads.length === 0 ? (
        <EmptyState
          title={q || status || score ? "No leads match your filters" : "No leads yet"}
          body={
            q || status || score
              ? "Try widening your search or clearing a filter."
              : "Create a test lead to try the pipeline, or once your AI receptionist captures website chats they'll land here automatically."
          }
        />
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50/60 text-left text-xs uppercase tracking-wide text-slate-400">
                  <th className="px-4 py-2.5 font-medium">Lead</th>
                  <th className="px-3 py-2.5 font-medium">Service</th>
                  <th className="px-3 py-2.5 font-medium">Location</th>
                  <th className="px-3 py-2.5 font-medium">Score</th>
                  <th className="px-3 py-2.5 font-medium">Status</th>
                  <th className="px-3 py-2.5 font-medium">Est. Value</th>
                  <th className="px-3 py-2.5 font-medium">Created</th>
                  <th className="px-3 py-2.5 font-medium">Last Contacted</th>
                  <th className="px-3 py-2.5 font-medium">Next Follow-Up</th>
                  <th className="px-4 py-2.5 font-medium">AI Chat</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {leads.map((lead) => (
                  <tr key={lead.id} className="group hover:bg-indigo-50/40">
                    <td className="px-4 py-3">
                      <Link to={`/app/leads/${lead.id}`} className="block">
                        <p className="font-semibold text-slate-800 group-hover:text-indigo-700">
                          {lead.firstName} {lead.lastName}
                        </p>
                        <p className="text-xs text-slate-400">{lead.phone || lead.email || lead.source || "—"}</p>
                      </Link>
                    </td>
                    <td className="px-3 py-3 text-slate-600">{lead.serviceRequested || "—"}</td>
                    <td className="px-3 py-3 text-slate-600">{lead.location || "—"}</td>
                    <td className="px-3 py-3">
                      <Badge className={`font-bold uppercase tracking-wide ${scoreColor[lead.score]}`}>{lead.score}</Badge>
                    </td>
                    <td className="px-3 py-3">
                      <Badge className={statusColor[lead.status]}>{statusLabel[lead.status]}</Badge>
                    </td>
                    <td className="px-3 py-3 text-slate-600">{lead.estimatedValueCents > 0 ? money(lead.estimatedValueCents) : "—"}</td>
                    <td className="px-3 py-3 text-slate-400">{fmtDate(lead.createdAt)}</td>
                    <td className="px-3 py-3 text-slate-400">{lead.lastContactedAt ? fmtDateTime(lead.lastContactedAt) : "—"}</td>
                    <td className="px-3 py-3 text-slate-400">
                      {lead.nextFollowUp ? (
                        <span title={fmtDateTime(lead.nextFollowUp.scheduledFor)}>
                          {fmtDate(lead.nextFollowUp.scheduledFor)}
                          <span className="ml-1 text-[10px] uppercase text-slate-300">{lead.nextFollowUp.type}</span>
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <button
                        onClick={(e) => openChat(lead, e)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-xs font-semibold text-indigo-700 hover:bg-indigo-100"
                        title="Open the AI receptionist chat for this lead"
                      >
                        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 3.694 9 8.25z" />
                        </svg>
                        AI
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {showCreate ? <CreateLeadModal onClose={() => setShowCreate(false)} onCreated={(id) => navigate(`/app/leads/${id}`)} onError={setError} onCreating={setCreating} creating={creating} /> : null}
    </div>
  );
}

function CreateLeadModal({
  onClose,
  onCreated,
  onError,
  creating,
  onCreating,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
  onError: (msg: string) => void;
  creating: boolean;
  onCreating: (v: boolean) => void;
}) {
  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
    phone: "",
    email: "",
    serviceRequested: "",
    location: "",
    estimatedValueCents: "",
    notes: "",
    source: "manual",
  });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!form.firstName.trim()) return onError("First name is required.");
    onCreating(true);
    try {
      const res = await api<{ lead: Lead }>("/api/leads", {
        method: "POST",
        body: JSON.stringify({
          ...form,
          estimatedValueCents: Number(form.estimatedValueCents) || 0,
        }),
      });
      onCreated(res.lead.id);
    } catch (err) {
      onError((err as Error).message);
      onCreating(false);
    }
  };

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-bold text-slate-900">Create Test Lead</h2>
        <p className="mt-0.5 text-sm text-slate-500">This writes a real lead to your pipeline — open its AI chat to try the receptionist.</p>
        <form onSubmit={submit} className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="First name *">
            <Input value={form.firstName} onChange={(e) => set("firstName", e.target.value)} placeholder="e.g. Jamie" required />
          </Field>
          <Field label="Last name">
            <Input value={form.lastName} onChange={(e) => set("lastName", e.target.value)} placeholder="e.g. Rivera" />
          </Field>
          <Field label="Phone">
            <Input value={form.phone} onChange={(e) => set("phone", e.target.value)} placeholder="(555) 555-5555" />
          </Field>
          <Field label="Email">
            <Input type="email" value={form.email} onChange={(e) => set("email", e.target.value)} placeholder="jamie@example.com" />
          </Field>
          <Field label="Service requested">
            <Input value={form.serviceRequested} onChange={(e) => set("serviceRequested", e.target.value)} placeholder="e.g. AC Repair" />
          </Field>
          <Field label="Location">
            <Input value={form.location} onChange={(e) => set("location", e.target.value)} placeholder="Zip or city" />
          </Field>
          <Field label="Estimated value ($)">
            <Input type="number" min={0} value={form.estimatedValueCents} onChange={(e) => set("estimatedValueCents", e.target.value)} placeholder="e.g. 350" />
          </Field>
          <Field label="Source">
            <Select value={form.source} onChange={(e) => set("source", e.target.value)}>
              <option value="manual">Manual</option>
              <option value="website_chat">Website chat</option>
              <option value="phone">Phone</option>
              <option value="referral">Referral</option>
            </Select>
          </Field>
          <div className="sm:col-span-2">
            <Field label="Notes">
              <Input value={form.notes} onChange={(e) => set("notes", e.target.value)} placeholder="Anything worth remembering…" />
            </Field>
          </div>
          <div className="mt-2 flex items-center justify-end gap-2 sm:col-span-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={creating}>
              {creating ? "Creating…" : "Create lead"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
