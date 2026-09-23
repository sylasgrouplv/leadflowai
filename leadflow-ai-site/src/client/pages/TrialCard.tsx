/**
 * Card step for the free trial (owner direction, BUILD 2).
 *
 * The 14-day trial REQUIRES a card. `TrialCardStep` is rendered inside the app
 * shell whenever a real trial clock is running and no card is on file yet, so
 * the trial is never reachable without completing this step. The button asks
 * the server for a hosted checkout session (POST /api/billing/trial-checkout)
 * and sends the browser to it; the provider returns to
 * `/app?trial_session=…`, which the app shell verifies through
 * POST /api/billing/trial-confirm.
 *
 * With the mock provider (no Stripe keys configured yet) the checkout URL is a
 * local test-mode page (`/mock-checkout`) that completes the same confirm call,
 * so the whole flow stays testable end-to-end — and that page says plainly that
 * no real card is collected or charged.
 *
 * Honest by construction: nothing here charges anything. $0 is taken today; the
 * first charge belongs to the provider's trial period and only happens if the
 * customer keeps the subscription after the trial ends.
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type BillingConfig } from "../api";
import { useAuth } from "../App";
import { Button, Card, Spinner } from "../components/ui";

/** What happens on each path of the card step — one source of truth. */
const FACTS = [
  { label: "Today", value: "$0 charged — the trial is free" },
  { label: "First charge", value: "Only when the 14-day trial ends, if you keep the plan" },
  { label: "Cancel before it ends", value: "You're never charged" },
];

export function TrialCardStep({ billing, error: parentError }: { billing?: BillingConfig | null; error?: string | null }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const message = error ?? parentError ?? null;
  const mockMode = !billing?.live;

  const start = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await api<{ url: string }>("/api/billing/trial-checkout", { method: "POST" });
      if (!res.url) throw new Error("No checkout link was returned — please try again.");
      // Hosted provider checkout (absolute) or the local test-mode page — both
      // are returned by the server; nothing is guessed here.
      window.location.href = res.url;
    } catch (e) {
      setError(e instanceof Error ? e.message : "We couldn't start checkout — please try again.");
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl py-6">
      <Card className="p-8">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-indigo-50 text-indigo-600">
          <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3m-3.75 3h15a2.25 2.25 0 002.25-2.25V6.75A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25v10.5A2.25 2.25 0 004.5 19.5z"
            />
          </svg>
        </span>
        <h1 className="mt-4 text-xl font-bold tracking-tight text-slate-900">Add your card to start the free trial</h1>
        {/* The exact honesty line the owner asked for (BUILD 2). */}
        <p className="mt-3 text-sm leading-relaxed text-slate-600">
          Enter your card to start the 14-day free trial — $0 charged today, cancel before the trial ends and you're never charged.
        </p>
        <p className="mt-2 text-sm leading-relaxed text-slate-600">
          Your account, leads, and automations are already set up, and nothing bills until the trial is over.
        </p>
        <dl className="mt-5 space-y-2 rounded-xl bg-slate-50 p-4">
          {FACTS.map((f) => (
            <div key={f.label} className="flex gap-3 text-sm">
              <dt className="w-40 shrink-0 font-semibold text-slate-700">{f.label}</dt>
              <dd className="text-slate-600">{f.value}</dd>
            </div>
          ))}
        </dl>
        {message ? (
          <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{message}</p>
        ) : null}
        <Button onClick={start} disabled={busy} className="mt-6 w-full sm:w-auto">
          {busy ? "Opening secure checkout…" : "Enter card & start the 14-day trial"}
        </Button>
        <p className="mt-4 text-xs leading-relaxed text-slate-400">
          {mockMode
            ? "Test mode: payments are not connected yet, so this opens a local test checkout — no card details are collected and nothing is charged."
            : "Payments are handled by Stripe on their secure checkout page. We never see or store your card number."}
        </p>
      </Card>
    </div>
  );
}

/**
 * `/mock-checkout` — the mock provider's stand-in for the hosted checkout page.
 * It confirms the session exactly like the real return trip does and then
 * continues into the app. Clearly labelled as test mode: nothing is charged and
 * no card details are ever collected here.
 */
export function MockCheckout() {
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [state, setState] = useState<"working" | "done" | "error">("working");
  const [error, setError] = useState("");

  useEffect(() => {
    const sessionId = new URLSearchParams(window.location.search).get("session_id") ?? "";
    let alive = true;
    (async () => {
      try {
        await api("/api/billing/trial-confirm", { method: "POST", body: JSON.stringify({ sessionId }) });
        await refresh();
        if (!alive) return;
        setState("done");
        window.setTimeout(() => navigate("/app", { replace: true }), 800);
      } catch (e) {
        if (!alive) return;
        setError(e instanceof Error ? e.message : "We couldn't confirm the trial.");
        setState("error");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (state === "working") return <Spinner label="Starting your 14-day free trial…" />;
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4">
      <Card className="w-full max-w-md p-8 text-center">
        <h1 className="text-lg font-bold tracking-tight text-slate-900">
          {state === "done" ? "Your 14-day trial is running" : "We couldn't start the trial"}
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-slate-600">
          {state === "done"
            ? "Test mode: no card was collected and nothing was charged. Redirecting you to your dashboard…"
            : error}
        </p>
        {state === "error" ? (
          <Button onClick={() => navigate("/app", { replace: true })} className="mt-6">
            Back to the app
          </Button>
        ) : null}
      </Card>
    </div>
  );
}
