import { useEffect, useState } from "react";
import {
  api,
  type AiConfigResponse,
  type AiResponseLength,
  type AiTone,
  type BudgetStatus,
  type EscalationSensitivity,
} from "../api";
import { Button, Card, Field, PageHeader, Select, Spinner, Textarea, cx } from "../components/ui";

const SENSITIVITY_OPTIONS: Array<{ value: EscalationSensitivity; label: string; description: string }> = [
  { value: "Conservative", label: "Conservative — only serious situations", description: "Escalates only for emergencies, legal threats, refunds, property damage, and angry visitors. Uncertainty is handled with clarifying replies — the AI keeps the conversation." },
  { value: "Balanced", label: "Balanced — standard", description: "Also escalates any question the AI genuinely can't answer from your knowledge base. Recommended." },
  { value: "Aggressive", label: "Aggressive — escalate early", description: "Escalates standard triggers plus low-confidence answers — humans get involved at the first sign of uncertainty." },
];
const TONE_OPTIONS: Array<{ value: AiTone; label: string }> = [
  { value: "Professional", label: "Professional" },
  { value: "Friendly", label: "Friendly" },
  { value: "Casual", label: "Casual" },
  { value: "Concise", label: "Concise" },
];
const LENGTH_OPTIONS: Array<{ value: AiResponseLength; label: string; hint: string }> = [
  { value: "Short", label: "Short", hint: "1–2 sentences" },
  { value: "Medium", label: "Medium", hint: "~3 sentences" },
  { value: "Detailed", label: "Detailed", hint: "up to 6 sentences" },
];

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function AiAgents() {
  const [data, setData] = useState<AiConfigResponse | null>(null);
  const [welcomeMessage, setWelcomeMessage] = useState("");
  const [autoRespond, setAutoRespond] = useState(true);
  const [agentName, setAgentName] = useState("Sarah");
  const [tone, setTone] = useState<AiTone>("Professional");
  const [responseLength, setResponseLength] = useState<AiResponseLength>("Medium");
  const [sensitivity, setSensitivity] = useState<EscalationSensitivity>("Balanced");
  const [keywords, setKeywords] = useState("");
  const [budgetCents, setBudgetCents] = useState(10000);
  const [usage, setUsage] = useState<BudgetStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadUsage = () =>
    api<BudgetStatus>("/api/ai/usage")
      .then(setUsage)
      .catch(() => {});

  useEffect(() => {
    api<AiConfigResponse>("/api/ai/config")
      .then((r) => {
        setData(r);
        setWelcomeMessage(r.welcomeMessage);
        setAutoRespond(r.config.autoRespond);
        setAgentName(r.config.agentName);
        setTone(r.config.tone);
        setResponseLength(r.config.responseLength);
        setSensitivity(r.config.escalationSensitivity);
        setKeywords(r.config.escalationKeywords.join(", "));
        setBudgetCents(r.config.monthlyBudgetCents);
      })
      .catch((e) => setError(e.message));
    loadUsage();
  }, []);

  const save = async () => {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const r = await api<AiConfigResponse>("/api/ai/config", {
        method: "PUT",
        body: JSON.stringify({
          welcomeMessage,
          autoRespond,
          agentName,
          tone,
          responseLength,
          escalationSensitivity: sensitivity,
          escalationKeywords: keywords.split(",").map((k) => k.trim()).filter(Boolean),
          monthlyBudgetCents: Math.max(0, Math.floor(Number(budgetCents) || 0)),
        }),
      });
      setData(r);
      setWelcomeMessage(r.welcomeMessage);
      setAutoRespond(r.config.autoRespond);
      setAgentName(r.config.agentName);
      setTone(r.config.tone);
      setResponseLength(r.config.responseLength);
      setSensitivity(r.config.escalationSensitivity);
      setKeywords(r.config.escalationKeywords.join(", "));
      setBudgetCents(r.config.monthlyBudgetCents);
      setSaved(true);
      loadUsage();
      setTimeout(() => setSaved(false), 2200);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save configuration");
    } finally {
      setSaving(false);
    }
  };

  if (!data && !error) {
    return <Spinner label="Loading AI configuration…" />;
  }
  const pct = usage ? Math.min(100, usage.percentUsed) : 0;
  const pctColor = usage ? (usage.percentUsed >= 100 ? "bg-red-500" : usage.percentUsed >= 80 ? "bg-amber-500" : "bg-emerald-500") : "bg-emerald-500";

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="AI Agents"
        subtitle="Configure how your AI receptionist talks to leads, responds automatically, and hands off to your team."
      />
      {error && !data ? <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p> : null}
      <div className="space-y-6">
        {/* Receptionist */}
        <Card className="p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-base font-bold text-slate-900">Receptionist</h2>
              <p className="mt-0.5 text-sm text-slate-500">
                Answers questions from your knowledge base, collects lead details, offers real calendar times, and books
                appointments.
              </p>
            </div>
            <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-700">Active</span>
          </div>
          <div className="mt-5 space-y-5 border-t border-slate-100 pt-5">
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Agent name" hint="Shown to leads as the AI's name.">
                <input
                  type="text"
                  value={agentName}
                  onChange={(e) => setAgentName(e.target.value)}
                  maxLength={60}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  placeholder="Sarah"
                />
              </Field>
              <Field label="Tone" hint="How the AI phrases replies.">
                <Select value={tone} onChange={(e) => setTone(e.target.value as AiTone)}>
                  {TONE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Response length" hint="How much the AI writes.">
                <Select value={responseLength} onChange={(e) => setResponseLength(e.target.value as AiResponseLength)}>
                  {LENGTH_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label} — {o.hint}</option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label="Welcome message" hint="The first thing the AI says when a lead opens a chat.">
              <Textarea value={welcomeMessage} onChange={(e) => setWelcomeMessage(e.target.value)} rows={3} maxLength={2000} placeholder="Hi! Thanks for reaching out — how can we help?" />
            </Field>
            <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 p-4">
              <input
                type="checkbox"
                checked={autoRespond}
                onChange={(e) => setAutoRespond(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-indigo-600"
              />
              <span>
                <span className="block text-sm font-semibold text-slate-800">Auto-respond to new leads</span>
                <span className="mt-0.5 block text-sm text-slate-500">
                  {autoRespond
                    ? "New conversations start with the AI receptionist responding immediately."
                    : "New conversations start human-held — the AI stays quiet until your team returns it to the AI."}
                </span>
              </span>
            </label>
            <div>
              <p className="mb-2 text-sm font-semibold text-slate-700">Escalation sensitivity</p>
              <div className="grid gap-2 sm:grid-cols-3">
                {SENSITIVITY_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setSensitivity(opt.value)}
                    className={cx(
                      "rounded-xl border p-3 text-left transition-colors",
                      sensitivity === opt.value ? "border-indigo-500 bg-indigo-50/60 ring-1 ring-indigo-200" : "border-slate-200 bg-white hover:bg-slate-50"
                    )}
                  >
                    <span className={cx("block text-sm font-semibold", sensitivity === opt.value ? "text-indigo-700" : "text-slate-800")}>{opt.label}</span>
                    <span className="mt-1 block text-xs leading-relaxed text-slate-500">{opt.description}</span>
                  </button>
                ))}
              </div>
            </div>
            <Field label="Always-escalate phrases" hint="Comma-separated phrases that hand the conversation to a human no matter the sensitivity, e.g. 'work order', 'commercial job'.">
              <Textarea value={keywords} onChange={(e) => setKeywords(e.target.value)} rows={2} maxLength={1200} placeholder="commercial job, work order, insurance claim" />
            </Field>
          </div>
        </Card>

        {/* Usage & cost (spec §32) */}
        <Card className="p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-base font-bold text-slate-900">Usage &amp; cost — this month</h2>
              <p className="mt-0.5 text-sm text-slate-500">
                Estimated AI + SMS usage against your monthly budget. Cost figures are estimates, never bills.
              </p>
            </div>
            {usage?.exhausted ? (
              <span className="rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-medium text-red-700">Budget reached — AI paused</span>
            ) : null}
          </div>
          {usage ? (
            <div className="mt-4 space-y-4 border-t border-slate-100 pt-4">
              <div>
                <div className="mb-1 flex items-baseline justify-between text-sm">
                  <span className="font-semibold text-slate-800">{money(usage.usage.estimatedCostCents)} used</span>
                  <span className="text-slate-500">of {money(usage.budgetCents)} monthly budget</span>
                </div>
                <div className="h-3 w-full overflow-hidden rounded-full bg-slate-100">
                  <div className={cx("h-full rounded-full transition-all", pctColor)} style={{ width: `${Math.max(2, pct)}%` }} />
                </div>
                <div className="mt-1 flex justify-between text-xs text-slate-500">
                  <span>{usage.percentUsed.toFixed(1)}% used</span>
                  <span>
                    Alerts: {usage.alerts.filter((a) => a.reached).map((a) => `${a.threshold}%`).join(", ") || "none yet"}
                  </span>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
                <div className="rounded-xl bg-slate-50 px-3 py-2">
                  <p className="text-xs text-slate-500">AI messages</p>
                  <p className="text-lg font-bold text-slate-900">{usage.usage.aiMessages}</p>
                </div>
                <div className="rounded-xl bg-slate-50 px-3 py-2">
                  <p className="text-xs text-slate-500">SMS sent</p>
                  <p className="text-lg font-bold text-slate-900">{usage.usage.smsMessages}</p>
                </div>
                <div className="rounded-xl bg-slate-50 px-3 py-2">
                  <p className="text-xs text-slate-500">Voice</p>
                  <p className="text-lg font-bold text-slate-900">{usage.usage.voiceMessages}</p>
                </div>
                <div className="rounded-xl bg-slate-50 px-3 py-2">
                  <p className="text-xs text-slate-500">Input tokens</p>
                  <p className="text-lg font-bold text-slate-900">{usage.usage.inputTokens.toLocaleString()}</p>
                </div>
                <div className="rounded-xl bg-slate-50 px-3 py-2">
                  <p className="text-xs text-slate-500">Output tokens</p>
                  <p className="text-lg font-bold text-slate-900">{usage.usage.outputTokens.toLocaleString()}</p>
                </div>
              </div>
              <p className="text-xs text-slate-400">
                Estimated cost is calculated per AI reply and per SMS (deterministic mock rates today; real provider rates swap in
                later). When usage reaches 100% of the budget, AI auto-respond pauses — new conversations start human-held until you
                raise the budget or the month resets.
              </p>
              <Field label="Monthly budget (USD)" hint="0 disables alerts and the runaway-stop.">
                <input
                  type="number"
                  min={0}
                  step={5}
                  value={budgetCents / 100}
                  onChange={(e) => setBudgetCents(Math.round((Number(e.target.value) || 0) * 100))}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
              </Field>
            </div>
          ) : (
            <p className="mt-4 text-sm text-slate-500">Loading usage…</p>
          )}
        </Card>

        {/* Other agents summary */}
        <Card className="p-6">
          <h2 className="text-base font-bold text-slate-900">Working together</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {[
              { name: "Qualification", desc: "Collects name, phone, service, and location; scores leads HOT / WARM / COLD." },
              { name: "Appointment", desc: "Checks real calendar availability and books — never invents times." },
              { name: "Follow-up", desc: "Nudges unconverted leads at 1, 3, 7, and 14 days (customizable on Follow-Ups)." },
              { name: "Escalation", desc: "Flags angry, legal, safety, or refund situations for your team." },
            ].map((a) => (
              <div key={a.name} className="rounded-xl border border-slate-100 bg-slate-50/60 px-4 py-3">
                <p className="text-sm font-semibold text-slate-800">{a.name}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-slate-500">{a.desc}</p>
              </div>
            ))}
          </div>
        </Card>
        <div className="flex items-center gap-3">
          <Button onClick={save} disabled={saving || !data}>
            {saving ? "Saving…" : "Save AI configuration"}
          </Button>
          {saved ? <span className="text-sm font-medium text-emerald-600">Saved ✓</span> : null}
          {error && data ? <span className="text-sm text-red-600">{error}</span> : null}
        </div>
      </div>
    </div>
  );
}
