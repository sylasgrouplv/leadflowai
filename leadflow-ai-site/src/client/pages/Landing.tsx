/** Public landing page — conversion-focused, all sections per spec §27. */
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { AGENTS, BENEFITS, FAQS, PLANS, SETUP_FEE_NOTE, TRUST_LINE } from "../content";
import { Check, PublicFooter, PublicNav, SectionHeading, usePageTitle } from "../components/Public";

/* ---------------------------------- Icons ---------------------------------- */

function BoltIcon() {
  return (
    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
    </svg>
  );
}
function MoonIcon() {
  return (
    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z" />
    </svg>
  );
}
function ClipboardIcon() {
  return (
    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6M9 8h6M7.5 3.75h9a2.25 2.25 0 012.25 2.25v13.5a2.25 2.25 0 01-2.25 2.25h-9a2.25 2.25 0 01-2.25-2.25V6a2.25 2.25 0 012.25-2.25z" />
    </svg>
  );
}
function QuestionIcon() {
  return (
    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9 5.25h.008v.008H12v-.008z" />
    </svg>
  );
}

const PROBLEMS = [
  {
    title: "Leads go cold fast",
    body: "When a homeowner reaches out, they're usually talking to three businesses. The one that answers first — with a real answer — gets the job.",
    icon: <BoltIcon />,
  },
  {
    title: "After-hours leads vanish",
    body: "The furnace dies at 9 p.m. Nobody picks up, so the lead leaves a voicemail — and books the first competitor who answers in the morning.",
    icon: <MoonIcon />,
  },
  {
    title: "Admin work eats your day",
    body: "Callbacks, quotes, reschedules, data entry, chasing 'just checking' leads for weeks. The busywork you hate is the leads you're losing.",
    icon: <ClipboardIcon />,
  },
  {
    title: "You fly blind",
    body: "Which channel actually produces customers? Where do your best leads come from? Without tracking, you guess — and you usually guess wrong.",
    icon: <QuestionIcon />,
  },
];

const STEPS = [
  {
    n: "01",
    title: "Connect your business",
    body: "A guided 10-minute setup: your services, hours, service area, and the answers your AI should know. No code, no spreadsheets.",
  },
  {
    n: "02",
    title: "Put the AI on your site",
    body: "Drop in the chat widget (one line of code) or share your LeadFlow link. The receptionist starts answering and qualifying leads immediately.",
  },
  {
    n: "03",
    title: "AI qualifies & books",
    body: "Every lead gets a fast, on-brand response. The AI collects details, scores the lead, checks real availability, and books appointments onto your calendar.",
  },
  {
    n: "04",
    title: "Follow up & measure",
    body: "Unconverted prospects get automatic follow-ups. You watch the funnel — Leads → Qualified → Appointments → Customers — and see what's working.",
  },
];

const LOOP = ["Capture", "Respond", "Qualify", "Book", "Follow Up", "Convert", "Measure"];

const AGENT_ICONS: Record<string, ReactNode> = {
  "AI Receptionist": (
    <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
  ),
  "Lead Qualification": (
    <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
  ),
  "Appointment Booking": (
    <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5m-9-6h.008v.008H12v-.008zM12 15h.008v.008H12V15zm0 2.25h.008v.008H12v-.008zM9.75 15h.008v.008H9.75V15zm0 2.25h.008v.008H9.75v-.008zM7.5 15h.008v.008H7.5V15zm0 2.25h.008v.008H7.5v-.008z" />
  ),
  "Follow-Up": (
    <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
  ),
  Review: (
    <path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" />
  ),
  "Business Intelligence": (
    <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
  ),
};

/* ------------------------------- Hero mock -------------------------------- */

function HeroChatMock() {
  const [messages] = useState([
    { from: "lead", text: "Hi — my AC stopped cooling. Can you come this week?", time: "9:41 PM" },
    { from: "ai", text: "Sorry to hear that! We can usually get a tech out within 48 hours. What's your address?", time: "9:41 PM" },
    { from: "lead", text: "123 Oak St. Do you serve Northside?", time: "9:42 PM" },
    { from: "ai", text: "Yes — Northside is in our service area. I have openings Wednesday 9–11 a.m. or 2–4 p.m. Which works?", time: "9:42 PM" },
    { from: "lead", text: "Wednesday morning works!", time: "9:43 PM" },
    { from: "ai", text: "Booked for Wednesday at 9 a.m. You'll get a confirmation text. Anything else I can help with?", time: "9:43 PM" },
  ]);
  return (
    <div className="mx-auto mt-14 max-w-2xl">
      <div className="relative">
        <div className="pointer-events-none absolute -inset-3 rounded-3xl bg-gradient-to-b from-indigo-200/60 to-violet-200/40 blur-2xl" />
        <div className="relative rounded-2xl border border-slate-200 bg-white p-5 shadow-xl shadow-indigo-100/60 sm:p-6">
          {/* Widget header */}
          <div className="flex items-center gap-3 border-b border-slate-100 pb-4">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-indigo-600 text-xs font-bold text-white">S</span>
            <div>
              <p className="text-sm font-semibold text-slate-900">Smith's HVAC</p>
              <p className="flex items-center gap-1.5 text-xs text-slate-400">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> AI receptionist · online now
              </p>
            </div>
          </div>
          {/* Messages */}
          <div className="space-y-3 pt-4">
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.from === "ai" ? "justify-start" : "justify-end"}`}>
                <div
                  className={`max-w-[80%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed ${
                    m.from === "ai"
                      ? "rounded-tl-sm border border-slate-200 bg-slate-50 text-slate-700"
                      : "rounded-tr-sm bg-indigo-600 text-white"
                  }`}
                >
                  <p>{m.text}</p>
                  <p className={`mt-1 text-right text-[10px] ${m.from === "ai" ? "text-slate-400" : "text-indigo-200"}`}>{m.time}</p>
                </div>
              </div>
            ))}
          </div>
          {/* Booking chip */}
          <div className="mt-4 flex items-center justify-between rounded-xl border border-emerald-100 bg-emerald-50 px-4 py-3">
            <div className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-600 text-white">
                <Check className="h-4 w-4" />
              </span>
              <div>
                <p className="text-sm font-semibold text-emerald-900">Appointment booked</p>
                <p className="text-xs text-emerald-700">Wed · 9:00 AM · confirmed & synced</p>
              </div>
            </div>
            <span className="hidden rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-emerald-700 shadow-sm sm:block">Booked</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ Dashboard mock ----------------------------- */

const MOCK_CARDS = [
  { label: "Leads", value: "40", sub: "all time", accent: "text-indigo-600" },
  { label: "Qualified", value: "26", sub: "hot & warm pipeline", accent: "text-emerald-600" },
  { label: "Appointments", value: "19", sub: "booked & confirmed", accent: "text-violet-600" },
  { label: "Conversion", value: "23%", sub: "leads → customers", accent: "text-amber-600" },
  { label: "Est. Revenue", value: "$11,500", sub: "pipeline value", accent: "text-slate-900" },
];

const MOCK_FUNNEL = [
  { label: "Leads", value: 40, color: "bg-indigo-500" },
  { label: "Qualified", value: 26, color: "bg-emerald-500" },
  { label: "Appointments", value: 19, color: "bg-violet-500" },
  { label: "Customers", value: 9, color: "bg-amber-500" },
];

const MOCK_LEADS = [
  { name: "Jordan M.", contact: "(555) 204-8811", service: "AC repair", score: "HOT", scoreCls: "bg-red-50 text-red-700", status: "Appointment Booked", statusCls: "bg-violet-50 text-violet-700", value: "$420", created: "Aug 11" },
  { name: "Priya S.", contact: "priya@email.com", service: "Duct cleaning", score: "WARM", scoreCls: "bg-amber-50 text-amber-700", status: "Qualified", statusCls: "bg-emerald-50 text-emerald-700", value: "$299", created: "Aug 11" },
  { name: "Tom R.", contact: "(555) 991-0342", service: "Furnace tune-up", score: "COLD", scoreCls: "bg-slate-100 text-slate-600", status: "New", statusCls: "bg-indigo-50 text-indigo-700", value: "—", created: "Aug 10" },
];

function DashboardMock() {
  return (
    <div className="relative">
      <div className="pointer-events-none absolute -inset-4 rounded-3xl bg-gradient-to-b from-indigo-100/50 to-transparent blur-2xl" />
      <div className="relative rounded-2xl border border-slate-200 bg-white p-5 shadow-xl shadow-indigo-100/50 sm:p-7">
        {/* App bar */}
        <div className="flex items-center justify-between border-b border-slate-100 pb-4">
          <div>
            <p className="text-sm font-semibold text-slate-900">Welcome back, Smith's HVAC</p>
            <p className="text-xs text-slate-400">Your lead engine at a glance</p>
          </div>
          <span className="hidden rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-semibold text-indigo-700 sm:block">Live dashboard</span>
        </div>

        {/* Stat cards */}
        <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
          {MOCK_CARDS.map((c) => (
            <div key={c.label} className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm">
              <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">{c.label}</p>
              <p className={`mt-1 text-xl font-bold tracking-tight ${c.accent} sm:text-2xl`}>{c.value}</p>
              <p className="mt-0.5 text-[11px] text-slate-400">{c.sub}</p>
            </div>
          ))}
        </div>

        <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-3">
          {/* Funnel */}
          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <p className="text-sm font-semibold text-slate-800">Funnel</p>
            <p className="mt-0.5 text-xs text-slate-400">Leads → Qualified → Appointments → Customers</p>
            <div className="mt-4 space-y-3.5">
              {MOCK_FUNNEL.map((bar) => (
                <div key={bar.label}>
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <span className="font-medium text-slate-600">{bar.label}</span>
                    <span className="font-semibold text-slate-900">{bar.value}</span>
                  </div>
                  <div className="h-2.5 overflow-hidden rounded-full bg-slate-100">
                    <div className={`h-full rounded-full ${bar.color}`} style={{ width: `${(bar.value / MOCK_FUNNEL[0].value) * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-5 rounded-lg bg-slate-50 p-3 text-xs text-slate-500">
              <span className="font-semibold text-slate-700">23%</span> of your leads become customers. That's 9 customers so far.
            </div>
          </div>

          {/* Recent leads */}
          <div className="rounded-xl border border-slate-200 bg-white p-5 lg:col-span-2">
            <p className="text-sm font-semibold text-slate-800">Recent Leads</p>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 text-left text-[11px] uppercase tracking-wide text-slate-400">
                    <th className="pb-2 pr-3 font-medium">Lead</th>
                    <th className="pb-2 pr-3 font-medium">Service</th>
                    <th className="pb-2 pr-3 font-medium">Score</th>
                    <th className="pb-2 pr-3 font-medium">Status</th>
                    <th className="pb-2 pr-3 font-medium">Value</th>
                    <th className="pb-2 font-medium">Created</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {MOCK_LEADS.map((lead) => (
                    <tr key={lead.name}>
                      <td className="py-2.5 pr-3">
                        <p className="font-medium text-slate-800">{lead.name}</p>
                        <p className="text-xs text-slate-400">{lead.contact}</p>
                      </td>
                      <td className="py-2.5 pr-3 text-slate-600">{lead.service}</td>
                      <td className="py-2.5 pr-3">
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${lead.scoreCls}`}>{lead.score}</span>
                      </td>
                      <td className="py-2.5 pr-3">
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${lead.statusCls}`}>{lead.status}</span>
                      </td>
                      <td className="py-2.5 pr-3 text-slate-600">{lead.value}</td>
                      <td className="py-2.5 text-slate-400">{lead.created}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <p className="mt-5 text-center text-[11px] text-slate-400">
          Sample data shown — this is an illustrative preview of the owner dashboard, not real customer data.
        </p>
      </div>
    </div>
  );
}

/* ---------------------------------- FAQ ----------------------------------- */

function FaqItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-slate-200 bg-white">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left"
      >
        <span className="text-sm font-semibold text-slate-900 sm:text-base">{q}</span>
        <span className={`shrink-0 text-slate-400 transition-transform ${open ? "rotate-45" : ""}`}>
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
        </span>
      </button>
      {open ? (
        <p className="px-5 pb-5 text-sm leading-relaxed text-slate-600">{a}</p>
      ) : null}
    </div>
  );
}

/* --------------------------------- Landing --------------------------------- */

export function Landing() {
  usePageTitle("LeadFlow AI — Turn More Leads Into Customers, Automatically");

  return (
    <div className="min-h-screen bg-white">
      <PublicNav />

      {/* ------------------------------- Hero ------------------------------- */}
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute -top-48 left-1/2 h-[34rem] w-[60rem] -translate-x-1/2 rounded-full bg-gradient-to-b from-indigo-100 via-violet-100/60 to-transparent blur-3xl" />
        <div className="relative mx-auto max-w-6xl px-4 pb-24 pt-16 text-center sm:px-6 sm:pt-24">
          <span className="inline-flex items-center gap-2 rounded-full border border-indigo-100 bg-white px-3.5 py-1.5 text-xs font-semibold text-indigo-700 shadow-sm">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            AI receptionist for local service businesses
          </span>
          <h1 className="mx-auto mt-6 max-w-4xl text-4xl font-extrabold leading-[1.1] tracking-tight text-slate-900 sm:text-6xl">
            Turn More Leads Into Customers—<span className="text-indigo-600">Automatically.</span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-slate-600">
            AI-powered lead response, qualification, appointment booking, and follow-up for local businesses.
          </p>
          <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              to="/signup"
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-8 py-3.5 text-base font-semibold text-white shadow-lg shadow-indigo-200 transition-colors hover:bg-indigo-500 sm:w-auto"
            >
              Start Free
            </Link>
            <Link
              to="/widget-demo"
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-8 py-3.5 text-base font-semibold text-slate-700 shadow-sm transition-colors hover:bg-slate-50 sm:w-auto"
            >
              <span className="relative flex h-2.5 w-2.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
              </span>
              Try the live demo
            </Link>
          </div>
          <p className="mt-5 text-sm text-slate-400">{TRUST_LINE}</p>
          <Link to="/widget-demo" className="group block" aria-label="Open the live AI receptionist demo">
            <HeroChatMock />
          </Link>
          <p className="mt-3 text-xs text-slate-400">
            ↑ This chat is real —{" "}
            <Link to="/widget-demo" className="font-semibold text-indigo-600 hover:text-indigo-500">
              talk to the live AI receptionist
            </Link>{" "}
            (no account needed)
          </p>
        </div>
      </section>

      {/* ------------------------------ Problem ------------------------------ */}
      <section id="problem" className="border-t border-slate-100 bg-slate-50 py-20 sm:py-24">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <SectionHeading
            eyebrow="The problem"
            title="Every minute you don't answer, someone else does"
            body="Homeowners don't call one business — they call three. The first one to respond with a real answer usually wins the job."
          />
          <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {PROBLEMS.map((p) => (
              <div key={p.title} className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-100 text-slate-600">{p.icon}</span>
                <h3 className="mt-4 text-base font-semibold text-slate-900">{p.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-slate-500">{p.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------ Solution ----------------------------- */}
      <section id="solution" className="py-20 sm:py-24">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="grid items-center gap-12 lg:grid-cols-2">
            <div>
              <SectionHeading
                center={false}
                eyebrow="The solution"
                title="An always-on AI receptionist that sells while you work"
                body="LeadFlow AI puts a trained receptionist on every lead — one that never sleeps, never puts people on hold, and never forgets to follow up."
              />
              <ul className="mt-8 space-y-4">
                {[
                  "Responds to every lead in seconds, from your business's own knowledge base",
                  "Qualifies and scores leads HOT, WARM, or COLD with an estimated value",
                  "Books appointments from your real availability — it never invents a time",
                  "Follows up automatically until prospects book, opt out, or you stop it",
                  "Escalates angry, sensitive, or unusual conversations to you — instantly",
                ].map((item) => (
                  <li key={item} className="flex items-start gap-3">
                    <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
                      <Check className="h-3.5 w-3.5" />
                    </span>
                    <span className="text-sm leading-relaxed text-slate-700 sm:text-base">{item}</span>
                  </li>
                ))}
              </ul>
            </div>
            {/* Flow card */}
            <div className="rounded-2xl border border-slate-200 bg-gradient-to-b from-slate-50 to-white p-7 shadow-sm sm:p-9">
              <p className="text-xs font-bold uppercase tracking-widest text-indigo-600">The core loop</p>
              <div className="mt-5 flex flex-wrap items-center gap-2">
                {LOOP.map((step, i) => (
                  <span key={step} className="flex items-center gap-2">
                    <span className="rounded-lg border border-indigo-100 bg-white px-3 py-1.5 text-sm font-semibold text-slate-800 shadow-sm">
                      {step}
                    </span>
                    {i < LOOP.length - 1 ? <span className="text-indigo-300">→</span> : null}
                  </span>
                ))}
              </div>
              <p className="mt-6 text-sm leading-relaxed text-slate-500">
                Every lead flows through the same loop your best receptionist runs today — except it happens in seconds,
                on every channel, at every hour, for every lead.
              </p>
              <div className="mt-6 rounded-xl bg-white p-5 ring-1 ring-slate-200">
                <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Funnel this week</p>
                  <span className="text-xs font-semibold text-emerald-600">+12 leads</span>
                </div>
                {[
                  { label: "Leads", v: 40, w: "100%", c: "bg-indigo-500" },
                  { label: "Qualified", v: 26, w: "65%", c: "bg-emerald-500" },
                  { label: "Appointments", v: 19, w: "48%", c: "bg-violet-500" },
                  { label: "Customers", v: 9, w: "23%", c: "bg-amber-500" },
                ].map((row) => (
                  <div key={row.label} className="mt-3">
                    <div className="mb-1 flex items-center justify-between text-xs">
                      <span className="font-medium text-slate-600">{row.label}</span>
                      <span className="font-semibold text-slate-900">{row.v}</span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                      <div className={`h-full rounded-full ${row.c}`} style={{ width: row.w }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ---------------------------- How it works ---------------------------- */}
      <section id="how" className="border-t border-slate-100 bg-slate-50 py-20 sm:py-24">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <SectionHeading
            eyebrow="How it works"
            title="Live in minutes, not weeks"
            body="No IT project, no integrations to wrestle with. Point it at your business, and it starts working."
          />
          <div className="mt-12 grid gap-6 md:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((s) => (
              <div key={s.n} className="relative rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                <span className="text-4xl font-extrabold tracking-tight text-indigo-100">{s.n}</span>
                <h3 className="mt-2 text-base font-semibold text-slate-900">{s.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-slate-500">{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------ AI agents ----------------------------- */}
      <section id="agents" className="py-20 sm:py-24">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <SectionHeading
            eyebrow="AI agents"
            title="Six agents, one team — working your leads 24/7"
            body="Each agent handles one part of the job, and they hand off to each other automatically. When something needs a human, you're in the loop."
          />
          <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {AGENTS.map((a) => (
              <div key={a.name} className="group rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-shadow hover:shadow-md">
                <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-600 text-white shadow-sm shadow-indigo-200">
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                    {AGENT_ICONS[a.name]}
                  </svg>
                </span>
                <h3 className="mt-4 text-base font-semibold text-slate-900">{a.name}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-slate-500">{a.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---------------------------- Dashboard demo --------------------------- */}
      <section id="demo" className="scroll-mt-20 border-t border-slate-100 bg-slate-50 py-20 sm:py-24">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <SectionHeading
            eyebrow="Dashboard demo"
            title="See your business at a glance"
            body="Every lead, score, appointment, and dollar in one place — the same dashboard you'll get in the app, with sample data shown."
          />
          <div className="mt-12">
            <DashboardMock />
          </div>
          <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              to="/widget-demo"
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-7 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-200 transition-colors hover:bg-indigo-500"
            >
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-300 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
              </span>
              Try the live demo — chat with the AI receptionist
            </Link>
            <Link
              to="/login?demo=1"
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-7 py-3 text-sm font-semibold text-slate-700 shadow-sm transition-colors hover:bg-slate-50"
            >
              Sign in to the demo account
              <span className="hidden text-xs font-normal text-slate-400 md:inline">demo@leadflow.ai / demo1234</span>
            </Link>
          </div>
          <p className="mt-3 text-xs text-slate-400">No account needed to chat — sign in to explore the full owner dashboard with sample data.</p>
        </div>
      </section>

      {/* ------------------------------- Benefits ------------------------------ */}
      <section id="benefits" className="py-20 sm:py-24">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <SectionHeading
            eyebrow="Benefits"
            title="What changes when every lead is handled"
            body="The jobs that used to slip through the cracks start landing on your calendar."
          />
          <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {BENEFITS.map((b, i) => (
              <div key={b.title} className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
                  <Check />
                </span>
                <h3 className="mt-4 text-base font-semibold text-slate-900">{b.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-slate-500">{b.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* -------------------------------- Pricing ------------------------------ */}
      <section id="pricing" className="scroll-mt-20 border-t border-slate-100 bg-slate-50 py-20 sm:py-24">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <SectionHeading
            eyebrow="Pricing"
            title="Simple, predictable pricing"
            body={SETUP_FEE_NOTE}
          />
          <div className="mt-12 grid gap-6 lg:grid-cols-3">
            {PLANS.map((p) => (
              <div
                key={p.name}
                className={`flex flex-col rounded-2xl border bg-white p-7 shadow-sm ${
                  p.highlight ? "border-indigo-500 ring-2 ring-indigo-200" : "border-slate-200"
                }`}
              >
                {p.highlight ? (
                  <span className="mb-3 inline-flex w-fit rounded-full bg-indigo-600 px-2.5 py-0.5 text-xs font-semibold text-white">
                    Most popular
                  </span>
                ) : null}
                <h3 className="text-lg font-semibold text-slate-900">{p.name}</h3>
                <p className="mt-1 text-sm text-slate-500">{p.blurb}</p>
                <p className="mt-4 flex items-baseline gap-1">
                  <span className="text-4xl font-extrabold tracking-tight text-slate-900">{p.price}</span>
                  <span className="text-base font-medium text-slate-400">per month</span>
                </p>
                <ul className="mt-6 flex-1 space-y-2.5">
                  {p.features.map((f) => (
                    <li key={f} className={`flex items-start gap-2 text-sm ${f.endsWith(":") ? "font-semibold text-slate-700" : "text-slate-600"}`}>
                      {f.endsWith(":") ? null : (
                        <svg className="mt-0.5 h-4 w-4 shrink-0 text-indigo-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                        </svg>
                      )}
                      {f}
                    </li>
                  ))}
                </ul>
                <Link
                  to="/signup"
                  className={`mt-7 inline-flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold shadow-sm transition-colors ${
                    p.highlight
                      ? "bg-indigo-600 text-white shadow-indigo-200 hover:bg-indigo-500"
                      : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  Start Free
                </Link>
              </div>
            ))}
          </div>
          <p className="mt-6 text-center text-xs text-slate-400">
            All plans include the one-time setup and a free trial first. See full details on the <Link to="/pricing" className="font-semibold text-indigo-600 hover:text-indigo-500">pricing page</Link>.
          </p>
        </div>
      </section>

      {/* --------------------------------- FAQ --------------------------------- */}
      <section id="faq" className="scroll-mt-20 py-20 sm:py-24">
        <div className="mx-auto max-w-3xl px-4 sm:px-6">
          <SectionHeading eyebrow="FAQ" title="Questions, answered honestly" />
          <div className="mt-10 space-y-3">
            {FAQS.map((f) => (
              <FaqItem key={f.q} q={f.q} a={f.a} />
            ))}
          </div>
          <p className="mt-8 text-center text-sm text-slate-500">
            Something else on your mind? <Link to="/contact" className="font-semibold text-indigo-600 hover:text-indigo-500">Get in touch</Link> — a human will reply.
          </p>
        </div>
      </section>

      {/* ------------------------------- Final CTA ----------------------------- */}
      <section className="relative overflow-hidden bg-slate-900 py-20 sm:py-24">
        <div className="pointer-events-none absolute -top-32 left-1/2 h-72 w-[48rem] -translate-x-1/2 rounded-full bg-indigo-600/30 blur-3xl" />
        <div className="relative mx-auto max-w-4xl px-4 text-center sm:px-6">
          <h2 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">Your next customer just sent a message.</h2>
          <p className="mx-auto mt-4 max-w-xl text-base leading-relaxed text-slate-300">
            Don't let them wait until morning — or click away to a competitor. Start free and see what an always-on AI
            receptionist can do for your business.
          </p>
          <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              to="/signup"
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-white px-8 py-3.5 text-base font-semibold text-slate-900 shadow-lg transition-colors hover:bg-slate-100 sm:w-auto"
            >
              Start Free
            </Link>
            <Link
              to="/contact"
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-slate-600 px-8 py-3.5 text-base font-semibold text-slate-200 transition-colors hover:border-slate-400 hover:text-white sm:w-auto"
            >
              Talk to us
            </Link>
          </div>
          <p className="mt-5 text-sm text-slate-400">{TRUST_LINE}</p>
        </div>
      </section>

      <PublicFooter />
    </div>
  );
}
