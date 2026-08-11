/** Public marketing pages: Pricing, Features, Contact, Terms, Privacy. */
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { AGENTS, PLANS, SETUP_FEE_NOTE } from "../content";
import { Check, PageShell, SectionHeading, usePageTitle } from "../components/Public";

/* -------------------------------- Pricing ---------------------------------- */

export function PricingPage() {
  usePageTitle("Pricing — LeadFlow AI");

  const monthlyNote =
    "All plans are billed monthly. Every plan starts with a free trial and a one-time setup fee of $1,500–$3,000 based on your business's needs.";

  return (
    <PageShell>
      <section className="relative overflow-hidden pb-20 pt-16 sm:pt-20">
        <div className="pointer-events-none absolute -top-40 left-1/2 h-96 w-[50rem] -translate-x-1/2 rounded-full bg-gradient-to-b from-indigo-100 to-transparent blur-3xl" />
        <div className="relative mx-auto max-w-6xl px-4 sm:px-6">
          <SectionHeading
            eyebrow="Pricing"
            title="Simple, predictable pricing"
            body={monthlyNote}
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

          <div className="mt-14 grid gap-4 sm:grid-cols-3">
            {[
              { t: "Free trial first", d: "Every account starts free — no credit card required. Try the full product and the Smith's HVAC demo before paying." },
              { t: "One-time setup", d: SETUP_FEE_NOTE.split("Then a flat monthly subscription")[0] },
              { t: "Cancel anytime", d: "Monthly billing with no long-term contract. Stop whenever you like." },
            ].map((x) => (
              <div key={x.t} className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
                <p className="text-sm font-semibold text-slate-900">{x.t}</p>
                <p className="mt-1.5 text-sm leading-relaxed text-slate-500">{x.d}</p>
              </div>
            ))}
          </div>

          <div className="mt-16 rounded-2xl bg-slate-900 p-8 text-center sm:p-10">
            <h3 className="text-2xl font-bold tracking-tight text-white">Not sure which plan fits?</h3>
            <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-slate-300">
              Try the free trial first — every plan includes the same setup experience. You can upgrade or change plans
              whenever your business grows.
            </p>
            <div className="mt-7 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link
                to="/signup"
                className="inline-flex w-full items-center justify-center rounded-xl bg-white px-7 py-3 text-sm font-semibold text-slate-900 shadow-lg transition-colors hover:bg-slate-100 sm:w-auto"
              >
                Start Free
              </Link>
              <Link
                to="/contact"
                className="inline-flex w-full items-center justify-center rounded-xl border border-slate-600 px-7 py-3 text-sm font-semibold text-slate-200 transition-colors hover:border-slate-400 hover:text-white sm:w-auto"
              >
                Talk to us
              </Link>
            </div>
          </div>
        </div>
      </section>
    </PageShell>
  );
}

/* -------------------------------- Features --------------------------------- */

const FEATURE_GROUPS = [
  {
    title: "AI Agents",
    body: "Six agents work your leads end to end — respond, qualify, book, follow up, review, and report — handing off to humans whenever a situation needs one.",
    items: AGENTS.map((a) => `${a.name} — ${a.desc}`),
  },
  {
    title: "Lead management",
    body: "Every lead gets a profile with contact details, service requested, location, urgency, score, and estimated value — kept in perfect order automatically.",
    items: [
      "Statuses: New, Contacted, Qualified, Appointment Booked, Customer, Lost, Unqualified, Needs Human Attention",
      "HOT / WARM / COLD scoring shown prominently on every lead",
      "Conversation history, notes, and team assignment on each lead",
    ],
  },
  {
    title: "Conversations & human takeover",
    body: "A full inbox of every AI conversation, with manual takeover any time. The AI stops auto-responding until you hand it back.",
    items: [
      "Every conversation logged with timestamps and lead details",
      "One click to take over — or hand back to the AI",
      "Unusual or sensitive situations auto-escalated to your queue",
    ],
  },
  {
    title: "Appointment booking",
    body: "The AI checks real availability and books appointments onto your calendar — it never invents a time that doesn't exist.",
    items: [
      "Offer available slots and confirm bookings automatically",
      "Confirmations sent to the customer automatically",
      "Lead status updates to Appointment Booked the moment it's scheduled",
    ],
  },
  {
    title: "Follow-up automation",
    body: "Prospects who aren't ready to book yet stay warm with automatic follow-ups on a 1, 3, 7, and 14-day sequence.",
    items: [
      "Default sequence you can customize per business",
      "Stops automatically when a lead books, converts, opts out, or you stop it",
      "Opt-out handling and consent respected",
    ],
  },
  {
    title: "Dashboard & analytics",
    body: "A live funnel from Leads to Customers, pipeline revenue, and lead sources — so you know exactly what's working.",
    items: [
      "Cards for Leads, Qualified, Appointments, Conversion %, and Est. Revenue",
      "Funnel: Leads → Qualified → Appointments → Customers",
      "Weekly Business Intelligence report for owners",
    ],
  },
];

export function FeaturesPage() {
  usePageTitle("Features — LeadFlow AI");

  return (
    <PageShell>
      <section className="relative overflow-hidden pb-20 pt-16 sm:pt-20">
        <div className="pointer-events-none absolute -top-40 left-1/2 h-96 w-[50rem] -translate-x-1/2 rounded-full bg-gradient-to-b from-indigo-100 to-transparent blur-3xl" />
        <div className="relative mx-auto max-w-6xl px-4 sm:px-6">
          <SectionHeading
            eyebrow="Features"
            title="Everything your best receptionist does — automated"
            body="LeadFlow AI handles the entire lead lifecycle, so your team can focus on the work that's actually on the invoice."
          />

          <div className="mt-14 space-y-8">
            {FEATURE_GROUPS.map((g) => (
              <div key={g.title} className="rounded-2xl border border-slate-200 bg-white p-7 shadow-sm sm:p-9">
                <h3 className="text-xl font-bold tracking-tight text-slate-900">{g.title}</h3>
                <p className="mt-2 max-w-3xl text-sm leading-relaxed text-slate-600">{g.body}</p>
                <ul className="mt-5 grid gap-x-8 gap-y-2.5 sm:grid-cols-2">
                  {g.items.map((item) => (
                    <li key={item} className="flex items-start gap-2.5 text-sm text-slate-600">
                      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
                        <Check className="h-3 w-3" />
                      </span>
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <div className="mt-10 rounded-2xl border border-indigo-100 bg-indigo-50/60 p-8 text-center">
            <h3 className="text-xl font-bold tracking-tight text-slate-900">See it working before you set anything up</h3>
            <p className="mx-auto mt-2 max-w-xl text-sm leading-relaxed text-slate-600">
              Every account includes the Smith's HVAC demo business — a fully working example with sample services,
              leads, and AI conversations. Explore it free, no credit card.
            </p>
            <Link
              to="/signup"
              className="mt-6 inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-7 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-200 transition-colors hover:bg-indigo-500"
            >
              Start Free — try the demo
            </Link>
          </div>
        </div>
      </section>
    </PageShell>
  );
}

/* --------------------------------- Contact --------------------------------- */

const CONTACT_EMAIL = "hello@leadflow.ai";

export function ContactPage() {
  usePageTitle("Contact — LeadFlow AI");

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [businessType, setBusinessType] = useState("");
  const [message, setMessage] = useState("");

  // Honest contact: compose an email in the visitor's mail client rather than
  // faking a "sent" state. Nothing is transmitted through this site.
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const subject = encodeURIComponent(`LeadFlow AI inquiry${businessType ? ` — ${businessType}` : ""}`);
    const body = encodeURIComponent(`Hi LeadFlow AI,\n\n${message}\n\n— ${name}${email ? ` (${email})` : ""}`);
    window.location.href = `mailto:${CONTACT_EMAIL}?subject=${subject}&body=${body}`;
  };

  const inputCls =
    "block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200";

  return (
    <PageShell>
      <section className="py-16 sm:py-20">
        <div className="mx-auto max-w-3xl px-4 sm:px-6">
          <SectionHeading
            eyebrow="Contact"
            title="Talk to a human"
            body="Questions about LeadFlow AI, pricing, or whether it fits your business? We'd love to hear from you."
          />

          <form onSubmit={submit} className="mt-12 rounded-2xl border border-slate-200 bg-white p-7 shadow-sm sm:p-9">
            <div className="grid gap-5 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-slate-700">Your name</span>
                <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Smith" className={inputCls} />
              </label>
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-slate-700">Email</span>
                <input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="jane@yourbusiness.com" className={inputCls} />
              </label>
            </div>
            <label className="mt-5 block">
              <span className="mb-1 block text-sm font-medium text-slate-700">Business type</span>
              <select value={businessType} onChange={(e) => setBusinessType(e.target.value)} className={inputCls}>
                <option value="">Select your industry…</option>
                <option>HVAC</option>
                <option>Plumbing</option>
                <option>Roofing</option>
                <option>Landscaping</option>
                <option>Cleaning</option>
                <option>Auto repair</option>
                <option>Restoration</option>
                <option>Other home services</option>
              </select>
            </label>
            <label className="mt-5 block">
              <span className="mb-1 block text-sm font-medium text-slate-700">Message</span>
              <textarea
                required
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Tell us about your business and what you're looking for…"
                rows={5}
                className={inputCls}
              />
            </label>
            <div className="mt-6 flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
              <button
                type="submit"
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-7 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-200 transition-colors hover:bg-indigo-500 sm:w-auto"
              >
                Send via email
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
                </svg>
              </button>
              <p className="text-sm text-slate-500">
                Or email us directly:{" "}
                <a href={`mailto:${CONTACT_EMAIL}`} className="font-semibold text-indigo-600 hover:text-indigo-500">
                  {CONTACT_EMAIL}
                </a>
              </p>
            </div>
            <p className="mt-4 text-xs text-slate-400">
              Submitting opens your email app with the message pre-filled — nothing is sent through this site.
            </p>
          </form>

          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
              <p className="text-sm font-semibold text-slate-900">Prefer to try first?</p>
              <p className="mt-1 text-sm leading-relaxed text-slate-500">
                Create a free account and explore the Smith's HVAC demo — no credit card needed.
              </p>
              <Link to="/signup" className="mt-3 inline-block text-sm font-semibold text-indigo-600 hover:text-indigo-500">
                Start Free →
              </Link>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
              <p className="text-sm font-semibold text-slate-900">Already a customer?</p>
              <p className="mt-1 text-sm leading-relaxed text-slate-500">
                Log in to your dashboard — in-app support and resources are available there.
              </p>
              <Link to="/login" className="mt-3 inline-block text-sm font-semibold text-indigo-600 hover:text-indigo-500">
                Log in →
              </Link>
            </div>
          </div>
        </div>
      </section>
    </PageShell>
  );
}

/* ---------------------------------- Terms ---------------------------------- */

function LegalShell({ title, updated, children }: { title: string; updated: string; children: React.ReactNode }) {
  usePageTitle(`${title} — LeadFlow AI`);
  return (
    <PageShell>
      <section className="py-16 sm:py-20">
        <div className="mx-auto max-w-3xl px-4 sm:px-6">
          <p className="text-xs font-bold uppercase tracking-widest text-indigo-600">Legal</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-900">{title}</h1>
          <p className="mt-2 text-sm text-slate-400">Last updated: {updated}</p>
          <div className="prose-sm mt-8 space-y-5 text-sm leading-relaxed text-slate-600 sm:text-base">{children}</div>
        </div>
      </section>
    </PageShell>
  );
}

function LegalH({ children }: { children: React.ReactNode }) {
  return <h2 className="pt-2 text-lg font-bold tracking-tight text-slate-900">{children}</h2>;
}

export function TermsPage() {
  return (
    <LegalShell title="Terms of Service" updated="August 11, 2026">
      <p>
        These Terms of Service ("Terms") govern your access to and use of the LeadFlow AI platform, website, and
        services (collectively, the "Service"), operated by LeadFlow AI ("we", "us", or "our"). By creating an account
        or using the Service, you agree to these Terms.
      </p>
      <LegalH>1. Your account</LegalH>
      <p>
        You must provide accurate information when creating an account and keep it up to date. You are responsible for
        safeguarding your credentials and for all activity under your account. You must be at least 18 years old and
        authorized to enter into these Terms on behalf of your business.
      </p>
      <LegalH>2. Subscriptions and billing</LegalH>
      <p>
        The Service is offered on a monthly subscription basis (Starter, Professional, or Premium) plus a one-time setup
        fee. Fees are quoted in U.S. dollars and billed in advance for each month. If a free trial is offered, you will
        not be charged until the trial ends unless you cancel. You can cancel at any time; cancellation takes effect at
        the end of the current billing period. Fees are non-refundable except where required by law.
      </p>
      <LegalH>3. Acceptable use</LegalH>
      <p>
        You agree not to misuse the Service: no resale of the Service without written permission, no attempts to break
        or probe security, no interference with other customers' use, no use in violation of applicable law, and no
        use of the Service to send deceptive, fraudulent, or unsolicited bulk communications. You are responsible for
        obtaining any consents required to message or contact your own leads and customers.
      </p>
      <LegalH>4. AI-generated content</LegalH>
      <p>
        The Service uses AI to respond to leads based on the information you provide (services, hours, pricing, policies,
        and knowledge base). You are responsible for the accuracy of the information you configure and for reviewing
        automated interactions with your customers. We work to prevent fabrication — the AI answers only from the
        knowledge you provide and escalates uncertainty — but no automated system is perfect, and you remain responsible
        for your business's customer communications.
      </p>
      <LegalH>5. Your data</LegalH>
      <p>
        You retain ownership of the business information and customer data you provide. You grant us a limited license to
        process that data solely to operate the Service, as described in our Privacy Policy. We implement reasonable
        security measures and strict tenant isolation between accounts.
      </p>
      <LegalH>6. Intellectual property</LegalH>
      <p>
        The Service, including its software, design, and branding, is owned by LeadFlow AI and protected by intellectual
        property laws. We grant you a limited, non-exclusive, non-transferable right to use the Service during your
        subscription.
      </p>
      <LegalH>7. Disclaimers and liability</LegalH>
      <p>
        The Service is provided "as is" without warranties of any kind, express or implied. To the maximum extent
        permitted by law, our total liability arising out of or related to the Service shall not exceed the amounts you
        paid us in the three months preceding the claim. Nothing in these Terms limits liability that cannot be limited
        by law.
      </p>
      <LegalH>8. Termination</LegalH>
      <p>
        You may stop using the Service at any time. We may suspend or terminate access for violation of these Terms,
        with notice where practical. On termination, you may export your data during a reasonable wind-down period.
      </p>
      <LegalH>9. Changes to these Terms</LegalH>
      <p>
        We may update these Terms from time to time. We will post changes on this page and update the "last updated"
        date. Continued use of the Service after changes take effect constitutes acceptance.
      </p>
      <LegalH>10. Contact</LegalH>
      <p>
        Questions about these Terms? Email us at{" "}
        <a href="mailto:hello@leadflow.ai" className="font-semibold text-indigo-600">
          hello@leadflow.ai
        </a>
        .
      </p>
    </LegalShell>
  );
}

/* --------------------------------- Privacy --------------------------------- */

export function PrivacyPage() {
  return (
    <LegalShell title="Privacy Policy" updated="August 11, 2026">
      <p>
        This Privacy Policy explains what information LeadFlow AI collects, why we collect it, and how we handle it.
        "Personal data" means information that identifies an individual, such as a name, email address, phone number,
        or business details.
      </p>
      <LegalH>1. What we collect</LegalH>
      <p>
        <strong>Account information:</strong> name, email address, and password (stored securely, hashed) when you
        create an account. <strong>Business information:</strong> services, pricing, hours, service areas, policies, and
        knowledge base content you configure. <strong>Lead and customer data:</strong> information about leads and
        conversations handled through the Service, which belongs to you. <strong>Usage data:</strong> basic analytics
        about how the Service is used, such as pages visited and features used.
      </p>
      <LegalH>2. How we use information</LegalH>
      <p>
        We use your information to operate and improve the Service: respond to leads on your behalf, qualify and score
        them, book appointments, run follow-ups, generate reports, provide support, and keep the platform secure.
      </p>
      <LegalH>3. AI processing</LegalH>
      <p>
        Your business knowledge base and lead conversations are used to generate AI responses for your business only.
        We train our AI to answer only from the information you provide and to escalate uncertainty. We do not use your
        customers' conversations to train models for other customers.
      </p>
      <LegalH>4. What we don't do</LegalH>
      <p>
        We do not sell your personal data or your customers' data. We do not send marketing messages on your behalf
        without your consent. We only share data with service providers (such as hosting and payment processing) that
        need it to operate the Service, under contracts that require them to protect it.
      </p>
      <LegalH>5. Data retention and security</LegalH>
      <p>
        We keep your data for as long as your account is active, and delete or anonymize it after you close your
        account, subject to legal retention requirements. We use encryption in transit, hashed passwords, access
        controls, and tenant isolation so each business's data stays separate.
      </p>
      <LegalH>6. Cookies</LegalH>
      <p>
        We use essential cookies to keep you logged in and to keep the Service working. We may use basic analytics to
        understand how the Service is used; you can block these in your browser settings without breaking core
        functionality.
      </p>
      <LegalH>7. Your rights</LegalH>
      <p>
        Depending on where you are, you may have rights to access, correct, export, or delete your personal data, and
        to object to or restrict certain processing. To exercise any of these rights, email us at{" "}
        <a href="mailto:hello@leadflow.ai" className="font-semibold text-indigo-600">
          hello@leadflow.ai
        </a>{" "}
        and we'll respond within a reasonable time.
      </p>
      <LegalH>8. Changes to this policy</LegalH>
      <p>
        We may update this policy as the Service evolves. Changes will be posted on this page with an updated date.
        Material changes will be announced through the Service.
      </p>
      <LegalH>9. Contact</LegalH>
      <p>
        Questions about privacy? Email{" "}
        <a href="mailto:hello@leadflow.ai" className="font-semibold text-indigo-600">
          hello@leadflow.ai
        </a>
        .
      </p>
    </LegalShell>
  );
}
