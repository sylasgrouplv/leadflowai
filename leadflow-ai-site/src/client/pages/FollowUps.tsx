/**
 * Follow-Ups — the Follow-up Agent control surface (spec §9).
 *   - scheduled follow-ups table (lead, step #, due date, channel, status)
 *   - actions per row: reschedule, pause/resume, stop, mark done
 *   - per-lead controls: start sequence, stop sequence, opt out
 *   - owner-customizable sequence config (enable/disable steps, interval days)
 */
import { useCallback, useEffect, useState } from "react";
import { api, followUpStatusColor, followUpStatusLabel, fmtDateTime, type FollowUp, type FollowUpStepConfig, type FollowUpType } from "../api";
import { Badge, Button, Card, EmptyState, Field, Input, PageHeader, Select, Spinner } from "../components/ui";
import { useAuth } from "../App";

export function FollowUps() {
  const { user } = useAuth();
  const isOwner = user?.role === "owner" || user?.role === "admin";
  const [items, setItems] = useState<FollowUp[] | null>(null);
  const [config, setConfig] = useState<FollowUpStepConfig[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<{ followUps: FollowUp[]; config: FollowUpStepConfig[] }>("/api/follow-ups")
      .then((r) => {
        setItems(r.followUps);
        setConfig(r.config);
      })
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  const act = async (path: string, body?: unknown) => {
    setBusy(true);
    setError(null);
    try {
      await api(path, { method: body !== undefined ? "POST" : "POST", body: body ? JSON.stringify(body) : undefined });
      load();
      setBusy(false);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const patch = async (id: string, patchBody: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/follow-ups/${id}`, { method: "PATCH", body: JSON.stringify(patchBody) });
      load();
      setBusy(false);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const pending = items?.filter((f) => f.status === "pending" || f.status === "paused") ?? [];
  const history = items?.filter((f) => !["pending", "paused"].includes(f.status)) ?? [];

  return (
    <div>
      <PageHeader
        title="Follow-Ups"
        subtitle="Automated 1/3/7/14-day sequences that re-engage unconverted leads — stops automatically when a lead books, becomes a customer, or opts out."
      />

      {error ? <p className="mb-3 text-sm text-red-600">{error}</p> : null}

      {isOwner ? (
        <div className="mb-6 grid grid-cols-1 gap-6 xl:grid-cols-3">
          <Card className="p-5 xl:col-span-2">
            <SequenceEditor config={config} onSaved={(cfg) => { setConfig(cfg); load(); }} />
          </Card>
          <Card className="p-5">
            <h3 className="text-sm font-semibold text-slate-800">How it works</h3>
            <ul className="mt-3 space-y-2 text-[13px] leading-relaxed text-slate-500">
              <li>• A sequence starts the moment a lead becomes <span className="font-medium text-slate-700">Qualified</span>.</li>
              <li>• Each step fires on its due date via SMS/email (mock providers in this build — logged, never real sends).</li>
              <li>• The next step is scheduled only after the previous one fires, so edits here apply to future steps.</li>
              <li>• The sequence <span className="font-medium text-slate-700">stops</span> when the lead books an appointment, becomes a customer, opts out, or you stop it manually.</li>
              <li>• The scheduler runs every ~60 seconds in the server.</li>
            </ul>
          </Card>
        </div>
      ) : null}

      <Card className="overflow-hidden">
        <div className="border-b border-slate-100 px-4 py-3">
          <p className="text-sm font-bold text-slate-800">Scheduled ({pending.length})</p>
        </div>
        {!items ? (
          <Spinner label="Loading follow-ups…" />
        ) : pending.length === 0 ? (
          <div className="p-4">
            <EmptyState title="No follow-ups scheduled" body="Qualified leads automatically get a sequence — or use the lead's “Start follow-ups” action." />
          </div>
        ) : (
          <FollowUpTable rows={pending} busy={busy} onReschedule={(f, ms) => patch(f.id, { scheduledFor: ms })} onPauseResume={(f) => patch(f.id, { status: f.status === "paused" ? "pending" : "paused" })} onStop={(f) => act(`/api/follow-ups/${f.id}/stop`)} onDone={(f) => act(`/api/follow-ups/${f.id}/done`)} />
        )}
      </Card>

      {history.length ? (
        <Card className="mt-6 overflow-hidden">
          <div className="border-b border-slate-100 px-4 py-3">
            <p className="text-sm font-bold text-slate-800">History ({history.length})</p>
          </div>
          <FollowUpTable rows={history} busy={busy} compact />
        </Card>
      ) : null}
    </div>
  );
}

function FollowUpTable({
  rows,
  busy,
  compact,
  onReschedule,
  onPauseResume,
  onStop,
  onDone,
}: {
  rows: FollowUp[];
  busy: boolean;
  compact?: boolean;
  onReschedule?: (f: FollowUp, ms: number) => void;
  onPauseResume?: (f: FollowUp) => void;
  onStop?: (f: FollowUp) => void;
  onDone?: (f: FollowUp) => void;
}) {
  const [resched, setResched] = useState<FollowUp | null>(null);
  const [reschedVal, setReschedVal] = useState("");

  return (
    <>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-100 bg-slate-50/60 text-left text-xs uppercase tracking-wide text-slate-400">
            <th className="px-4 py-2.5 font-medium">Lead</th>
            <th className="px-4 py-2.5 font-medium">Step</th>
            <th className="px-4 py-2.5 font-medium">Due</th>
            <th className="px-4 py-2.5 font-medium">Channel</th>
            <th className="px-4 py-2.5 font-medium">Status</th>
            {!compact ? <th className="px-4 py-2.5 font-medium">Actions</th> : null}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-50">
          {rows.map((f) => (
            <tr key={f.id} className="hover:bg-slate-50/50">
              <td className="px-4 py-2.5">
                <p className="font-medium text-slate-800">
                  {f.lead ? `${f.lead.firstName} ${f.lead.lastName}`.trim() || "Unnamed lead" : "—"}
                </p>
                <p className="text-xs text-slate-400">{f.lead?.serviceRequested || ""}</p>
              </td>
              <td className="px-4 py-2.5">
                <Badge className={f.stepInfo.step ? "bg-indigo-100 text-indigo-700" : "bg-slate-100 text-slate-600"}>{f.stepInfo.label}</Badge>
              </td>
              <td className="px-4 py-2.5 text-slate-600">
                {fmtDateTime(f.scheduledFor)}
                {f.scheduledFor < Date.now() && (f.status === "pending" || f.status === "paused") ? <span className="ml-1.5 text-xs font-semibold text-red-500">overdue</span> : null}
              </td>
              <td className="px-4 py-2.5">
                <span className="inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  {f.type === "sms" ? "📱" : "✉️"} {f.type}
                </span>
              </td>
              <td className="px-4 py-2.5">
                <Badge className={followUpStatusColor[f.status]}>{followUpStatusLabel[f.status]}</Badge>
              </td>
              {!compact ? (
                <td className="px-4 py-2.5">
                  <div className="flex flex-wrap gap-1.5">
                    {f.status === "pending" || f.status === "paused" ? (
                      <>
                        <Button variant="secondary" className="!px-2.5 !py-1 text-xs" onClick={() => { setResched(f); setReschedVal(new Date(f.scheduledFor).toISOString().slice(0, 16)); }} disabled={busy}>
                          Reschedule
                        </Button>
                        <Button variant="secondary" className="!px-2.5 !py-1 text-xs" onClick={() => onPauseResume?.(f)} disabled={busy}>
                          {f.status === "paused" ? "Resume" : "Pause"}
                        </Button>
                        <Button variant="secondary" className="!px-2.5 !py-1 text-xs" onClick={() => onDone?.(f)} disabled={busy}>
                          Mark done
                        </Button>
                        <Button variant="danger" className="!px-2.5 !py-1 text-xs" onClick={() => onStop?.(f)} disabled={busy}>
                          Stop
                        </Button>
                      </>
                    ) : null}
                  </div>
                  {resched?.id === f.id ? (
                    <div className="mt-2 flex items-center gap-2">
                      <Input type="datetime-local" value={reschedVal} onChange={(e) => setReschedVal(e.target.value)} className="!w-auto !py-1 text-xs" />
                      <Button variant="secondary" className="!px-2.5 !py-1 text-xs" onClick={() => { if (reschedVal && onReschedule) onReschedule(f, new Date(reschedVal).getTime()); setResched(null); }} disabled={busy}>
                        Save
                      </Button>
                      <Button variant="ghost" className="!px-2 !py-1 text-xs" onClick={() => setResched(null)}>
                        Cancel
                      </Button>
                    </div>
                  ) : null}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function SequenceEditor({ config, onSaved }: { config: FollowUpStepConfig[]; onSaved: (config: FollowUpStepConfig[]) => void }) {
  const [draft, setDraft] = useState<FollowUpStepConfig[]>(config);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setDraft(config), [config]);

  const update = (i: number, patch: Partial<FollowUpStepConfig>) => {
    setDraft((d) => d.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
    setSaved(false);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/api/follow-ups/config", { method: "PUT", body: JSON.stringify({ steps: draft }) });
      onSaved(draft);
      setSaved(true);
      setBusy(false);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-800">Sequence settings</h3>
        {saved ? <span className="text-xs font-medium text-emerald-600">Saved ✓</span> : null}
      </div>
      <p className="mb-3 text-xs text-slate-400">Steps fire this many days after the lead qualifies. Changes apply to steps scheduled from now on.</p>
      {error ? <p className="mb-2 text-xs text-red-600">{error}</p> : null}
      <div className="space-y-2">
        {draft.map((s, i) => (
          <div key={s.step} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-100 bg-slate-50/60 px-3 py-2">
            <span className="w-14 text-xs font-bold text-slate-500">Step {s.step}</span>
            <label className="flex items-center gap-1.5 text-xs text-slate-600">
              <input type="checkbox" checked={s.enabled} onChange={(e) => update(i, { enabled: e.target.checked })} className="h-3.5 w-3.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />
              Enabled
            </label>
            <label className="flex items-center gap-1.5 text-xs text-slate-600">
              After
              <Input type="number" min={0} max={90} value={s.days} onChange={(e) => update(i, { days: Math.max(0, Math.min(90, Number(e.target.value) || 0)) })} className="!w-16 !py-1 text-xs" />
              days
            </label>
            <Select value={s.type} onChange={(e) => update(i, { type: e.target.value as FollowUpType })} className="!w-28 !py-1 text-xs">
              <option value="sms">SMS</option>
              <option value="email">Email</option>
            </Select>
          </div>
        ))}
      </div>
      <Button className="mt-3" onClick={save} disabled={busy || !draft.some((s) => s.enabled)}>
        {busy ? "Saving…" : "Save sequence"}
      </Button>
      {!draft.some((s) => s.enabled) ? <p className="mt-1 text-xs text-amber-600">At least one step must be enabled.</p> : null}
    </div>
  );
}
