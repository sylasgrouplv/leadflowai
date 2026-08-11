import { useCallback, useEffect, useState } from "react";
import { api, type SystemHealthResponse } from "../api";
import { Button, Card, PageHeader, Spinner, cx } from "../components/ui";

export function SystemHealth() {
  const [data, setData] = useState<SystemHealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<SystemHealthResponse>("/api/health/system").then(setData).catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 30_000); // §40: no silent malfunction — auto-refresh
    return () => clearInterval(id);
  }, [load]);

  if (!data && !error) return <Spinner label="Checking system health…" />;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="System Health"
        subtitle="Live status for every service behind LeadFlow AI (spec §40). Nothing fails silently — anything that needs attention shows ACTION REQUIRED here."
      />
      {error ? <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p> : null}
      {data ? (
        <div className="space-y-6">
          <div
            className={cx(
              "flex items-center justify-between rounded-xl px-4 py-3",
              data.overall === "CONNECTED" ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700"
            )}
          >
            <div>
              <p className="text-sm font-bold">{data.overall}</p>
              <p className="text-xs opacity-80">{data.note}</p>
            </div>
            <div className="flex items-center gap-3">
              <p className="text-xs text-slate-400">Checked {new Date(data.checkedAt).toLocaleTimeString()} · refreshes every 30s</p>
              <Button onClick={load} variant="secondary" className="text-xs">Refresh now</Button>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.services.map((sv) => (
              <div key={sv.id} className={cx("rounded-xl border px-4 py-3", sv.status === "CONNECTED" ? "border-emerald-200 bg-white" : "border-red-200 bg-red-50/50")}>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-bold text-slate-800">{sv.label}</p>
                  <span
                    className={cx(
                      "rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide",
                      sv.status === "CONNECTED" ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-600"
                    )}
                  >
                    {sv.status}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-600">{sv.provider}</span>
                  {sv.kind === "mock" ? (
                    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700" title="Simulated provider — works, but not a live external connection">
                      MOCK · simulated
                    </span>
                  ) : null}
                </div>
                <p className="mt-2 text-xs leading-relaxed text-slate-500">{sv.detail}</p>
              </div>
            ))}
          </div>

          <Card className="p-5">
            <h2 className="text-sm font-bold text-slate-800">What these mean</h2>
            <ul className="mt-2 list-inside list-disc space-y-1 text-xs text-slate-500">
              <li><b>Mock (simulated)</b> — the provider interface is running with the built-in mock. It works end-to-end but makes no external connection. Swapping in a real provider is config-only: set the provider env var + API key.</li>
              <li><b>ACTION REQUIRED</b> — a provider is selected but its API key is missing, or the automation queue has failed/stuck runs. Fix the item, and the status updates automatically.</li>
              <li>Database is verified with a live query on every check — no assumptions.</li>
            </ul>
          </Card>
        </div>
      ) : null}
    </div>
  );
}
