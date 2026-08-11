import { useEffect, useState } from "react";
import { api, money, type AiDashboardResponse, type SavingsAssumptions } from "../api";
import { Button, Card, PageHeader, Select, Spinner, cx } from "../components/ui";

const RANGES = [
  { days: 7, label: "Last 7 days" },
  { days: 30, label: "Last 30 days" },
  { days: 90, label: "Last 90 days" },
];

function Stat({ label, value, hint, estimate }: { label: string; value: string; hint?: string; estimate?: boolean }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
      <div className="flex items-center gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
        {estimate ? <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">ESTIMATE</span> : null}
      </div>
      <p className="mt-1 text-xl font-bold text-slate-900">{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-slate-400">{hint}</p> : null}
    </div>
  );
}

export function AiDashboard() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<AiDashboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hourly, setHourly] = useState("30");
  const [minutes, setMinutes] = useState("8");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = (d: number) => api<AiDashboardResponse>(`/api/ai/dashboard?days=${d}`).then(setData).catch((e) => setError(e.message));

  useEffect(() => {
    load(days);
  }, [days]);

  const saveAssumptions = async () => {
    setSaving(true);
    setSaved(false);
    try {
      const r = await api<{ assumptions: SavingsAssumptions }>("/api/ai/dashboard/savings", {
        method: "PUT",
        body: JSON.stringify({
          humanHourlyCostCents: Math.max(0, Math.floor(Number(hourly) * 100) || 0),
          minutesPerConversation: Math.max(1, Math.floor(Number(minutes) || 1)),
        }),
      });
      setHourly(String(r.assumptions.humanHourlyCostCents / 100));
      setMinutes(String(r.assumptions.minutesPerConversation));
      setSaved(true);
      load(days);
      setTimeout(() => setSaved(false), 2200);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save assumptions");
    } finally {
      setSaving(false);
    }
  };

  if (!data && !error) return <Spinner label="Loading AI performance…" />;
  const m = data?.metrics;
  const s = data?.savings;
  const fmtSec = (ms: number) => (ms > 0 ? `${Math.round(ms / 1000)}s` : "—");
  if (!data || !m) return <Spinner label="Loading AI performance…" />;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="AI Dashboard"
        subtitle={`Agent performance for the last ${days} days — computed from your real conversations, leads, and bookings.`}
      />
      {error ? <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p> : null}
      {data && m ? (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <p className="text-sm text-slate-500">
              Period: {new Date(data.periodStart).toLocaleDateString()} – {new Date(data.periodEnd).toLocaleDateString()} · {data.businessName}
            </p>
            <Select value={days} onChange={(e) => setDays(Number(e.target.value))} className="w-44">
              {RANGES.map((r) => (
                <option key={r.days} value={r.days}>{r.label}</option>
              ))}
            </Select>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="AI conversations" value={String(m.aiConversations)} hint={`${m.totalConversations} total · ${m.aiMessages} AI messages`} />
            <Stat label="AI resolution rate" value={`${m.aiResolutionRate}%`} hint={`${m.aiResolvedConversations} of ${m.aiConversations} handled without a human`} />
            <Stat label="Human escalations" value={String(m.escalations)} hint={`${m.humanEscalationRate}% of AI conversations`} />
            <Stat label="Appointments booked" value={String(m.appointmentsBooked)} hint={`${m.appointmentRate}% of leads`} />
            <Stat label="Follow-up conversions" value={String(m.followUpConversions)} hint={`${m.followUpConversionRate}% of ${m.followUpLeads} followed-up leads`} />
            <Stat label="Estimated revenue" value={money(m.estimatedRevenueCents)} estimate hint="Booked jobs × configured avg job value (§23)" />
            <Stat label="Avg response time" value={fmtSec(m.avgResponseTimeMs)} hint="First lead message → first AI reply" />
            <Stat label="Qualification rate" value={`${m.qualificationRate}%`} hint={`${m.qualifiedLeads} of ${m.leadsCreated} leads HOT/WARM`} />
          </div>

          {/* Savings estimate — §37, clearly labeled */}
          <Card className="p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="flex items-center gap-2 text-base font-bold text-slate-900">
                  AI savings estimate
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">Estimate</span>
                </h2>
                <p className="mt-0.5 text-sm text-slate-500">{s?.note}</p>
              </div>
            </div>
            <div className="mt-4 grid gap-3 border-t border-slate-100 pt-4 sm:grid-cols-3">
              <div className="rounded-xl bg-emerald-50 px-4 py-3">
                <p className="text-xs font-medium text-emerald-700">Estimated savings (period)</p>
                <p className="text-2xl font-bold text-emerald-800">{money(s?.estimatedSavingsCents ?? 0)}</p>
                <p className="mt-0.5 text-xs text-emerald-600">{s?.hoursSaved} human-hours saved ({s?.aiResolvedConversations} AI-resolved conversations × {s?.minutesPerConversation} min)</p>
              </div>
              <div>
                <p className="mb-1 text-xs font-semibold text-slate-600">Receptionist hourly cost (USD)</p>
                <input type="number" min={0} step={1} value={hourly} onChange={(e) => setHourly(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" />
              </div>
              <div>
                <p className="mb-1 text-xs font-semibold text-slate-600">Minutes per conversation</p>
                <input type="number" min={1} max={600} step={1} value={minutes} onChange={(e) => setMinutes(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" />
              </div>
            </div>
            <div className="mt-4 flex items-center gap-3">
              <Button onClick={saveAssumptions} disabled={saving}>{saving ? "Saving…" : "Update assumptions"}</Button>
              {saved ? <span className="text-sm font-medium text-emerald-600">Saved ✓</span> : null}
            </div>
            <p className="mt-3 text-xs text-slate-400">Assumptions are used only for this estimate — they never change how your AI behaves or how billing works.</p>
          </Card>

          {/* Per-agent performance */}
          <Card className="p-6">
            <h2 className="text-base font-bold text-slate-900">Agent activity</h2>
            <p className="mt-0.5 text-sm text-slate-500">Audited tool actions per agent in this period (the formal tool registry, §24–25).</p>
            <div className="mt-4 overflow-x-auto border-t border-slate-100 pt-4">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="text-xs uppercase tracking-wide text-slate-400">
                    <th className="pb-2 pr-4 font-semibold">Agent</th>
                    <th className="pb-2 pr-4 font-semibold">Actions</th>
                    <th className="pb-2 pr-4 font-semibold">Success</th>
                    <th className="pb-2 pr-4 font-semibold">Failed</th>
                    <th className="pb-2 font-semibold">Success rate</th>
                  </tr>
                </thead>
                <tbody>
                  {(m.agents ?? []).map((a) => (
                    <tr key={a.agent} className="border-t border-slate-100">
                      <td className="py-2 pr-4 font-medium capitalize text-slate-800">{a.agent}</td>
                      <td className="py-2 pr-4 text-slate-600">{a.actions}</td>
                      <td className="py-2 pr-4 text-emerald-600">{a.success}</td>
                      <td className="py-2 pr-4 text-red-500">{a.failed}</td>
                      <td className="py-2 text-slate-600">{a.successRate}%</td>
                    </tr>
                  ))}
                  {!(m.agents ?? []).length ? <tr><td colSpan={5} className="py-2 text-slate-400">No agent actions in this period yet.</td></tr> : null}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      ) : null}
    </div>
  );
}
