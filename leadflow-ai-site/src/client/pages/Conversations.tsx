/** Conversation Center — inbox of all AI receptionist conversations with priority flags. */
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, fmtDateTime, scoreColor, statusColor, statusLabel, type ConversationListItem } from "../api";
import { Badge, Button, Card, EmptyState, PageHeader, Spinner } from "../components/ui";

const STATUS_FILTERS = [
  { value: "all", label: "All" },
  { value: "ai_handling", label: "AI handling" },
  { value: "human_takeover", label: "Human held" },
  { value: "needs_human", label: "Needs human" },
  { value: "closed", label: "Closed" },
];

export function Conversations() {
  const navigate = useNavigate();
  const [items, setItems] = useState<ConversationListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("all");
  const [testing, setTesting] = useState(false);

  const load = () => {
    const params = status !== "all" ? `?status=${status}` : "";
    api<{ conversations: ConversationListItem[] }>(`/api/chat/conversations${params}`)
      .then((r) => setItems(r.conversations))
      .catch((e) => setError(e.message));
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [status]);

  const testAi = async () => {
    setTesting(true);
    setError(null);
    try {
      const bundle = await api<{ conversation: { id: string } }>("/api/chat/test", { method: "POST" });
      navigate(`/app/conversations/${bundle.conversation.id}`);
    } catch (e) {
      setError((e as Error).message);
      setTesting(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Conversations"
        subtitle="Every chat with a lead — the AI handles them until someone takes over."
        actions={
          <Button onClick={testAi} disabled={testing}>
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
            </svg>
            {testing ? "Starting…" : "Test your AI"}
          </Button>
        }
      />

      {error ? <p className="mb-3 text-sm text-red-600">{error}</p> : null}

      <div className="mb-4 flex flex-wrap gap-2">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setStatus(f.value)}
            className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${status === f.value ? "bg-indigo-600 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"}`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {!items ? (
        <Spinner label="Loading conversations…" />
      ) : items.length === 0 ? (
        <EmptyState
          title={status === "all" ? "No conversations yet" : "Nothing in this view"}
          body="Click “Test your AI” to open a chat with your receptionist and watch it qualify a lead live."
        />
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-slate-50">
            {items.map((c) => {
              const name = c.lead ? `${c.lead.firstName} ${c.lead.lastName}`.trim() : "Unknown lead";
              return (
                <li key={c.id}>
                  <Link to={`/app/conversations/${c.id}`} className="flex items-center gap-4 px-4 py-3 hover:bg-indigo-50/40">
                    <span className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-100 text-sm font-bold text-slate-600">
                      {name.charAt(0).toUpperCase() || "?"}
                      {c.priority ? (
                        <span className="absolute -right-0.5 -top-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-red-500 text-[8px] text-white" title="Needs human attention">
                          !
                        </span>
                      ) : null}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-sm font-semibold text-slate-800">{name}</p>
                        {c.priority ? <Badge className="bg-red-100 text-red-700">Priority</Badge> : null}
                        {c.lead ? <Badge className={scoreColor[c.lead.score]}>{c.lead.score}</Badge> : null}
                      </div>
                      <p className="truncate text-[13px] text-slate-500">
                        {c.lastMessage ? (
                          <>
                            <span className="font-medium text-slate-400">{c.lastMessage.sender === "ai" ? "AI" : c.lastMessage.sender === "lead" ? "Lead" : c.lastMessage.sender === "employee" ? "You" : "System"}:</span>{" "}
                            {c.lastMessage.body}
                          </>
                        ) : (
                          "No messages yet"
                        )}
                      </p>
                    </div>
                    <div className="hidden shrink-0 flex-col items-end gap-1 sm:flex">
                      {c.lead ? <Badge className={statusColor[c.lead.status]}>{statusLabel[c.lead.status]}</Badge> : null}
                      <span className="text-xs text-slate-400">{c.lastMessage ? fmtDateTime(c.lastMessage.createdAt) : fmtDateTime(c.updatedAt)}</span>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}
