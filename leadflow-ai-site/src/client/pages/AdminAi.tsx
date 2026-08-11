import { useCallback, useEffect, useState } from "react";
import { api, money, type AdminAiResponse } from "../api";
import { Button, Card, PageHeader, Select, Spinner, cx } from "../components/ui";

const AGENT_LABELS: Record<string, string> = {
  receptionist: "AI Receptionist",
  qualification: "Lead Qualification",
  appointment: "Appointment",
  followup: "Follow-Up",
  review: "Customer Review",
  bi: "Business Intelligence",
  escalation: "Human Escalation",
};

const AGENT_ORDER = ["receptionist", "qualification", "appointment", "followup", "review", "bi", "escalation"];

export function AdminAi() {
  const [data, setData] = useState<AdminAiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [agents, setAgents] = useState<Record<string, boolean>>({});
  const [tone, setTone] = useState("Professional");
  const [length, setLength] = useState("Medium");
  const [sensitivity, setSensitivity] = useState("Balanced");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(() => {
    api<AdminAiResponse>("/api/admin/ai").then((d) => {
      setData(d);
      setAgents(d.agents);
      setTone(d.defaults.tone);
      setLength(d.defaults.responseLength);
      setSensitivity(d.defaults.escalationSensitivity);
    }).catch((e) => setError(e.message));
  }, []);

  useEffect(load, [load]);

  const save = async () => {
    setSaving(true);
    setSaved(false);
    try {
      const r = await api<AdminAiResponse>("/api/admin/ai", {
        method: "PUT",
        body: JSON.stringify({
          agents,
          defaults: { tone, responseLength: length, escalationSensitivity: sensitivity },
        }),
      });
      setAgents(r.agents);
      setTone(r.defaults.tone);
      setLength(r.defaults.responseLength);
      setSensitivity(r.defaults.escalationSensitivity);
      setSaved(true);
      setTimeout(() => setSaved(false), 2200);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setSaving(false);
    }
  };

  if (!data && !error) return <Spinner label="Loading admin AI control…" />;
  const fmt = (t: number) => new Date(t).toLocaleString();
  const u = data?.stats.monthUsage;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Admin · AI Control"
        subtitle="Platform-level AI control (spec §39). These switches and defaults apply to every business. Owners cannot change them — only admins can."
      />
      {error ? <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p> : null}
      {data ? (
        <div className="space-y-6">
          {/* Safety rules banner */}
          <div className="rounded-xl border border-indigo-100 bg-indigo-50 px-4 py-3">
            <p className="text-sm font-semibold text-indigo-800">Global safety rules (always on — not editable)</p>
            <p className="mt-1 text-xs text-indigo-600">
              {Object.entries(data.safetyRules).map(([k]) => k.replace(/([A-Z])/g, " $1").toLowerCase()).join(" · ")}
              . The AI never uses HIGH-RISK tools, never fabricates, never invents availability or pricing, respects opt-outs, escalates uncertainty, and protects private info.
            </p>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            {/* Agent switches */}
            <Card className="p-6">
              <h2 className="text-base font-bold text-slate-900">Agent switches</h2>
              <p className="mt-0.5 text-sm text-slate-500">Disable an agent globally. Safety-critical escalations (emergency, human request, cancel/refund/legal) still escalate. Failures are audited — never silent.</p>
              <div className="mt-4 space-y-3 border-t border-slate-100 pt-4">
                {AGENT_ORDER.map((key) => (
                  <label key={key} className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-slate-800">{AGENT_LABELS[key] ?? key}</p>
                      <p className="text-xs text-slate-400">{agents[key] ? "Enabled" : "Disabled"}</p>
                    </div>
                    <button
                      role="switch"
                      aria-checked={!!agents[key]}
                      onClick={() => setAgents((a) => ({ ...a, [key]: !a[key] }))}
                      className={cx("relative h-6 w-11 rounded-full transition-colors", agents[key] ? "bg-emerald-500" : "bg-slate-300")}
                    >
                      <span className={cx("absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all", agents[key] ? "left-[22px]" : "left-0.5")} />
                    </button>
                  </label>
                ))}
              </div>
            </Card>

            {/* Global defaults */}
            <Card className="p-6">
              <h2 className="text-base font-bold text-slate-900">Global defaults</h2>
              <p className="mt-0.5 text-sm text-slate-500">Applied to businesses that have not customized the field themselves. Per-business settings always win.</p>
              <div className="mt-4 space-y-4 border-t border-slate-100 pt-4">
                <div>
                  <p className="mb-1 text-xs font-semibold text-slate-600">Tone</p>
                  <Select value={tone} onChange={(e) => setTone(e.target.value)}>
                    {["Professional", "Friendly", "Casual", "Concise"].map((t) => <option key={t}>{t}</option>)}
                  </Select>
                </div>
                <div>
                  <p className="mb-1 text-xs font-semibold text-slate-600">Response length</p>
                  <Select value={length} onChange={(e) => setLength(e.target.value)}>
                    {["Short", "Medium", "Detailed"].map((t) => <option key={t}>{t}</option>)}
                  </Select>
                </div>
                <div>
                  <p className="mb-1 text-xs font-semibold text-slate-600">Escalation sensitivity</p>
                  <Select value={sensitivity} onChange={(e) => setSensitivity(e.target.value)}>
                    {["Conservative", "Balanced", "Aggressive"].map((t) => <option key={t}>{t}</option>)}
                  </Select>
                </div>
                <div className="flex items-center gap-3 pt-1">
                  <Button onClick={save} disabled={saving}>{saving ? "Saving…" : "Save changes"}</Button>
                  {saved ? <span className="text-sm font-medium text-emerald-600">Saved ✓</span> : null}
                </div>
              </div>
            </Card>
          </div>

          {/* Platform stats */}
          <Card className="p-6">
            <h2 className="text-base font-bold text-slate-900">Platform usage & escalations</h2>
            <div className="mt-4 grid gap-3 border-t border-slate-100 pt-4 sm:grid-cols-3 lg:grid-cols-5">
              <Stat label="AI conversations" value={String(data.stats.aiConversations)} />
              <Stat label="Escalations" value={String(data.stats.escalations)} />
              <Stat label="Escalation rate" value={`${data.stats.escalationRate}%`} />
              <Stat label="Failed automations (7d)" value={String(data.stats.failedAutomations)} />
              <Stat label="AI messages (month)" value={String(u?.aiMessages ?? 0)} hint={`$${((u?.estimatedCostCents ?? 0) / 100).toFixed(2)} est. cost`} />
            </div>
          </Card>

          {/* Agent errors */}
          <Card className="p-6">
            <h2 className="text-base font-bold text-slate-900">Agent errors</h2>
            <div className="mt-4 overflow-x-auto border-t border-slate-100 pt-4">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="text-xs uppercase tracking-wide text-slate-400">
                    <th className="pb-2 pr-4 font-semibold">When</th>
                    <th className="pb-2 pr-4 font-semibold">Business</th>
                    <th className="pb-2 pr-4 font-semibold">Agent</th>
                    <th className="pb-2 pr-4 font-semibold">Action</th>
                    <th className="pb-2 font-semibold">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {data.agentErrors.slice(0, 15).map((e) => (
                    <tr key={e.id} className="border-t border-slate-100 align-top">
                      <td className="py-2 pr-4 whitespace-nowrap text-slate-500">{fmt(e.createdAt)}</td>
                      <td className="py-2 pr-4 text-slate-700">{e.businessName}</td>
                      <td className="py-2 pr-4 font-medium capitalize text-slate-800">{e.agent}</td>
                      <td className="py-2 pr-4 font-mono text-xs text-slate-600">{e.action}</td>
                      <td className="py-2 max-w-md text-xs text-slate-500">{JSON.stringify(e.result ?? e.input ?? {}).slice(0, 120)}</td>
                    </tr>
                  ))}
                  {!data.agentErrors.length ? <tr><td colSpan={5} className="py-2 text-slate-400">No agent errors.</td></tr> : null}
                </tbody>
              </table>
            </div>
          </Card>

          {/* Action log */}
          <Card className="p-6">
            <h2 className="text-base font-bold text-slate-900">Action log (audit)</h2>
            <div className="mt-4 overflow-x-auto border-t border-slate-100 pt-4">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="text-xs uppercase tracking-wide text-slate-400">
                    <th className="pb-2 pr-4 font-semibold">When</th>
                    <th className="pb-2 pr-4 font-semibold">Business</th>
                    <th className="pb-2 pr-4 font-semibold">Agent</th>
                    <th className="pb-2 pr-4 font-semibold">Action</th>
                    <th className="pb-2 font-semibold">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {data.actionLogs.slice(0, 15).map((e) => (
                    <tr key={e.id} className="border-t border-slate-100">
                      <td className="py-2 pr-4 whitespace-nowrap text-slate-500">{fmt(e.createdAt)}</td>
                      <td className="py-2 pr-4 text-slate-700">{e.businessName}</td>
                      <td className="py-2 pr-4 font-medium capitalize text-slate-800">{e.agent}</td>
                      <td className="py-2 pr-4 font-mono text-xs text-slate-600">{e.action}</td>
                      <td className="py-2">{e.success ? <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">ok</span> : <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-600">failed</span>}</td>
                    </tr>
                  ))}
                  {!data.actionLogs.length ? <tr><td colSpan={5} className="py-2 text-slate-400">No actions logged yet.</td></tr> : null}
                </tbody>
              </table>
            </div>
          </Card>

          {/* Failed automations */}
          <Card className="p-6">
            <h2 className="text-base font-bold text-slate-900">Failed automations</h2>
            <div className="mt-4 overflow-x-auto border-t border-slate-100 pt-4">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="text-xs uppercase tracking-wide text-slate-400">
                    <th className="pb-2 pr-4 font-semibold">When</th>
                    <th className="pb-2 pr-4 font-semibold">Business</th>
                    <th className="pb-2 pr-4 font-semibold">Rule</th>
                    <th className="pb-2 font-semibold">Error</th>
                  </tr>
                </thead>
                <tbody>
                  {data.failedAutomations.slice(0, 15).map((e) => (
                    <tr key={e.id} className="border-t border-slate-100 align-top">
                      <td className="py-2 pr-4 whitespace-nowrap text-slate-500">{fmt(e.createdAt)}</td>
                      <td className="py-2 pr-4 text-slate-700">{e.businessName}</td>
                      <td className="py-2 pr-4 font-mono text-xs text-slate-600">{e.ruleKind}</td>
                      <td className="py-2 max-w-md text-xs text-slate-500">{e.lastError.slice(0, 140)}</td>
                    </tr>
                  ))}
                  {!data.failedAutomations.length ? <tr><td colSpan={4} className="py-2 text-slate-400">No failed automations.</td></tr> : null}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      ) : null}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-xl font-bold text-slate-900">{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-slate-400">{hint}</p> : null}
    </div>
  );
}
