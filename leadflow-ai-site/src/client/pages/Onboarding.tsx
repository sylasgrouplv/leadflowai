/** Guided onboarding — 5 steps: info, services, service area, hours, knowledge base. */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, type Business, type KnowledgeEntry, type Service } from "../api";
import { useAuth } from "../App";
import { Button, Card, Field, Input, Select, Textarea, cx } from "../components/ui";

const CATEGORIES: Array<[string, string]> = [
  ["hvac", "HVAC & Heating"],
  ["plumbing", "Plumbing"],
  ["roofing", "Roofing"],
  ["landscaping", "Landscaping"],
  ["cleaning", "Cleaning"],
  ["auto_repair", "Auto Repair"],
  ["restoration", "Restoration"],
  ["home_services", "Home Services"],
  ["other", "Other"],
];

const STEPS = ["Business info", "Services", "Service area", "Business hours", "Knowledge base"];
const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
const DAY_LABELS: Record<(typeof DAYS)[number], string> = {
  monday: "Monday",
  tuesday: "Tuesday",
  wednesday: "Wednesday",
  thursday: "Thursday",
  friday: "Friday",
  saturday: "Saturday",
  sunday: "Sunday",
};

interface DayRow {
  open: string;
  close: string;
  closed: boolean;
}

const defaultWeek = (): Record<(typeof DAYS)[number], DayRow> => ({
  monday: { open: "09:00", close: "17:00", closed: false },
  tuesday: { open: "09:00", close: "17:00", closed: false },
  wednesday: { open: "09:00", close: "17:00", closed: false },
  thursday: { open: "09:00", close: "17:00", closed: false },
  friday: { open: "09:00", close: "17:00", closed: false },
  saturday: { open: "00:00", close: "00:00", closed: true },
  sunday: { open: "00:00", close: "00:00", closed: true },
});

interface ServiceRow {
  name: string;
  price: string; // dollars
  durationMin: number;
  description: string;
}

interface FaqRow {
  question: string;
  answer: string;
}

export function Onboarding() {
  const { business, refresh } = useAuth();
  const navigate = useNavigate();
  const [step, setStep] = useState(business?.onboardingStep ?? 1);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Step 1
  const [info, setInfo] = useState({
    name: business?.name ?? "",
    category: business?.category ?? "home_services",
    phone: business?.phone ?? "",
    email: business?.email ?? "",
    website: business?.website ?? "",
    description: business?.description ?? "",
  });

  // Step 2
  const [services, setServices] = useState<ServiceRow[]>([]);
  // Step 3
  const [zipCodes, setZipCodes] = useState((business?.serviceArea.zipCodes ?? []).join(", "));
  const [cities, setCities] = useState((business?.serviceArea.cities ?? []).join(", "));
  // Step 4
  const [week, setWeek] = useState<Record<(typeof DAYS)[number], DayRow>>(() => {
    const b = business?.hours as Partial<Record<(typeof DAYS)[number], DayRow>> | undefined;
    if (b && b.monday) {
      return { ...defaultWeek(), ...b };
    }
    return defaultWeek();
  });
  // Step 5
  const [policies, setPolicies] = useState({
    welcomeMessage: business?.policies.welcomeMessage ?? "",
    cancellationPolicy: business?.policies.cancellationPolicy ?? "",
    financing: business?.policies.financing ?? "",
    promotions: business?.policies.promotions ?? "",
  });
  const [faqs, setFaqs] = useState<FaqRow[]>([{ question: "", answer: "" }]);

  useEffect(() => {
    if (!business) return;
    api<{ services: Service[] }>("/api/services").then((r) => {
      if (r.services.length) {
        setServices(r.services.map((s) => ({ name: s.name, price: s.priceCents > 0 ? String(s.priceCents / 100) : "", durationMin: s.durationMin, description: s.description })));
      }
    });
    api<{ entries: KnowledgeEntry[] }>("/api/knowledge").then((r) => {
      const q = r.entries.filter((e) => e.kind === "faq");
      if (q.length) setFaqs(q.map((e) => ({ question: e.question, answer: e.answer })));
    });
  }, [business]);

  const canContinue = useMemo(() => {
    if (step === 1) return info.name.trim().length >= 2;
    if (step === 2) return services.some((s) => s.name.trim());
    if (step === 3) return zipCodes.trim().length > 0 || cities.trim().length > 0;
    if (step === 4) return true;
    if (step === 5) return true;
    return true;
  }, [step, info, services, zipCodes, cities]);

  const saveStep = async (): Promise<number | null> => {
    setError(null);
    if (step === 1) {
      if (!business) {
        const r = await api<{ business: Business }>("/api/business", { method: "POST", body: JSON.stringify(info) });
        return r.business.onboardingStep;
      }
      const r = await api<{ business: Business }>("/api/business", { method: "PATCH", body: JSON.stringify(info) });
      return r.business.onboardingStep;
    }
    if (step === 2) {
      const r = await api<{ services: Service[] }>("/api/services/bulk", {
        method: "PUT",
        body: JSON.stringify({
          services: services
            .filter((s) => s.name.trim())
            .map((s) => ({
              name: s.name.trim(),
              description: s.description.trim(),
              priceCents: Math.round((parseFloat(s.price) || 0) * 100),
              durationMin: s.durationMin || 60,
            })),
        }),
      });
      return (await api<{ business: Business }>("/api/business")).business.onboardingStep;
    }
    if (step === 3) {
      const r = await api<{ business: Business }>("/api/business/service-area", {
        method: "PUT",
        body: JSON.stringify({
          zipCodes: zipCodes.split(",").map((z) => z.trim()).filter(Boolean),
          cities: cities.split(",").map((c) => c.trim()).filter(Boolean),
        }),
      });
      return r.business.onboardingStep;
    }
    if (step === 4) {
      const r = await api<{ business: Business }>("/api/business/hours", {
        method: "PUT",
        body: JSON.stringify(week),
      });
      return r.business.onboardingStep;
    }
    if (step === 5) {
      await api("/api/business/policies", { method: "PUT", body: JSON.stringify(policies) });
      await api("/api/knowledge/bulk", {
        method: "PUT",
        body: JSON.stringify({
          entries: [
            ...faqs.filter((f) => f.question.trim() && f.answer.trim()).map((f) => ({ kind: "faq", question: f.question.trim(), answer: f.answer.trim() })),
            { kind: "policy", question: "", answer: policies.cancellationPolicy.trim() },
            { kind: "general", question: "", answer: policies.financing.trim() },
          ].filter((e) => e.answer),
        }),
      });
      const r = await api<{ business: Business }>("/api/business/complete-onboarding", { method: "POST" });
      return r.business.onboardingStep;
    }
    return null;
  };

  const next = async () => {
    setSaving(true);
    try {
      const nextStep = (await saveStep()) ?? step + 1;
      await refresh();
      if (nextStep >= 6) {
        navigate("/app/dashboard", { state: { justOnboarded: true } });
      } else {
        setStep(Math.max(nextStep, step + 1));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong — try again.");
    } finally {
      setSaving(false);
    }
  };

  const setDay = (day: (typeof DAYS)[number], patch: Partial<DayRow>) => {
    setWeek((w) => ({ ...w, [day]: { ...w[day], ...patch } }));
  };

  const setService = (i: number, patch: Partial<ServiceRow>) => {
    setServices((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  };

  const setFaq = (i: number, patch: Partial<FaqRow>) => {
    setFaqs((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  };

  return (
    <div className="mx-auto max-w-3xl">
      {/* Progress */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">Set up your business</h1>
        <p className="mt-1 text-sm text-slate-500">Five quick steps and your AI receptionist will be ready to take leads.</p>
        <div className="mt-5 flex items-center gap-1.5">
          {STEPS.map((label, i) => {
            const n = i + 1;
            const done = n < step;
            const active = n === step;
            return (
              <div key={label} className="flex flex-1 flex-col gap-1.5">
                <div className={cx("h-1.5 rounded-full transition-colors", done ? "bg-indigo-500" : active ? "bg-indigo-300" : "bg-slate-200")} />
                <span className={cx("text-[11px] font-medium", active ? "text-indigo-700" : done ? "text-indigo-500" : "text-slate-400")}>{label}</span>
              </div>
            );
          })}
        </div>
      </div>

      <Card className="p-6 sm:p-8">
        {step === 1 && (
          <div className="space-y-4">
            <StepTitle n={1} title="Tell us about your business" />
            <Field label="Business name">
              <Input required value={info.name} onChange={(e) => setInfo({ ...info, name: e.target.value })} placeholder="Smith's HVAC" />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Industry">
                <Select value={info.category} onChange={(e) => setInfo({ ...info, category: e.target.value })}>
                  {CATEGORIES.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Phone">
                <Input value={info.phone} onChange={(e) => setInfo({ ...info, phone: e.target.value })} placeholder="(555) 123-4567" />
              </Field>
              <Field label="Email">
                <Input type="email" value={info.email} onChange={(e) => setInfo({ ...info, email: e.target.value })} placeholder="hello@business.com" />
              </Field>
              <Field label="Website">
                <Input value={info.website} onChange={(e) => setInfo({ ...info, website: e.target.value })} placeholder="https://business.com" />
              </Field>
            </div>
            <Field label="Description" hint="The AI uses this to answer questions about who you are.">
              <Textarea value={info.description} onChange={(e) => setInfo({ ...info, description: e.target.value })} placeholder="Family-owned HVAC company serving the area since 2004…" />
            </Field>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <StepTitle n={2} title="What do you sell?" />
            <p className="-mt-2 text-sm text-slate-500">Add the services your AI receptionist will talk about. Leave price blank for “call for a quote”.</p>
            {services.map((sv, i) => (
              <div key={i} className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
                <div className="grid gap-3 sm:grid-cols-12">
                  <div className="sm:col-span-5">
                    <Field label="Service name">
                      <Input value={sv.name} onChange={(e) => setService(i, { name: e.target.value })} placeholder="AC Tune-Up" />
                    </Field>
                  </div>
                  <div className="sm:col-span-3">
                    <Field label="Price ($)">
                      <Input type="number" min={0} step="0.01" value={sv.price} onChange={(e) => setService(i, { price: e.target.value })} placeholder="129" />
                    </Field>
                  </div>
                  <div className="sm:col-span-4">
                    <Field label="Duration (min)">
                      <Input type="number" min={5} step={5} value={sv.durationMin || ""} onChange={(e) => setService(i, { durationMin: parseInt(e.target.value) || 60 })} placeholder="60" />
                    </Field>
                  </div>
                </div>
                <div className="mt-3">
                  <Field label="Description">
                    <Input value={sv.description} onChange={(e) => setService(i, { description: e.target.value })} placeholder="Seasonal maintenance for central air systems" />
                  </Field>
                </div>
                {services.length > 1 ? (
                  <button type="button" onClick={() => setServices((rows) => rows.filter((_, idx) => idx !== i))} className="mt-2 text-xs font-medium text-red-500 hover:text-red-600">
                    Remove service
                  </button>
                ) : null}
              </div>
            ))}
            <Button variant="secondary" onClick={() => setServices((rows) => [...rows, { name: "", price: "", durationMin: 60, description: "" }])}>
              + Add service
            </Button>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4">
            <StepTitle n={3} title="Where do you work?" />
            <Field label="ZIP codes" hint="Comma-separated. The AI uses this to confirm you serve a lead's area.">
              <Input value={zipCodes} onChange={(e) => setZipCodes(e.target.value)} placeholder="62701, 62702, 62703" />
            </Field>
            <Field label="Cities / towns" hint="Comma-separated.">
              <Input value={cities} onChange={(e) => setCities(e.target.value)} placeholder="Springfield, Chatham" />
            </Field>
          </div>
        )}

        {step === 4 && (
          <div className="space-y-4">
            <StepTitle n={4} title="When are you open?" />
            <p className="-mt-2 text-sm text-slate-500">Availability is never invented — the AI only books inside these hours.</p>
            <div className="space-y-2">
              {DAYS.map((day) => {
                const d = week[day];
                return (
                  <div key={day} className={cx("flex items-center gap-3 rounded-xl border border-slate-200 p-3", d.closed && "bg-slate-50")}>
                    <label className="flex w-28 items-center gap-2 text-sm font-medium text-slate-700">
                      <input type="checkbox" checked={!d.closed} onChange={(e) => setDay(day, { closed: !e.target.checked })} className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />
                      {DAY_LABELS[day]}
                    </label>
                    <div className={cx("flex items-center gap-2", d.closed && "opacity-40")}>
                      <Input type="time" value={d.open} disabled={d.closed} onChange={(e) => setDay(day, { open: e.target.value })} className="w-32" />
                      <span className="text-slate-400">to</span>
                      <Input type="time" value={d.close} disabled={d.closed} onChange={(e) => setDay(day, { close: e.target.value })} className="w-32" />
                    </div>
                    {d.closed ? <span className="text-xs text-slate-400">Closed</span> : null}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {step === 5 && (
          <div className="space-y-5">
            <StepTitle n={5} title="Teach your AI receptionist" />
            <Field label="Welcome message" hint="The first thing the AI says to a new chat.">
              <Textarea value={policies.welcomeMessage} onChange={(e) => setPolicies({ ...policies, welcomeMessage: e.target.value })} placeholder="Hi! Thanks for reaching out — how can we help?" />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Cancellation policy">
                <Textarea value={policies.cancellationPolicy} onChange={(e) => setPolicies({ ...policies, cancellationPolicy: e.target.value })} placeholder="24 hours' notice to reschedule…" />
              </Field>
              <Field label="Financing options" hint="Only answered if you configure it — the AI never invents financing.">
                <Textarea value={policies.financing} onChange={(e) => setPolicies({ ...policies, financing: e.target.value })} placeholder="0% financing for 12 months on qualifying jobs…" />
              </Field>
            </div>
            <Field label="Promotions">
              <Input value={policies.promotions} onChange={(e) => setPolicies({ ...policies, promotions: e.target.value })} placeholder="New customer special: $89 tune-up" />
            </Field>
            <div>
              <p className="mb-2 text-sm font-medium text-slate-700">Frequently asked questions</p>
              {faqs.map((f, i) => (
                <div key={i} className="mb-3 rounded-xl border border-slate-200 bg-slate-50/60 p-4">
                  <div className="grid gap-3">
                    <Field label="Question">
                      <Input value={f.question} onChange={(e) => setFaq(i, { question: e.target.value })} placeholder="How much does a tune-up cost?" />
                    </Field>
                    <Field label="Answer">
                      <Textarea value={f.answer} onChange={(e) => setFaq(i, { answer: e.target.value })} placeholder="Our tune-up is $129…" />
                    </Field>
                  </div>
                  {faqs.length > 1 ? (
                    <button type="button" onClick={() => setFaqs((rows) => rows.filter((_, idx) => idx !== i))} className="mt-2 text-xs font-medium text-red-500 hover:text-red-600">
                      Remove
                    </button>
                  ) : null}
                </div>
              ))}
              <Button variant="secondary" onClick={() => setFaqs((rows) => [...rows, { question: "", answer: "" }])}>
                + Add question
              </Button>
            </div>
          </div>
        )}

        {error ? <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p> : null}

        <div className="mt-8 flex items-center justify-between border-t border-slate-100 pt-5">
          <Button variant="ghost" onClick={() => setStep((s) => Math.max(1, s - 1))} disabled={step === 1}>
            ← Back
          </Button>
          <Button onClick={next} disabled={saving || !canContinue}>
            {saving ? "Saving…" : step === 5 ? "Finish setup" : "Continue →"}
          </Button>
        </div>
      </Card>
    </div>
  );
}

function StepTitle({ n, title }: { n: number; title: string }) {
  return (
    <h2 className="flex items-center gap-2.5 text-lg font-bold text-slate-900">
      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-indigo-600 text-sm font-bold text-white">{n}</span>
      {title}
    </h2>
  );
}
