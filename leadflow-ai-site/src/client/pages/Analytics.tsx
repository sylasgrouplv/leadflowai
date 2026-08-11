/**
 * /app/analytics — real analytics from live DB queries (success criterion 15).
 *
 * Leads over time (last 30 days), lead-source breakdown, conversion funnel,
 * top requested services, and AI-vs-human message volume. Plus AI BRAIN 4:
 * weekly Business Intelligence reports (spec §22) — deterministic aggregation
 * of the business's real rows with a mock-LLM narrative, listable + manually
 * triggerable. Revenue figures are revenue-attribution ESTIMATES (§23) and are
 * labeled as such — never presented as actuals.
 */
import { useEffect, useState } from "react";
import { api, money, fmtDate, type AnalyticsData, type WeeklyReport } from "../api";
import { Button, Card, EmptyState, PageHeader, Spinner } from "../components/ui";

const SOURCE_LABELS: Record<string, string> = {
  website_widget: "Website widget",
  website_chat: "Website chat",
  manual: "Manual entry",
  sms: "SMS",
  email: "Email",
  call: "Phone call",
  facebook: "Facebook",
  google: "Google",
  referral: "Referral",
};

export function Analytics() {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reports, setReports] = useState<WeeklyReport[]>([]);
  const [generating, setGenerating] = useState(false);
  const [reportsError, setReportsError] = useState<string | null>(null);

  const loadReports = () =>
    api<{ reports: WeeklyReport[] }>("/api/reports")
      .then((r) => setReports(r.reports))
      .catch(() => {});

  useEffect(() => {
    api<AnalyticsData>("/api/analytics")
      .then(setData)
      .catch((e) => setError(e.message));
    loadReports();
  }, []);

  const generateReport = async () => {
    setGenerating(true);
    setReportsError(null);
    try {
      await api("/api/reports/generate", { method: "POST", body: JSON.stringify({}) });
      await loadReports();
    } catch (err) {
      setReportsError(err instanceof Error ? err.message : "Could not generate the report");
    } finally {
      setGenerating(false);
    }
  };

  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!data) return <Spinner label="Crunching your numbers…" />;

  const { stats, funnel } = data;
  const maxDay = Math.max(...data.leadsOverTime.map((d) => d.count), 1);
  const maxSource = Math.max(...data.sources.map((s) => s.count), 1);
  const maxFunnel = Math.max(funnel.leads, 1);
  const maxSvc = Math.max(...data.topServices.map((s) => s.count), 1);

  const cards = [
    { label: "Leads", value: String(stats.leads), accent: "text-indigo-600" },
    { label: "Qualified", value: String(stats.qualified), accent: "text-emerald-600" },
    { label: "Appointments", value: String(stats.appointments), accent: "text-violet-600" },
    { label: "Customers", value: String(stats.customers), accent: "text-amber-600" },
    { label: "Conversion", value: `${stats.conversionRate}%`, accent: "text-slate-900" },
    { label: "Est. Revenue", value: money(stats.estimatedRevenueCents), accent: "text-slate-900" },
  ];

  return (
    <div>
      <PageHeader title="Analytics" subtitle="All numbers come straight from your business data. Revenue figures are estimates from configured average job values." />

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-6">
        {cards.map((c) => (
          <Card key={c.label} className="p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-400">{c.label}</p>
            <p className={`mt-1.5 text-xl font-bold tracking-tight ${c.accent}`}>{c.value}</p>
          </Card>
        ))}
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-2">
        {/* Leads over time */}
        <Card className="p-5">
          <h2 className="text-sm font-semibold text-slate-800">Leads over time</h2>
          <p className="mt-0.5 text-xs text-slate-400">New leads per day, last 30 days</p>
          <div className="mt-5 flex h-40 items-end gap-[3px]">
            {data.leadsOverTime.map((d) => (
              <div key={d.date} className="group relative flex-1" title={`${d.date}: ${d.count} lead${d.count === 1 ? "" : "s"}`}>
                <div
                  className={`w-full rounded-t-sm ${d.count > 0 ? "bg-indigo-500" : "bg-slate-100"}`}
                  style={{ height: `${Math.max((d.count / maxDay) * 100, d.count > 0 ? 6 : 2)}%` }}
                />
              </div>
            ))}
          </div>
          <div className="mt-2 flex justify-between text-[10px] text-slate-400">
            <span>{data.leadsOverTime[0]?.date}</span>
            <span>{data.leadsOverTime[data.leadsOverTime.length - 1]?.date}</span>
          </div>
        </Card>

        {/* Sources */}
        <Card className="p-5">
          <h2 className="text-sm font-semibold text-slate-800">Lead sources</h2>
          <p className="mt-0.5 text-xs text-slate-400">Where your leads come from</p>
          {data.sources.length === 0 ? (
            <div className="mt-4">
              <EmptyState title="No leads yet" body="Leads will appear here as they arrive from your website widget, manual entry, and other channels." />
            </div>
          ) : (
            <div className="mt-4 space-y-3">
              {data.sources.map((s) => (
                <div key={s.source}>
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <span className="font-medium text-slate-600">{SOURCE_LABELS[s.source] ?? s.source}</span>
                    <span className="font-semibold text-slate-900">
                      {s.count} <span className="font-normal text-slate-400">· {s.share}%</span>
                    </span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                    <div className="h-full rounded-full bg-emerald-500" style={{ width: `${(s.count / maxSource) * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Conversion funnel */}
        <Card className="p-5">
          <h2 className="text-sm font-semibold text-slate-800">Conversion funnel</h2>
          <p className="mt-0.5 text-xs text-slate-400">Leads → Qualified → Appointments → Customers</p>
          <div className="mt-5 space-y-4">
            {[
              { label: "Leads", value: funnel.leads, color: "bg-indigo-500" },
              { label: "Qualified", value: funnel.qualified, color: "bg-emerald-500" },
              { label: "Appointments", value: funnel.appointments, color: "bg-violet-500" },
              { label: "Customers", value: funnel.customers, color: "bg-amber-500" },
            ].map((bar) => (
              <div key={bar.label}>
                <div className="mb-1 flex items-center justify-between text-xs">
                  <span className="font-medium text-slate-600">{bar.label}</span>
                  <span className="font-semibold text-slate-900">{bar.value}</span>
                </div>
                <div className="h-2.5 overflow-hidden rounded-full bg-slate-100">
                  <div className={`h-full rounded-full ${bar.color}`} style={{ width: `${Math.max((bar.value / maxFunnel) * 100, bar.value > 0 ? 4 : 0)}%` }} />
                </div>
              </div>
            ))}
          </div>
          <div className="mt-5 rounded-lg bg-slate-50 p-3 text-xs text-slate-500">
            <span className="font-semibold text-slate-700">{stats.conversionRate}%</span> of leads become customers.{" "}
            {stats.aiMessages + stats.humanMessages > 0
              ? `${stats.aiMessages} messages handled by the AI receptionist, ${stats.humanMessages} by your team.`
              : "Once your AI starts chatting with leads, message volume shows up here."}
          </div>
        </Card>

        {/* Top services */}
        <Card className="p-5">
          <h2 className="text-sm font-semibold text-slate-800">Top requested services</h2>
          <p className="mt-0.5 text-xs text-slate-400">What leads ask for most</p>
          {data.topServices.length === 0 ? (
            <div className="mt-4">
              <EmptyState title="No services requested yet" />
            </div>
          ) : (
            <div className="mt-4 space-y-3">
              {data.topServices.map((sv) => (
                <div key={sv.service}>
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <span className="font-medium text-slate-600">{sv.service}</span>
                    <span className="font-semibold text-slate-900">{sv.count}</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                    <div className="h-full rounded-full bg-amber-500" style={{ width: `${(sv.count / maxSvc) * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* ------------------- Weekly reports (AI BRAIN 4, spec §22) ------------------- */}
      <div className="mt-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-slate-900">Weekly reports</h2>
            <p className="mt-0.5 text-sm text-slate-500">
              Business Intelligence summary of each completed week — generated automatically and from your real data.
            </p>
          </div>
          <Button onClick={generateReport} disabled={generating} variant="secondary">
            {generating ? "Generating…" : "Generate now"}
          </Button>
        </div>
        {reportsError ? <p className="mt-2 text-sm text-red-600">{reportsError}</p> : null}

        {reports.length === 0 ? (
          <Card className="mt-4 p-6">
            <EmptyState
              title="No weekly reports yet"
              body="The first report for a completed week appears automatically (or click “Generate now” to create it)."
            />
          </Card>
        ) : (
          <div className="mt-4 space-y-4">
            {reports.map((r) => (
              <Card key={r.id} className="p-5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="text-sm font-bold text-slate-900">
                    Week of {fmtDate(r.weekStart)} — {fmtDate(r.weekEnd)}
                  </h3>
                  <span className="text-xs text-slate-400">
                    <span className="font-medium text-slate-600">Estimated Revenue</span> {money(r.metrics.estimatedRevenueCents)}
                  </span>
                </div>
                <p className="mt-2 text-sm text-slate-600">{r.narrative.summary}</p>

                <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                  {[
                    ["New leads", String(r.metrics.newLeads)],
                    ["Qualified", String(r.metrics.qualified)],
                    ["Appointments", String(r.metrics.appointmentsBooked)],
                    ["Customers", String(r.metrics.customers)],
                    ["Lead → appt", `${r.metrics.leadToAppointmentRate}%`],
                    ["Conversion", `${r.metrics.conversionRate}%`],
                    ["AI messages", String(r.metrics.aiMessages)],
                    ["Avg. response", r.metrics.avgResponseTimeMs ? `${Math.max(1, Math.round(r.metrics.avgResponseTimeMs / 1000))}s` : "—"],
                  ].map(([label, value]) => (
                    <div key={label} className="rounded-lg bg-slate-50 px-3 py-2">
                      <p className="uppercase tracking-wide text-slate-400">{label}</p>
                      <p className="mt-0.5 font-semibold text-slate-800">{value}</p>
                    </div>
                  ))}
                </div>

                {r.narrative.wins.length > 0 && (
                  <div className="mt-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-emerald-600">Wins</p>
                    <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-slate-600">
                      {r.narrative.wins.map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {r.narrative.problems.length > 0 && (
                  <div className="mt-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-red-500">Problems</p>
                    <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-slate-600">
                      {r.narrative.problems.map((p, i) => (
                        <li key={i}>{p}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {r.narrative.opportunities.length > 0 && (
                  <div className="mt-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-amber-600">Opportunities</p>
                    <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-slate-600">
                      {r.narrative.opportunities.map((o, i) => (
                        <li key={i}>{o}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {r.narrative.recommendedActions.length > 0 && (
                  <div className="mt-3 rounded-lg bg-indigo-50/60 px-3 py-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-indigo-600">Recommended actions</p>
                    <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-slate-700">
                      {r.narrative.recommendedActions.map((a, i) => (
                        <li key={i}>{a}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
