/** Dashboard — real funnel stats, funnel bar, recent leads, upcoming appointments. */
import { useEffect, useState } from "react";
import { api, fmtDate, fmtDateTime, money, scoreColor, statusColor, statusLabel, type DashboardData, type Lead } from "../api";
import { Badge, Card, EmptyState, PageHeader, Spinner } from "../components/ui";

export function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<DashboardData>("/api/dashboard")
      .then(setData)
      .catch((e) => setError(e.message));
  }, []);

  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!data) return <Spinner label="Loading dashboard…" />;

  const { stats, funnel } = data;
  const maxFunnel = Math.max(funnel.leads, 1);

  const cards = [
    { label: "Leads", value: String(stats.leads), sub: "all time", accent: "text-indigo-600" },
    { label: "Qualified", value: String(stats.qualified), sub: "hot & warm pipeline", accent: "text-emerald-600" },
    { label: "Appointments", value: String(stats.appointments), sub: "booked & confirmed", accent: "text-violet-600" },
    { label: "Conversion", value: `${stats.conversionRate}%`, sub: "leads → customers", accent: "text-amber-600" },
    { label: "Est. Revenue", value: money(stats.estimatedRevenueCents), sub: "booked & completed jobs (est.)", accent: "text-slate-900" },
  ];

  const funnelBars = [
    { label: "Leads", value: funnel.leads, color: "bg-indigo-500" },
    { label: "Qualified", value: funnel.qualified, color: "bg-emerald-500" },
    { label: "Appointments", value: funnel.appointments, color: "bg-violet-500" },
    { label: "Customers", value: funnel.customers, color: "bg-amber-500" },
  ];

  return (
    <div>
      <PageHeader
        title={`Welcome back, ${data.businessName}`}
        subtitle="Your lead engine at a glance — all numbers come straight from your data."
      />

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        {cards.map((c) => (
          <Card key={c.label} className="p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-400">{c.label}</p>
            <p className={`mt-1.5 text-2xl font-bold tracking-tight ${c.accent}`}>{c.value}</p>
            <p className="mt-0.5 text-xs text-slate-400">{c.sub}</p>
          </Card>
        ))}
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-3">
        {/* Funnel */}
        <Card className="p-5 xl:col-span-1">
          <h2 className="text-sm font-semibold text-slate-800">Funnel</h2>
          <p className="mt-0.5 text-xs text-slate-400">Leads → Qualified → Appointments → Customers</p>
          <div className="mt-5 space-y-4">
            {funnelBars.map((bar) => (
              <div key={bar.label}>
                <div className="mb-1 flex items-center justify-between text-xs">
                  <span className="font-medium text-slate-600">{bar.label}</span>
                  <span className="font-semibold text-slate-900">{bar.value}</span>
                </div>
                <div className="h-2.5 overflow-hidden rounded-full bg-slate-100">
                  <div className={`h-full rounded-full ${bar.color} transition-all`} style={{ width: `${Math.max((bar.value / maxFunnel) * 100, bar.value > 0 ? 4 : 0)}%` }} />
                </div>
              </div>
            ))}
          </div>
          <div className="mt-6 rounded-lg bg-slate-50 p-3 text-xs text-slate-500">
            <span className="font-semibold text-slate-700">{stats.conversionRate}%</span> of your leads become customers.{" "}
            {stats.leads === 0 ? "Add your first lead to start tracking." : `That's ${stats.customers} customer${stats.customers === 1 ? "" : "s"} so far.`}
          </div>
        </Card>

        {/* Recent leads */}
        <Card className="p-5 xl:col-span-2">
          <h2 className="text-sm font-semibold text-slate-800">Recent Leads</h2>
          {data.recentLeads.length === 0 ? (
            <div className="mt-4">
              <EmptyState title="No leads yet" body="Once your AI receptionist starts capturing website chats, new leads will appear here." />
            </div>
          ) : (
            <table className="mt-3 w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-400">
                  <th className="pb-2 pr-3 font-medium">Lead</th>
                  <th className="pb-2 pr-3 font-medium">Service</th>
                  <th className="pb-2 pr-3 font-medium">Score</th>
                  <th className="pb-2 pr-3 font-medium">Status</th>
                  <th className="pb-2 pr-3 font-medium">Value</th>
                  <th className="pb-2 font-medium">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {data.recentLeads.map((lead: Lead) => (
                  <tr key={lead.id}>
                    <td className="py-2.5 pr-3">
                      <p className="font-medium text-slate-800">
                        {lead.firstName} {lead.lastName}
                      </p>
                      <p className="text-xs text-slate-400">{lead.phone || lead.email || "—"}</p>
                    </td>
                    <td className="py-2.5 pr-3 text-slate-600">{lead.serviceRequested || "—"}</td>
                    <td className="py-2.5 pr-3">
                      <Badge className={scoreColor[lead.score]}>{lead.score}</Badge>
                    </td>
                    <td className="py-2.5 pr-3">
                      <Badge className={statusColor[lead.status]}>{statusLabel[lead.status]}</Badge>
                    </td>
                    <td className="py-2.5 pr-3 text-slate-600">{lead.estimatedValueCents > 0 ? money(lead.estimatedValueCents) : "—"}</td>
                    <td className="py-2.5 text-slate-400">{fmtDate(lead.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      {/* Upcoming appointments */}
      <Card className="mt-6 p-5">
        <h2 className="text-sm font-semibold text-slate-800">Upcoming Appointments</h2>
        {data.upcomingAppointments.length === 0 ? (
          <div className="mt-4">
            <EmptyState title="Nothing scheduled" body="When leads book through the AI receptionist, appointments will show up here." />
          </div>
        ) : (
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.upcomingAppointments.map((a) => (
              <div key={a.appointment.id} className="flex items-center gap-3 rounded-lg border border-slate-100 bg-slate-50/60 p-3">
                <span className="flex h-10 w-10 shrink-0 flex-col items-center justify-center rounded-lg bg-indigo-600 text-white">
                  <span className="text-[10px] font-semibold uppercase leading-none">{fmtDate(a.appointment.startAt).split(" ")[0]}</span>
                  <span className="text-sm font-bold leading-tight">{new Date(a.appointment.startAt).getDate()}</span>
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-slate-800">
                    {a.leadName ?? "Lead"} {a.leadLastName ?? ""}
                  </p>
                  <p className="truncate text-xs text-slate-400">
                    {a.serviceName ?? "Service"} · {fmtDateTime(a.appointment.startAt)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
