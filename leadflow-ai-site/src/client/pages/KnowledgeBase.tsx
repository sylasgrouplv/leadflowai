/** Knowledge Base — manage the entries the AI receptionist answers from (FAQ / policy / service info / general). */
import { useEffect, useState, type FormEvent } from "react";
import { api, type KnowledgeEntry } from "../api";
import { Badge, Button, Card, EmptyState, Field, Input, PageHeader, Select, Spinner, Textarea } from "../components/ui";

const KINDS = [
  { value: "faq", label: "FAQ", color: "bg-indigo-100 text-indigo-700" },
  { value: "policy", label: "Policy", color: "bg-amber-100 text-amber-700" },
  { value: "service_info", label: "Service info", color: "bg-emerald-100 text-emerald-700" },
  { value: "general", label: "General", color: "bg-slate-100 text-slate-600" },
] as const;

const emptyForm = { kind: "faq" as KnowledgeEntry["kind"], question: "", answer: "" };

export function KnowledgeBase() {
  const [entries, setEntries] = useState<KnowledgeEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<string>("all");
  const [editing, setEditing] = useState<KnowledgeEntry | "new" | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api<{ entries: KnowledgeEntry[] }>("/api/knowledge").then((r) => setEntries(r.entries)).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const remove = async (entry: KnowledgeEntry) => {
    if (!window.confirm(`Delete “${entry.question || entry.answer.slice(0, 60)}…”? The AI will no longer be able to answer from it.`)) return;
    setBusy(true);
    try {
      await api(`/api/knowledge/${entry.id}`, { method: "DELETE" });
      setEntries((es) => es?.filter((e) => e.id !== entry.id) ?? null);
      setBusy(false);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const save = async (form: { kind: KnowledgeEntry["kind"]; question: string; answer: string }) => {
    setBusy(true);
    try {
      if (editing === "new") {
        const res = await api<{ entry: KnowledgeEntry }>("/api/knowledge", { method: "POST", body: JSON.stringify(form) });
        setEntries((es) => (es ? [...es, res.entry] : [res.entry]));
      } else if (editing) {
        const res = await api<{ entry: KnowledgeEntry }>(`/api/knowledge/${editing.id}`, { method: "PATCH", body: JSON.stringify(form) });
        setEntries((es) => es?.map((e) => (e.id === res.entry.id ? res.entry : e)) ?? null);
      }
      setEditing(null);
      setBusy(false);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const visible = entries?.filter((e) => kindFilter === "all" || e.kind === kindFilter) ?? null;

  return (
    <div>
      <PageHeader
        title="Knowledge Base"
        subtitle="Everything your AI receptionist knows — it answers strictly from these entries (plus services, hours, and policies)."
        actions={
          <Button onClick={() => setEditing("new")}>
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            Add entry
          </Button>
        }
      />

      <div className="mb-4 flex flex-wrap gap-2">
        <FilterChip active={kindFilter === "all"} onClick={() => setKindFilter("all")} label="All" />
        {KINDS.map((k) => (
          <FilterChip key={k.value} active={kindFilter === k.value} onClick={() => setKindFilter(k.value)} label={k.label} />
        ))}
      </div>

      {error ? <p className="mb-3 text-sm text-red-600">{error}</p> : null}
      {busy ? <Spinner label="Working…" /> : null}

      {!visible ? (
        <Spinner label="Loading knowledge base…" />
      ) : visible.length === 0 ? (
        <EmptyState
          title={kindFilter === "all" ? "No knowledge entries yet" : `No ${kindFilter} entries`}
          body="Add FAQs, policies, and service details here — the AI receptionist answers leads from this content."
        />
      ) : (
        <div className="space-y-3">
          {visible.map((entry) => {
            const kind = KINDS.find((k) => k.value === entry.kind) ?? KINDS[3];
            return (
              <Card key={entry.id} className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Badge className={kind.color}>{kind.label}</Badge>
                      {entry.question ? <p className="truncate text-sm font-semibold text-slate-800">{entry.question}</p> : null}
                    </div>
                    <p className="mt-1.5 whitespace-pre-wrap text-[13px] leading-relaxed text-slate-600">{entry.answer}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => setEditing(entry)}>
                      Edit
                    </Button>
                    <Button variant="ghost" className="px-2 py-1 text-xs text-red-600 hover:bg-red-50" onClick={() => remove(entry)}>
                      Delete
                    </Button>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {editing ? (
        <EntryModal
          entry={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSave={save}
        />
      ) : null}
    </div>
  );
}

function FilterChip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${active ? "bg-indigo-600 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"}`}
    >
      {label}
    </button>
  );
}

function EntryModal({
  entry,
  onClose,
  onSave,
}: {
  entry: KnowledgeEntry | null;
  onClose: () => void;
  onSave: (form: { kind: KnowledgeEntry["kind"]; question: string; answer: string }) => Promise<void>;
}) {
  const [form, setForm] = useState(entry ? { kind: entry.kind, question: entry.question, answer: entry.answer } : emptyForm);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!form.answer.trim()) return;
    await onSave({ ...form, answer: form.answer.trim(), question: form.question.trim() });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-bold text-slate-900">{entry ? "Edit entry" : "Add knowledge entry"}</h2>
        <p className="mt-0.5 text-sm text-slate-500">The AI receptionist matches lead questions against the question and answers using the answer text.</p>
        <form onSubmit={submit} className="mt-4 space-y-3">
          <Field label="Kind">
            <Select value={form.kind} onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value as KnowledgeEntry["kind"] }))}>
              {KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Question (optional)" hint="e.g. “How much does a tune-up cost?” — the AI matches on this.">
            <Input value={form.question} onChange={(e) => setForm((f) => ({ ...f, question: e.target.value }))} placeholder="What the lead might ask" />
          </Field>
          <Field label="Answer *" hint="This is the exact wording the AI may use. Keep it accurate — the AI never adds to it.">
            <Textarea value={form.answer} onChange={(e) => setForm((f) => ({ ...f, answer: e.target.value }))} placeholder="The accurate, business-specific answer…" required />
          </Field>
          <div className="flex items-center justify-end gap-2 pt-1">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!form.answer.trim()}>
              {entry ? "Save changes" : "Add entry"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
