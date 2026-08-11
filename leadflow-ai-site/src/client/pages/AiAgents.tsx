/**
 * /app/agents — AI agent configuration (spec §13, success criterion 5).
 *
 * Real owner-facing controls, persisted per business and read by the engine:
 *   - Welcome message        (the first message the receptionist sends)
 *   - Auto-respond toggle    (new conversations start AI-handled or human-held)
 *   - Escalation sensitivity (how readily the AI hands off to a human)
 *   - Always-escalate phrases (owner keywords that trigger escalation)
 */
import { useEffect, useState } from "react";
import { api, type AiConfigResponse, type EscalationSensitivity } from "../api";
import { Button, Card, Field, PageHeader, Select, Spinner, Textarea, cx } from "../components/ui";

const SENSITIVITY_OPTIONS: Array<{ value: EscalationSensitivity; label: string; description: string }> = [
  { value: "low", label: "Low — only serious situations", description: "Escalates only for emergencies, legal threats, refunds, and property damage." },
  { value: "medium", label: "Medium — standard", description: "Also escalates angry or frustrated visitors and clear safety signals. Recommended." },
  { value: "high", label: "High — escalate early", description: "Escalates standard triggers plus any question the AI can't answer from your knowledge base." },
];

export function AiAgents() {
  const [data, setData] = useState<AiConfigResponse | null>(null);
  const [welcomeMessage, setWelcomeMessage] = useState("");
  const [autoRespond, setAutoRespond] = useState(true);
  const [sensitivity, setSensitivity] = useState<EscalationSensitivity>("medium");
  const [keywords, setKeywords] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<AiConfigResponse>("/api/ai/config")
      .then((r) => {
        setData(r);
        setWelcomeMessage(r.welcomeMessage);
        setAutoRespond(r.config.autoRespond);
        setSensitivity(r.config.escalationSensitivity);
        setKeywords(r.config.escalationKeywords.join(", "));
      })
      .catch((e) => setError(e.message));
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
          escalationSensitivity: sensitivity,
          escalationKeywords: keywords.split(",").map((k) => k.trim()).filter(Boolean),
        }),
      });
      setData(r);
      setWelcomeMessage(r.welcomeMessage);
      setAutoRespond(r.config.autoRespond);
      setSensitivity(r.config.escalationSensitivity);
      setKeywords(r.config.escalationKeywords.join(", "));
      setSaved(true);
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
