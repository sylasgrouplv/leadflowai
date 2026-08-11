/** Conversation Center — left: inbox · center: live thread with AI · right: lead panel + actions. */
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  api,
  fmtDateTime,
  money,
  scoreColor,
  statusColor,
  statusLabel,
  type ConversationBundle,
  type ConversationListItem,
  type LeadScore,
} from "../api";
import { Badge, Button, Card, Spinner } from "../components/ui";
import { BookingModal } from "../components/BookingModal";
import { useAuth } from "../App";

const SCORES: LeadScore[] = ["hot", "warm", "cold"];

export function ConversationDetail() {
  const { id = "" } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [bundle, setBundle] = useState<ConversationBundle | null>(null);
  const [items, setItems] = useState<ConversationListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [bookingOpen, setBookingOpen] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);
  const isOwner = user?.role === "owner" || user?.role === "admin";

  const loadBundle = useCallback(() => {
    return api<ConversationBundle>(`/api/chat/conversations/${id}`)
      .then(setBundle)
      .catch((e) => setError(e.message));
  }, [id]);

  const loadList = useCallback(() => {
    api<{ conversations: ConversationListItem[] }>("/api/chat/conversations")
      .then((r) => setItems(r.conversations))
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadBundle();
    loadList();
    const t = setInterval(() => {
      loadBundle();
      loadList();
    }, 5000);
    return () => clearInterval(t);
  }, [id, loadBundle, loadList]);

  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [bundle?.messages.length, bundle?.conversation.updatedAt]);

  const act = async (path: string, body?: unknown) => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<ConversationBundle>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined });
      setBundle(res);
      loadList();
      setBusy(false);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const body = draft.trim();
    if (!body || !bundle || sending) return;
    setDraft("");
    setSending(true);
    setError(null);
    const aiActive = bundle.ai.active && bundle.conversation.status !== "closed";
    try {
      // Optimistically append the lead's message so the thread feels live.
      setBundle((b) =>
        b
          ? {
              ...b,
              messages: [...b.messages, { id: `tmp-${Date.now()}`, conversationId: b.conversation.id, sender: "lead" as const, body, createdAt: Date.now() }],
            }
          : b
      );
      const res = await api<ConversationBundle>(`/api/chat/conversations/${id}/${aiActive ? "messages" : "reply"}`, {
        method: "POST",
        body: JSON.stringify({ body }),
      });
      setBundle(res);
      loadList();
      setSending(false);
    } catch (err) {
      setError((err as Error).message);
      setSending(false);
      loadBundle();
    }
  };

  if (error && !bundle) return <p className="text-sm text-red-600">{error}</p>;
  if (!bundle) return <Spinner label="Loading conversation…" />;

  const { conversation, lead, messages, appointments, nextFollowUp, ai } = bundle;
  const closed = conversation.status === "closed";
  const aiActive = ai.active && !closed;
  const name = lead ? `${lead.firstName} ${lead.lastName}`.trim() || "Unnamed lead" : "Unknown lead";

  return (
    <div className="-mx-6 -my-6 flex h-[calc(100vh-4rem)] overflow-hidden lg:-mx-8">
      {/* Left: conversation list */}
      <aside className="hidden w-72 shrink-0 flex-col border-r border-slate-200 bg-white md:flex">
        <div className="border-b border-slate-100 px-4 py-3">
          <p className="text-sm font-bold text-slate-800">Conversations</p>
          <p className="text-xs text-slate-400">{items?.length ?? 0} total</p>
        </div>
        <div className="scroll-thin flex-1 overflow-y-auto">
          {items?.map((c) => {
            const cname = c.lead ? `${c.lead.firstName} ${c.lead.lastName}`.trim() : "Unknown";
            const active = c.id === id;
            return (
              <Link
                key={c.id}
                to={`/app/conversations/${c.id}`}
                className={`block border-l-2 px-4 py-2.5 ${active ? "border-indigo-600 bg-indigo-50/60" : "border-transparent hover:bg-slate-50"}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <p className={`truncate text-[13px] font-semibold ${active ? "text-indigo-700" : "text-slate-700"}`}>{cname}</p>
                  {c.priority ? <span className="h-2 w-2 shrink-0 rounded-full bg-red-500" title="Needs human attention" /> : null}
                </div>
                <p className="truncate text-xs text-slate-400">
                  {c.lead ? `${statusLabel[c.lead.status]} · ${c.lead.score}` : c.status}
                </p>
              </Link>
            );
          })}
        </div>
      </aside>

      {/* Center: thread */}
      <section className="flex min-w-0 flex-1 flex-col bg-white">
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-3">
          <Link to="/app/conversations" className="text-slate-400 hover:text-slate-600 md:hidden">
            ←
          </Link>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="truncate text-sm font-bold text-slate-900">{name}</p>
              {lead ? <Badge className={scoreColor[lead.score]}>{lead.score}</Badge> : null}
              {lead ? <Badge className={statusColor[lead.status]}>{statusLabel[lead.status]}</Badge> : null}
            </div>
            <p className="text-xs text-slate-400">
              {lead ? `${lead.serviceRequested || "No service"} · ${lead.location || "No location"}` : "No lead attached"}
            </p>
          </div>
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${aiActive ? "bg-emerald-50 text-emerald-700" : closed ? "bg-slate-100 text-slate-500" : "bg-amber-50 text-amber-700"}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${aiActive ? "bg-emerald-500" : closed ? "bg-slate-400" : "bg-amber-500"}`} />
            {closed ? "Closed" : aiActive ? `AI handling (${ai.name})` : "Human held"}
          </span>
        </div>

        {/* Messages */}
        <div ref={threadRef} className="scroll-thin flex-1 space-y-3 overflow-y-auto bg-slate-50/50 px-5 py-4">
          {messages.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-slate-400">
              No messages yet — send the first one to start the conversation.
            </div>
          ) : (
            messages.map((m) => (
              <MessageBubble key={m.id} sender={m.sender} body={m.body} createdAt={m.createdAt} />
            ))
          )}
          {sending && aiActive ? (
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-slate-300 border-t-indigo-600" />
              AI is typing…
            </div>
          ) : null}
        </div>

        {/* Input */}
        <form onSubmit={send} className="border-t border-slate-100 p-3">
          {error ? <p className="mb-2 px-1 text-xs text-red-600">{error}</p> : null}
          {closed ? (
            <p className="px-1 py-2 text-center text-sm text-slate-400">This conversation is closed. Reopen it from the lead to continue.</p>
          ) : (
            <div className="flex items-center gap-2">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={aiActive ? "Send a message as the lead — the AI replies…" : "Reply as your business…"}
                className="flex-1 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
              />
              <Button type="submit" disabled={!draft.trim() || sending} className="rounded-xl px-5">
                {sending ? "Sending…" : aiActive ? "Send" : "Reply"}
              </Button>
            </div>
          )}
          {aiActive ? (
            <p className="mt-1.5 px-1 text-[11px] text-slate-400">
              You're simulating the lead — the AI receptionist responds automatically. Use “Take over” to reply as your business.
            </p>
          ) : !closed ? (
            <p className="mt-1.5 px-1 text-[11px] text-slate-400">The AI is paused. Your replies go straight to the lead as your business.</p>
          ) : null}
        </form>
      </section>

      {/* Right: lead panel */}
      <aside className="hidden w-80 shrink-0 flex-col overflow-y-auto border-l border-slate-200 bg-white lg:flex">
        <div className="border-b border-slate-100 px-5 py-3">
          <p className="text-sm font-bold text-slate-800">Lead</p>
        </div>
        <div className="flex-1 space-y-5 px-5 py-4">
          {lead ? (
            <>
              <div className="flex items-center gap-2">
                <Badge className={`font-bold uppercase tracking-wide ${scoreColor[lead.score]}`}>{lead.score}</Badge>
                <Badge className={statusColor[lead.status]}>{statusLabel[lead.status]}</Badge>
                {lead.estimatedValueCents > 0 ? <span className="ml-auto text-sm font-bold text-slate-800">{money(lead.estimatedValueCents)}</span> : null}
              </div>
              <dl className="space-y-2 text-[13px]">
                <InfoRow label="Phone" value={lead.phone || "—"} />
                <InfoRow label="Email" value={lead.email || "—"} />
                <InfoRow label="Service" value={lead.serviceRequested || "—"} />
                <InfoRow label="Location" value={lead.location || "—"} />
                <InfoRow label="Source" value={lead.source || "—"} />
                <InfoRow label="Created" value={fmtDateTime(lead.createdAt)} />
                {lead.lastContactedAt ? <InfoRow label="Last contacted" value={fmtDateTime(lead.lastContactedAt)} /> : null}
                {nextFollowUp ? <InfoRow label="Next follow-up" value={fmtDateTime(nextFollowUp.scheduledFor)} /> : null}
              </dl>

              {appointments.length ? (
                <div>
                  <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">Appointments</p>
                  {appointments.map((a) => (
                    <div key={a.appointment.id} className="rounded-lg border border-slate-100 bg-slate-50/60 px-3 py-2 text-[13px]">
                      <p className="font-medium text-slate-700">{a.serviceName ?? "Service"}</p>
                      <p className="text-xs text-slate-400">
                        {fmtDateTime(a.appointment.startAt)} · {a.appointment.status}
                      </p>
                    </div>
                  ))}
                </div>
              ) : null}

              {lead.notes ? (
                <div>
                  <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">Notes</p>
                  <p className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-2.5 text-[12.5px] leading-relaxed text-slate-600">{lead.notes}</p>
                </div>
              ) : null}

              <Link to={`/app/leads/${lead.id}`} className="block text-xs font-semibold text-indigo-600 hover:text-indigo-500">
                Open full lead record →
              </Link>
            </>
          ) : (
            <p className="text-sm text-slate-400">This conversation has no lead attached.</p>
          )}

          <div className="space-y-2 border-t border-slate-100 pt-4">
            {aiActive ? (
              <Button variant="secondary" className="w-full" onClick={() => act(`/api/chat/conversations/${id}/takeover`)} disabled={busy}>
                Take over
              </Button>
            ) : !closed ? (
              <Button variant="secondary" className="w-full" onClick={() => act(`/api/chat/conversations/${id}/return-to-ai`)} disabled={busy}>
                Return to AI
              </Button>
            ) : null}

            {lead && !closed ? (
              <div className="flex gap-2">
                <select
                  id="qual-score"
                  className="w-24 rounded-lg border border-slate-300 bg-white px-2 py-2 text-xs font-semibold text-slate-700 focus:border-indigo-500 focus:outline-none"
                  defaultValue="warm"
                >
                  {SCORES.map((s) => (
                    <option key={s} value={s}>
                      {s.toUpperCase()}
                    </option>
                  ))}
                </select>
                <Button
                  className="flex-1"
                  onClick={() => {
                    const score = (document.getElementById("qual-score") as HTMLSelectElement).value as LeadScore;
                    act(`/api/chat/conversations/${id}/qualified`, { score });
                  }}
                  disabled={busy}
                >
                  Mark Qualified
                </Button>
              </div>
            ) : null}

            <Button
              variant="secondary"
              className="w-full"
              onClick={() => setBookingOpen(true)}
              disabled={!lead || closed}
              title={lead ? "Book a real appointment from live calendar availability" : "Attach a lead to this conversation first"}
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" />
              </svg>
              Book Appointment
            </Button>

            {lead ? (
              <BookingModal
                leadId={lead.id}
                leadName={name}
                initialServiceId={undefined}
                open={bookingOpen}
                onClose={() => setBookingOpen(false)}
                onBooked={() => {
                  setBookingOpen(false);
                  loadBundle();
                  loadList();
                }}
              />
            ) : null}

            {lead && !closed && isOwner ? (
              <CloseLeadControl onClose={(outcome) => act(`/api/chat/conversations/${id}/close`, { outcome })} disabled={busy} />
            ) : null}
          </div>
        </div>
      </aside>
    </div>
  );
}

function MessageBubble({ sender, body, createdAt }: { sender: string; body: string; createdAt: number }) {
  const isLead = sender === "lead";
  const isAI = sender === "ai";
  const isEmployee = sender === "employee";
  return (
    <div className={`flex ${isLead ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[75%] rounded-2xl px-3.5 py-2.5 text-sm shadow-sm ${
          isLead
            ? "rounded-br-md bg-indigo-600 text-white"
            : isAI
              ? "rounded-bl-md border border-slate-200 bg-white text-slate-800"
              : isEmployee
                ? "rounded-bl-md bg-emerald-600 text-white"
                : "rounded-bl-md bg-slate-200 text-slate-600"
        }`}
      >
        <p className="whitespace-pre-wrap leading-relaxed">{body}</p>
        <p className={`mt-1 text-[10px] ${isLead ? "text-indigo-200" : "text-slate-400"}`}>
          {isAI ? "AI receptionist" : isEmployee ? "Your team" : isLead ? "Lead" : "System"} · {fmtDateTime(createdAt)}
        </p>
      </div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-slate-400">{label}</dt>
      <dd className="truncate text-right font-medium text-slate-700">{value}</dd>
    </div>
  );
}

function CloseLeadControl({ onClose, disabled }: { onClose: (outcome: "lost" | "unqualified" | "customer") => void; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState<"lost" | "unqualified" | "customer">("lost");
  if (!open) {
    return (
      <Button variant="danger" className="w-full opacity-90" onClick={() => setOpen(true)} disabled={disabled}>
        Close lead
      </Button>
    );
  }
  return (
    <div className="space-y-2 rounded-lg border border-red-100 bg-red-50/60 p-3">
      <p className="text-xs font-semibold text-slate-700">Close as…</p>
      <select value={outcome} onChange={(e) => setOutcome(e.target.value as typeof outcome)} className="w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-xs font-medium text-slate-700">
        <option value="lost">Lost</option>
        <option value="unqualified">Unqualified</option>
        <option value="customer">Customer (won)</option>
      </select>
      <div className="flex gap-2">
        <Button variant="secondary" className="flex-1 !py-1.5 text-xs" onClick={() => setOpen(false)} disabled={disabled}>
          Cancel
        </Button>
        <Button variant="danger" className="flex-1 !py-1.5 text-xs" onClick={() => onClose(outcome)} disabled={disabled}>
          Confirm
        </Button>
      </div>
    </div>
  );
}
