/**
 * Seed — "LeadFlow AI" as a first-class tenant on its own platform (dogfooding,
 * Phase 0 / Chunk A). Mirrors db/seed.ts EXACTLY (same repo helpers, same
 * idempotency approach) so the company can run its internal automations on the
 * product it sells.
 *
 * Creates:
 *   - platform owner user for the tenant (owner@leadflowai.internal)
 *   - business "LeadFlow AI" (home-services SaaS; kept generic so the AI
 *     receptionist demo reads naturally) with service area, business hours,
 *     policies + welcome message
 *   - 3 services (AI Receptionist / Lead Qualification / Follow-Up Automation)
 *   - 4 knowledge-base entries (what it is, real pricing tiers + setup fee,
 *     how booking works)
 *   - widget settings + integration status rows for the six mock providers
 *     (AI / SMS / email / calendar / CRM / Stripe)
 *   - follow-up config: internal sales cadence day 1 intro / day 3 value /
 *     day 7 case study / day 14 close (the 1–10 step schema the follow-up
 *     config supports — PUT /api/follow-ups/config shape)
 *   - review config (delay 3 days; review URL left empty — no real public
 *     review surface exists for LeadFlow AI yet; never fabricate a URL)
 *   - the tenant's default automation rules (explicitly, via
 *     ensureDefaultRulesForBusiness — the seed path does NOT auto-create them
 *     because the lazy creator only runs on scheduler ticks)
 *
 * Idempotent: skips creation if the owner user already exists (same approach
 * as db/seed.ts) and always re-ensures default automation rules.
 *
 * Run:  cd /home/agent-lead/leadflowai/leadflow-ai-site && unset DATABASE_URL && bun run scripts/seed-dogfood.ts
 *   (unset DATABASE_URL for local SQLite; set it to a postgresql:// URL to seed production)
 */
import { runMigrations } from "../src/server/db/migrate";
import * as repo from "../src/server/db/repo";
import { hashPassword } from "../src/server/auth/password";
import { ensureDefaultRulesForBusiness } from "../src/server/automations/rules";

export const DOGFOOD_OWNER_EMAIL = "owner@leadflowai.internal";
export const DOGFOOD_OWNER_NAME = "LeadFlow AI Owner";
export const DOGFOOD_OWNER_PASSWORD = "leadflow1234";
export const DOGFOOD_BUSINESS_NAME = "LeadFlow AI";

const DAY = 24 * 60 * 60 * 1000;

const HOURS = {
  monday: { open: "09:00", close: "17:00", closed: false },
  tuesday: { open: "09:00", close: "17:00", closed: false },
  wednesday: { open: "09:00", close: "17:00", closed: false },
  thursday: { open: "09:00", close: "17:00", closed: false },
  friday: { open: "09:00", close: "17:00", closed: false },
  saturday: { open: "00:00", close: "00:00", closed: true },
  sunday: { open: "00:00", close: "00:00", closed: true },
};

/** The internal sales follow-up cadence (day 1 SMS intro / day 3 value prop /
 *  day 7 proof / day 14 direct CTA) expressed in the follow-up config schema.
 *  templateKeys use the `sales_<n>` family (followups/engine.ts) so the
 *  dogfood tenant sends the SALES cadence, not the generic customer sequence
 *  (which stays on `seq_<n>` for other tenants). */
export const DOGFOOD_FOLLOWUP_STEPS: repo.FollowUpStepConfig[] = [
  { step: 1, days: 1, type: "sms", enabled: true, templateKey: "sales_1" },
  { step: 2, days: 3, type: "email", enabled: true, templateKey: "sales_2" },
  { step: 3, days: 7, type: "email", enabled: true, templateKey: "sales_3" },
  { step: 4, days: 14, type: "email", enabled: true, templateKey: "sales_4" },
];

export const DOGFOOD_SERVICES = [
  {
    name: "AI Receptionist",
    description: "24/7 AI answering, qualification, and appointment booking for local service businesses.",
    priceCents: 0, // SaaS subscription — call for pricing, never an invented per-visit rate
    durationMin: 30,
  },
  {
    name: "Lead Qualification",
    description: "Automatic lead scoring (0–100 rubric) with HOT/WARM/COLD classification.",
    priceCents: 0,
    durationMin: 15,
  },
  {
    name: "Follow-Up Automation",
    description: "Multi-step email and SMS follow-up sequences with stop rules when a lead books.",
    priceCents: 0,
    durationMin: 15,
  },
];

export const DOGFOOD_KNOWLEDGE = [
  {
    kind: "faq" as const,
    question: "What is LeadFlow AI?",
    answer:
      "LeadFlow AI is a platform that helps local service businesses turn more leads into customers automatically. AI agents respond instantly, qualify and score leads, book appointments, follow up with unconverted prospects, and hand unusual or sensitive situations to a human — while owners get real performance analytics.",
  },
  {
    kind: "faq" as const,
    question: "How much does LeadFlow AI cost?",
    answer:
      "There's a one-time setup fee of $1,500–$3,000, then a monthly subscription: Starter $497/month, Professional $997/month, or Premium $1,497/month.",
  },
  {
    kind: "faq" as const,
    question: "How does booking work?",
    answer:
      "Our AI receptionist checks your real calendar availability and books appointments on it — it never invents or guesses times. When it's uncertain it hands off to a human.",
  },
  {
    kind: "general" as const,
    question: "",
    answer:
      "LeadFlow AI runs its own operations on its platform: our outbound campaign leads, follow-ups, appointments, and reporting all run through the same automation engine we sell.",
  },
];

export async function seedDogfood() {
  await runMigrations();

  const existing = await repo.getUserByEmail(DOGFOOD_OWNER_EMAIL);
  if (existing) {
    const biz = await repo.getBusinessForUser(existing.id);
    console.log(`[seed-dogfood] tenant already exists (user=${existing.id}, business=${biz?.id ?? "none"}) — skipping`);
    if (biz) await ensureDogfoodRules(biz.id);
    return biz;
  }

  const owner = await repo.createUser({
    name: DOGFOOD_OWNER_NAME,
    email: DOGFOOD_OWNER_EMAIL,
    passwordHash: hashPassword(DOGFOOD_OWNER_PASSWORD),
    role: "owner",
  });
  console.log(`[seed-dogfood] created owner (${DOGFOOD_OWNER_EMAIL} / ${DOGFOOD_OWNER_PASSWORD})`);

  const business = await repo.createBusiness({
    ownerId: owner.id,
    name: DOGFOOD_BUSINESS_NAME,
    category: "home_services",
    description:
      "LeadFlow AI is a multi-tenant SaaS platform that helps local service businesses turn more leads into customers automatically. This is the company's own tenant on its own platform (dogfooding).",
  });

  await repo.updateBusiness(business.id, {
    serviceAreaJson: JSON.stringify({
      zipCodes: ["49221"],
      cities: ["Adrian"],
    }),
    hoursJson: JSON.stringify(HOURS),
    policiesJson: JSON.stringify({
      cancellationPolicy: "Please give 24 hours' notice to reschedule or cancel a demo or onboarding session.",
      financing: "",
      promotions: "",
      welcomeMessage:
        "Hi! Thanks for reaching out to LeadFlow AI. We help local service businesses turn more leads into customers — how can we help you today?",
    }),
    onboardingStep: 6,
    onboardingCompleted: 1,
  });

  for (const sv of DOGFOOD_SERVICES) await repo.addService(business.id, sv);
  for (const k of DOGFOOD_KNOWLEDGE) await repo.addKnowledge(business.id, k);

  await repo.saveWidgetSettings(business.id, {
    enabled: 1,
    primaryColor: "#4f46e5",
    position: "bottom-right",
    welcomeMessage: "Hi! Thanks for reaching out to LeadFlow AI. How can we help you today?",
  });

  // Six mock providers — the same status rows the product shows as "mock
  // until connected"; real providers swap in via env later (config-only).
  for (const provider of ["ai", "sms", "email", "calendar", "crm", "stripe"] as const) {
    await repo.setIntegrationStatus(business.id, provider, "mock", { provider: `mock-${provider}` });
  }

  await repo.saveFollowUpConfig(business.id, DOGFOOD_FOLLOWUP_STEPS);

  // Review config: delay 3 days; review URL intentionally empty — no real
  // public review surface exists for LeadFlow AI (never fabricate a URL).
  await repo.saveReviewConfig(business.id, { enabled: true, delayDays: 3, reviewUrl: "" });

  const rulesCreated = await ensureDogfoodRules(business.id);

  console.log(`[seed-dogfood] created owner (${DOGFOOD_OWNER_EMAIL}) + business "${DOGFOOD_BUSINESS_NAME}"`);
  console.log(`[seed-dogfood]   ${DOGFOOD_SERVICES.length} services, ${DOGFOOD_KNOWLEDGE.length} KB entries, 6 mock integrations, ${DOGFOOD_FOLLOWUP_STEPS.length}-step follow-up config, review config`);
  console.log(`[seed-dogfood]   default automation rules: ${rulesCreated ? "created" : "already present"}`);
  console.log(`[seed-dogfood] business id: ${business.id}`);
  return business;
}

/**
 * Ensure the tenant's default automation rules exist (name-based, idempotent).
 * The lazy ensureDefaultRulesForBusiness path only runs on scheduler ticks, so
 * the seed creates them explicitly to guarantee a fully-wired tenant.
 */
export async function ensureDogfoodRules(businessId: string): Promise<boolean> {
  return ensureDefaultRulesForBusiness(businessId);
}

if (import.meta.main) {
  seedDogfood()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[seed-dogfood] failed:", err);
      process.exit(1);
    });
}
