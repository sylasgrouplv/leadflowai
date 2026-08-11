/**
 * /app/integrations — owner-facing integrations page (spec §14).
 *
 * 1. Website chat widget: enable/disable, primary color, position, welcome
 *    message, logo URL (stored per-business in widget_settings).
 * 2. Ready-to-paste install snippet with this business's id.
 * 3. Live preview link (opens /widget-demo?businessId=…).
 * 4. Provider status list (calendar, CRM, SMS, email, AI, Stripe).
 * 5. Customer reviews (AI BRAIN 4, spec §21): enabled, delay, review URL.
 * 6. Job values / revenue attribution (spec §23): per-service average job
 *    value — drives the clearly-labeled "Estimated Revenue" figures.
 */
import { useEffect, useState } from "react";
import { useAuth } from "../App";
import { api, money, type ReviewConfig, type Service } from "../api";
import { Button } from "../components/ui";

interface WidgetSettings {
  id: string;
  businessId: string;
  enabled: number;
  primaryColor: string;
  position: "bottom-left" | "bottom-right";
  welcomeMessage: string;
  logoUrl: string;
  welcomeFallback?: string;
}

interface ProviderRow {
  id: string;
  provider: string;
  status: string;
}

interface IntegrationsData {
  providers: Record<string, string>;
  integrations: ProviderRow[];
}

const PRESET_COLORS = ["#4f46e5", "#2563eb", "#0d9488", "#059669", "#d97706", "#dc2626", "#7c3aed", "#334155"];

const PROVIDER_LABELS: Record<string, string> = {
  ai: "AI provider",
  sms: "SMS",
  email: "Email",
  calendar: "Calendar",
  crm: "CRM",
  stripe: "Payments",
};

export function Integrations() {
  const { business } = useAuth();
  const [settings, setSettings] = useState<WidgetSettings | null>(null);
  const [integrations, setIntegrations] = useState<IntegrationsData | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // AI BRAIN 4 — review config + job values
  const [reviewConfig, setReviewConfig] = useState<ReviewConfig | null>(null);
  const [reviewSaving, setReviewSaving] = useState(false);
  const [reviewSaved, setReviewSaved] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [services, setServices] = useState<Service[]>([]);
  const [valueDrafts, setValueDrafts] = useState<Record<string, string>>({});
  const [valuesSaving, setValuesSaving] = useState(false);
  const [valuesSaved, setValuesSaved] = useState(false);
  const [valuesError, setValuesError] = useState<string | null>(null);

  useEffect(() => {
    api<{ settings: WidgetSettings; businessName: string }>("/api/widget/settings").then((r) => setSettings(r.settings)).catch(() => {});
    api<IntegrationsData>("/api/integrations").then(setIntegrations).catch(() => {});
    api<{ config: ReviewConfig }>("/api/reviews/config").then((r) => setReviewConfig(r.config)).catch(() => {});
    api<{ services: Service[] }>("/api/services").then((r) => setServices(r.services)).catch(() => {});
  }, []);

  const saveReview = async () => {
    if (!reviewConfig) return;
    setReviewSaving(true);
    setReviewSaved(false);
    setReviewError(null);
    try {
      const r = await api<{ config: ReviewConfig }>("/api/reviews/config", {
        method: "PUT",
        body: JSON.stringify({
          enabled: reviewConfig.enabled === 1,
          delay_days: reviewConfig.delayDays,
          review_url: reviewConfig.reviewUrl,
        }),
      });
      setReviewConfig(r.config);
      setReviewSaved(true);
      setTimeout(() => setReviewSaved(false), 2200);
    } catch (err) {
      setReviewError(err instanceof Error ? err.message : "Could not save review settings");
    } finally {
      setReviewSaving(false);
    }
  };

  const saveValues = async () => {
    setValuesSaving(true);
    setValuesSaved(false);
    setValuesError(null);
    try {
      const patched = services.map((sv) => {
        const raw = valueDrafts[sv.id];
        if (raw === undefined) return null;
        const cents = Math.max(0, Math.round(Number(raw) * 100) || 0);
        return api<{ service: Service }>(`/api/services/${sv.id}`, {
          method: "PATCH",
          body: JSON.stringify({ averageValueCents: cents }),
        });
      });
      await Promise.all(patched.filter(Boolean));
      const r = await api<{ services: Service[] }>("/api/services");
      setServices(r.services);
      setValueDrafts({});
      setValuesSaved(true);
      setTimeout(() => setValuesSaved(false), 2200);
    } catch (err) {
      setValuesError(err instanceof Error ? err.message : "Could not save job values");
    } finally {
      setValuesSaving(false);
    }
  };

  const snippet = business
    ? `<script src="${window.location.origin}/widget.js" data-business-id="${business.id}"></script>`
    : "";

  const copySnippet = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard unavailable — user can select manually */
    }
  };

  const save = async () => {
    if (!settings) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const r = await api<{ settings: WidgetSettings }>("/api/widget/settings", {
        method: "PUT",
        body: JSON.stringify({
          enabled: settings.enabled === 1,
          primaryColor: settings.primaryColor,
          position: settings.position,
          welcomeMessage: settings.welcomeMessage,
          logoUrl: settings.logoUrl,
        }),
      });
      setSettings(r.settings);
      setSaved(true);
      setTimeout(() => setSaved(false), 2200);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save settings");
    } finally {
      setSaving(false);
    }
  };

  if (!settings) {
    return (
      <div className="flex items-center justify-center py-24 text-sm text-slate-400">
        <span className="h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-indigo-600" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      {/* ------------------------- Website widget ------------------------- */}
      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-slate-900">Website chat widget</h2>
            <p className="mt-0.5 text-sm text-slate-500">
              Put your AI receptionist on your website. Visitors chat with it and it creates leads automatically.
            </p>
          </div>
          <label className="flex cursor-pointer items-center gap-2 rounded-full border border-slate-200 px-3.5 py-1.5">
            <input
              type="checkbox"
              checked={settings.enabled === 1}
              onChange={(e) => setSettings({ ...settings, enabled: e.target.checked ? 1 : 0 })}
              className="h-4 w-4 accent-indigo-600"
            />
            <span className="text-sm font-medium text-slate-700">{settings.enabled === 1 ? "Enabled" : "Disabled"}</span>
          </label>
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          {/* Left: customization controls */}
          <div className="space-y-5">
            <div>
              <label className="text-sm font-semibold text-slate-700">Primary color</label>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {PRESET_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-label={`Use ${c}`}
                    onClick={() => setSettings({ ...settings, primaryColor: c })}
                    className={`h-8 w-8 rounded-full border-2 transition-transform hover:scale-110 ${settings.primaryColor === c ? "border-slate-900 ring-2 ring-offset-2 ring-indigo-400" : "border-white shadow"}`}
                    style={{ backgroundColor: c }}
                  />
                ))}
                <input
                  type="color"
                  value={/^#[0-9a-fA-F]{6}$/.test(settings.primaryColor) ? settings.primaryColor : "#4f46e5"}
                  onChange={(e) => setSettings({ ...settings, primaryColor: e.target.value })}
                  className="h-8 w-10 cursor-pointer rounded border border-slate-200 bg-white p-0.5"
                  aria-label="Custom color"
                />
                <input
                  type="text"
                  value={settings.primaryColor}
                  onChange={(e) => setSettings({ ...settings, primaryColor: e.target.value })}
                  className="w-28 rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm"
                  placeholder="#4f46e5"
                />
              </div>
            </div>

            <div>
              <label className="text-sm font-semibold text-slate-700">Widget position</label>
              <div className="mt-2 flex gap-2">
                {(["bottom-right", "bottom-left"] as const).map((pos) => (
                  <button
                    key={pos}
                    type="button"
                    onClick={() => setSettings({ ...settings, position: pos })}
                    className={`rounded-xl border px-4 py-2 text-sm font-medium capitalize transition-colors ${
                      settings.position === pos
                        ? "border-indigo-500 bg-indigo-50 text-indigo-700"
                        : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                    }`}
                  >
                    {pos.replace("-", " ")}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-sm font-semibold text-slate-700" htmlFor="welcome-msg">
                Welcome message
              </label>
              <textarea
                id="welcome-msg"
                value={settings.welcomeMessage}
                onChange={(e) => setSettings({ ...settings, welcomeMessage: e.target.value })}
                rows={3}
                maxLength={500}
                placeholder={settings.welcomeFallback || "Hi! How can we help you today?"}
                className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
              />
              <p className="mt-1 text-xs text-slate-400">
                {settings.welcomeMessage
                  ? "Shown to every visitor when they open the chat."
                  : `Falls back to your business's welcome message${settings.welcomeFallback ? " (" + settings.welcomeFallback.slice(0, 60) + "…)" : ""}.`}
              </p>
            </div>

            <div>
              <label className="text-sm font-semibold text-slate-700" htmlFor="logo-url">
                Logo URL
              </label>
              <input
                id="logo-url"
                type="url"
                value={settings.logoUrl}
                onChange={(e) => setSettings({ ...settings, logoUrl: e.target.value })}
                placeholder="https://your-site.com/logo.png"
                className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
              />
              <p className="mt-1 text-xs text-slate-400">Optional. Leave blank to show the first letter of your business name.</p>
            </div>
          </div>

          {/* Right: live mini preview */}
          <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-5">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Live preview</p>
            <div className="relative mt-4 h-72 overflow-hidden rounded-xl border border-slate-200 bg-white">
              {/* Fake page */}
              <div className="space-y-2 p-5">
                <div className="h-3 w-2/3 rounded bg-slate-200" />
                <div className="h-3 w-1/2 rounded bg-slate-100" />
                <div className="h-3 w-3/4 rounded bg-slate-100" />
                <div className="h-3 w-2/5 rounded bg-slate-100" />
              </div>
              {/* Bubble */}
              <div
                className="absolute flex h-12 w-12 items-center justify-center rounded-full text-white shadow-lg"
                style={{ backgroundColor: settings.primaryColor, ...(settings.position === "bottom-left" ? { left: 18, bottom: 18 } : { right: 18, bottom: 18 }) }}
              >
                <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
                </svg>
              </div>
            </div>
            <p className="mt-3 text-xs text-slate-400">
              {settings.enabled === 1 ? "Widget is live on your site." : "Widget is disabled — no bubble will show on your site."}
            </p>
            <a
              href={`/widget-demo?businessId=${settings.businessId}`}
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-semibold text-slate-700 shadow-sm transition-colors hover:bg-slate-50"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
              </svg>
              Open live preview
            </a>
          </div>
        </div>

        <div className="mt-6 flex items-center gap-3 border-t border-slate-100 pt-5">
          <Button onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save widget settings"}
          </Button>
          {saved ? <span className="text-sm font-medium text-emerald-600">Saved ✓</span> : null}
          {error ? <span className="text-sm text-red-600">{error}</span> : null}
        </div>
      </section>

      {/* ------------------------- Install snippet ------------------------- */}
      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-bold text-slate-900">Install on your website</h2>
        <p className="mt-0.5 text-sm text-slate-500">
          Paste this one line just before <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">&lt;/body&gt;</code> on any page. No other setup needed.
        </p>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row">
          <pre className="flex-1 overflow-x-auto rounded-xl bg-slate-900 px-4 py-3.5 text-xs leading-relaxed text-emerald-300">
            <code>{snippet}</code>
          </pre>
          <button
            onClick={copySnippet}
            className="inline-flex h-fit shrink-0 items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 shadow-sm transition-colors hover:bg-slate-50"
          >
            {copied ? (
              <>
                <svg className="h-4 w-4 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                </svg>
                Copied!
              </>
            ) : (
              <>
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 01-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 011.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 00-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 01-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 00-3.375-3.375h-1.5a1.125 1.125 0 01-1.125-1.125v-1.5a3.375 3.375 0 00-3.375-3.375H9.75" />
                </svg>
                Copy snippet
              </>
            )}
          </button>
        </div>
        <p className="mt-3 text-xs text-slate-400">
          Works on any website — plain HTML, WordPress, Shopify, Webflow, React. The widget is fully styled in an isolated
          shadow DOM, so it won't clash with your site's CSS.
        </p>
      </section>

      {/* ------------------------- Provider status ------------------------- */}
      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-bold text-slate-900">Connections</h2>
        <p className="mt-0.5 text-sm text-slate-500">Providers powering your AI agents. Live services arrive as they're connected.</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {integrations?.integrations.map((row) => (
            <div key={row.provider} className="flex items-center justify-between rounded-xl border border-slate-100 bg-slate-50 px-4 py-3">
              <div>
                <p className="text-sm font-semibold text-slate-800">{PROVIDER_LABELS[row.provider] ?? row.provider}</p>
                <p className="text-xs text-slate-400">{integrations?.providers[row.provider] ?? row.provider}</p>
              </div>
              <span
                className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                  row.status === "mock" || row.status === "connected" ? "bg-emerald-100 text-emerald-700" : row.status === "error" ? "bg-red-100 text-red-700" : "bg-slate-100 text-slate-500"
                }`}
              >
                {row.status === "mock" ? "Demo mode" : row.status.replace("_", " ")}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* --------------------- Customer reviews (spec §21) --------------------- */}
      {reviewConfig ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold text-slate-900">Customer reviews</h2>
              <p className="mt-0.5 text-sm text-slate-500">
                After a completed job, the AI asks the customer for feedback. Positive feedback gets your review link;
                negative feedback becomes an internal task — never a public review request.
              </p>
            </div>
            <label className="flex cursor-pointer items-center gap-2 rounded-full border border-slate-200 px-3.5 py-1.5">
              <input
                type="checkbox"
                checked={reviewConfig.enabled === 1}
                onChange={(e) => setReviewConfig({ ...reviewConfig, enabled: e.target.checked ? 1 : 0 })}
                className="h-4 w-4 accent-indigo-600"
              />
              <span className="text-sm font-medium text-slate-700">{reviewConfig.enabled === 1 ? "Enabled" : "Disabled"}</span>
            </label>
          </div>

          <div className="mt-5 grid gap-5 lg:grid-cols-2">
            <div>
              <label className="text-sm font-semibold text-slate-700" htmlFor="review-delay">
                Ask for feedback after
              </label>
              <div className="mt-2 flex items-center gap-2">
                <input
                  id="review-delay"
                  type="number"
                  min={0}
                  max={90}
                  value={reviewConfig.delayDays}
                  onChange={(e) => setReviewConfig({ ...reviewConfig, delayDays: Math.max(0, Number(e.target.value) || 0) })}
                  className="w-24 rounded-xl border border-slate-200 px-3 py-2.5 text-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                />
                <span className="text-sm text-slate-500">day(s) after the job is completed</span>
              </div>
            </div>
            <div>
              <label className="text-sm font-semibold text-slate-700" htmlFor="review-url">
                Public review link
              </label>
              <input
                id="review-url"
                type="url"
                value={reviewConfig.reviewUrl}
                onChange={(e) => setReviewConfig({ ...reviewConfig, reviewUrl: e.target.value })}
                placeholder="https://www.google.com/maps/… (falls back to your website)"
                className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
              />
              <p className="mt-1 text-xs text-slate-400">Sent only after a customer gives positive feedback.</p>
            </div>
          </div>

          <div className="mt-5 flex items-center gap-3 border-t border-slate-100 pt-5">
            <Button onClick={saveReview} disabled={reviewSaving}>
              {reviewSaving ? "Saving…" : "Save review settings"}
            </Button>
            {reviewSaved ? <span className="text-sm font-medium text-emerald-600">Saved ✓</span> : null}
            {reviewError ? <span className="text-sm text-red-600">{reviewError}</span> : null}
          </div>
        </section>
      ) : null}

      {/* ------------------- Job values / revenue attribution (§23) ------------------- */}
      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-bold text-slate-900">Job values — revenue attribution</h2>
        <p className="mt-0.5 text-sm text-slate-500">
          Average value per job, used for <span className="font-semibold text-slate-700">Estimated Revenue</span> (booked jobs ×
          configured value). Estimates only — never actual revenue.
        </p>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-400">
                <th className="pb-2 pr-3 font-medium">Service</th>
                <th className="pb-2 pr-3 font-medium">List price</th>
                <th className="pb-2 pr-3 font-medium">Avg. job value (used for estimates)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {services.map((sv) => {
                const draft = valueDrafts[sv.id];
                return (
                  <tr key={sv.id}>
                    <td className="py-2.5 pr-3 font-medium text-slate-800">{sv.name}</td>
                    <td className="py-2.5 pr-3 text-slate-500">{sv.priceCents > 0 ? money(sv.priceCents) : "Call for pricing"}</td>
                    <td className="py-2.5 pr-3">
                      <div className="flex max-w-xs items-center gap-2">
                        <span className="text-slate-400">$</span>
                        <input
                          type="number"
                          min={0}
                          step="0.01"
                          value={draft ?? (sv.averageValueCents > 0 ? sv.averageValueCents / 100 : sv.priceCents / 100 || "")}
                          placeholder="0.00"
                          onChange={(e) => setValueDrafts({ ...valueDrafts, [sv.id]: e.target.value })}
                          className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm focus:border-indigo-400 focus:outline-none"
                        />
                        <span className="shrink-0 text-xs text-slate-400">{sv.averageValueCents > 0 ? "custom" : "= list price"}</span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="mt-4 flex items-center gap-3 border-t border-slate-100 pt-5">
          <Button onClick={saveValues} disabled={valuesSaving}>
            {valuesSaving ? "Saving…" : "Save job values"}
          </Button>
          {valuesSaved ? <span className="text-sm font-medium text-emerald-600">Saved ✓</span> : null}
          {valuesError ? <span className="text-sm text-red-600">{valuesError}</span> : null}
          <span className="text-xs text-slate-400">Leave 0 to use the list price as the average job value.</span>
        </div>
      </section>
    </div>
  );
}
