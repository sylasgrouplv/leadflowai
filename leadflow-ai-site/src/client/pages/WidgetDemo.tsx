/**
 * /widget-demo — the public, no-login demo (spec §29).
 *
 * Loads the real embeddable widget against Smith's HVAC (the seeded demo
 * business) so anyone can talk to the AI receptionist without an account.
 * Supports ?businessId=… to preview any business's widget (used from the
 * Integrations page's "Open live preview").
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { PublicFooter, PublicNav, usePageTitle } from "../components/Public";

interface DemoInfo {
  businessId: string;
  businessName: string;
}

export function WidgetDemo() {
  usePageTitle("Live Demo — LeadFlow AI Website Chat Widget");
  const [info, setInfo] = useState<DemoInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const params = new URLSearchParams(window.location.search);
    const override = params.get("businessId");

    const load = async () => {
      try {
        let demo: DemoInfo;
        if (override) {
          // Preview a specific business's widget (owner preview flow).
          const cfg = await fetch(`/api/widget/config?businessId=${encodeURIComponent(override)}`).then((r) => r.json());
          if (!cfg || !cfg.businessId) throw new Error("No widget config for that business id");
          demo = { businessId: override, businessName: cfg.businessName };
        } else {
          demo = await fetch("/api/widget/demo-business").then((r) => r.json());
        }
        if (cancelled) return;
        setInfo(demo);
        injectWidget(demo.businessId);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Could not load the demo widget");
      }
    };
    load();

    return () => {
      cancelled = true;
      // Tear down the injected script + widget host so StrictMode remounts
      // (and route changes) don't stack widgets.
      const scriptEl = document.querySelector('script[data-lfw-demo][data-business-id]') as HTMLScriptElement | null;
      if (scriptEl) scriptEl.remove();
      const host = document.querySelector(".lfw-root");
      if (host && host.parentNode) host.parentNode.removeChild(host);
    };
  }, []);

  function injectWidget(businessId: string) {
    const existing = document.querySelector(`script[data-lfw-demo][data-business-id="${businessId}"]`);
    if (existing) return;
    const s = document.createElement("script");
    s.src = `${window.location.origin}/widget.js`;
    s.setAttribute("data-lfw-demo", "1");
    s.setAttribute("data-business-id", businessId);
    document.body.appendChild(s);
  }

  return (
    <div className="flex min-h-screen flex-col bg-white">
      <PublicNav />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-14 sm:px-6">
        <div className="text-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-emerald-100 bg-emerald-50 px-3.5 py-1.5 text-xs font-semibold text-emerald-700">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
            Live demo — no account needed
          </span>
          <h1 className="mt-5 text-3xl font-extrabold tracking-tight text-slate-900 sm:text-4xl">
            Talk to the AI receptionist
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-base leading-relaxed text-slate-600">
            This is the real widget, live, answering from {info ? info.businessName : "a demo business"}'s knowledge
            base. Chat with it like a homeowner would — it qualifies the lead, answers from the business's info, and can
            offer real appointment times.
          </p>
          <div className="mt-6 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              to="/login?demo=1"
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-6 py-3 text-sm font-semibold text-slate-700 shadow-sm transition-colors hover:bg-slate-50"
            >
              Explore the owner dashboard
              <span className="hidden text-xs font-normal text-slate-400 sm:inline">demo@leadflow.ai / demo1234</span>
            </Link>
            <Link to="/signup" className="inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-200 transition-colors hover:bg-indigo-500">
              Start Free
            </Link>
          </div>
        </div>

        {/* The widget floats bottom-right; this card keeps the page from feeling empty */}
        <div className="mx-auto mt-10 max-w-lg rounded-2xl border border-slate-200 bg-slate-50 p-6 text-sm leading-relaxed text-slate-500">
          <p className="font-semibold text-slate-700">Tips for the demo</p>
          <ul className="mt-3 list-disc space-y-1.5 pl-5">
            <li>Try: “Hi, my AC stopped cooling — can you come this week?”</li>
            <li>Ask about pricing: “How much is a tune-up?”</li>
            <li>Say “I'd like to book an appointment” to see real availability.</li>
            <li>Every conversation creates a real lead in the demo business — sign in above to see it in the inbox.</li>
          </ul>
          {error ? <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p> : null}
          {!info && !error ? (
            <p className="mt-4 flex items-center gap-2 text-slate-400">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-indigo-600" />
              Loading the demo widget…
            </p>
          ) : null}
        </div>
      </main>
      <PublicFooter />
    </div>
  );
}
