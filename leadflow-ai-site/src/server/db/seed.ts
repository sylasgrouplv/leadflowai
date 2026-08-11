/**
 * Seed — creates:
 *   - platform admin user (admin@leadflow.ai)
 *   - demo owner user (demo@leadflow.ai) + "Smith's HVAC" business with full
 *     onboarding data, sample leads, conversations, appointments, follow-ups
 *
 * Idempotent: skips creation if the demo user already exists.
 * Run: bun run db:seed
 */
import { runMigrations } from "./migrate";
import * as repo from "./repo";
import { hashPassword } from "../auth/password";

const DAY = 24 * 60 * 60 * 1000;

const HOURS = {
  monday: { open: "08:00", close: "18:00", closed: false },
  tuesday: { open: "08:00", close: "18:00", closed: false },
  wednesday: { open: "08:00", close: "18:00", closed: false },
  thursday: { open: "08:00", close: "18:00", closed: false },
  friday: { open: "08:00", close: "18:00", closed: false },
  saturday: { open: "09:00", close: "13:00", closed: false },
  sunday: { open: "00:00", close: "00:00", closed: true },
};

export async function seed() {
  runMigrations();

  const existingAdmin = await repo.getUserByEmail("admin@leadflow.ai");
  if (!existingAdmin) {
    await repo.createUser({ name: "LeadFlow Admin", email: "admin@leadflow.ai", passwordHash: hashPassword("admin1234"), role: "admin" });
    console.log("[seed] created admin user (admin@leadflow.ai / admin1234)");
  }

  const existingDemo = await repo.getUserByEmail("demo@leadflow.ai");
  if (existingDemo) {
    const biz = await repo.getBusinessForUser(existingDemo.id);
    console.log(`[seed] demo data already exists (user=${existingDemo.id}, business=${biz?.id ?? "none"}) — skipping`);
    await ensureDemoEmployee();
    return;
  }

  const demo = await repo.createUser({ name: "Sarah Smith", email: "demo@leadflow.ai", passwordHash: hashPassword("demo1234"), role: "owner" });
  const business = await repo.createBusiness({
    ownerId: demo.id,
    name: "Smith's HVAC",
    category: "hvac",
    phone: "(555) 123-4567",
    email: "hello@smithshvac.com",
    website: "https://smithshvac.com",
    description: "Family-owned heating and cooling company serving the greater Springfield area since 2004.",
  });
  await repo.updateBusiness(business.id, {
    serviceAreaJson: JSON.stringify({ zipCodes: ["62701", "62702", "62703", "62704", "62711", "62712"], cities: ["Springfield", "Chatham", "Rochester"] }),
    hoursJson: JSON.stringify(HOURS),
    policiesJson: JSON.stringify({
      cancellationPolicy: "Please give us 24 hours' notice to reschedule or cancel an appointment.",
      financing: "0% financing for 12 months on qualifying installations over $2,500.",
      promotions: "New customer special: $89 tune-up (regularly $129).",
      welcomeMessage: "Hi! Thanks for reaching out to Smith's HVAC. How can we help keep your home comfortable?",
    }),
    onboardingStep: 6,
    onboardingCompleted: 1,
  });

  const services = [
    { name: "AC Tune-Up", description: "Seasonal maintenance for central air systems", priceCents: 12900, durationMin: 60 },
    { name: "AC Repair", description: "Diagnostic and repair of cooling issues", priceCents: 18900, durationMin: 90 },
    { name: "Furnace Tune-Up", description: "Annual heating system maintenance", priceCents: 12900, durationMin: 60 },
    { name: "Furnace Installation", description: "High-efficiency furnace replacement", priceCents: 0, durationMin: 240 },
    { name: "Duct Cleaning", description: "Whole-home duct cleaning and inspection", priceCents: 39900, durationMin: 120 },
    { name: "Smart Thermostat Install", description: "Install and configure a smart thermostat", priceCents: 14900, durationMin: 45 },
  ];
  for (const sv of services) await repo.addService(business.id, sv);

  const kb = [
    { kind: "faq" as const, question: "How much does a tune-up cost?", answer: "Our standard tune-up is $129, and new customers get $40 off — $89 for the first visit." },
    { kind: "faq" as const, question: "What areas do you serve?", answer: "We serve Springfield and the surrounding communities including Chatham and Rochester." },
    { kind: "faq" as const, question: "Do you offer financing?", answer: "Yes — 0% financing for 12 months on qualifying installations over $2,500." },
    { kind: "faq" as const, question: "Do you handle emergencies?", answer: "For heating or cooling emergencies during business hours, call (555) 123-4567 and we'll get a tech to you as soon as possible." },
    { kind: "policy" as const, question: "", answer: "Cancellation policy: please give 24 hours' notice to reschedule or cancel an appointment." },
    { kind: "general" as const, question: "", answer: "All our technicians are licensed, insured, and background-checked." },
  ];
  for (const k of kb) await repo.addKnowledge(business.id, k);

  const t = Date.now();
  const mk = (over: Partial<Parameters<typeof repo.createLead>[0]> & { firstName: string }) => repo.createLead({ businessId: business.id, source: "website_chat", ...over });

  const l1 = await mk({ firstName: "Mike", lastName: "Reynolds", phone: "(555) 201-3344", email: "mike.r@example.com", serviceRequested: "AC Repair", location: "62704", status: "new", score: "warm", estimatedValueCents: 35000, createdAt: t - 2 * 60 * 60 * 1000 });
  const l2 = await mk({ firstName: "Dana", lastName: "Ortiz", phone: "(555) 202-7788", serviceRequested: "Furnace Installation", location: "62702", status: "new", score: "hot", estimatedValueCents: 850000, createdAt: t - 5 * 60 * 60 * 1000 });
  const l3 = await mk({ firstName: "Tom", lastName: "Whitfield", phone: "(555) 203-9911", serviceRequested: "AC Tune-Up", location: "Chatham", status: "contacted", score: "warm", estimatedValueCents: 12900, createdAt: t - 1 * DAY });
  const l4 = await mk({ firstName: "Priya", lastName: "Patel", phone: "(555) 204-2211", serviceRequested: "Duct Cleaning", location: "62711", status: "qualified", score: "hot", estimatedValueCents: 45000, createdAt: t - 2 * DAY });
  const l5 = await mk({ firstName: "Carl", lastName: "Bennett", phone: "(555) 205-5566", serviceRequested: "Smart Thermostat Install", location: "Rochester", status: "qualified", score: "warm", estimatedValueCents: 20000, createdAt: t - 3 * DAY });
  const l6 = await mk({ firstName: "Elena", lastName: "Fuentes", phone: "(555) 206-4433", serviceRequested: "AC Repair", location: "62703", status: "appointment_booked", score: "hot", estimatedValueCents: 28000, createdAt: t - 4 * DAY });
  const l7 = await mk({ firstName: "Greg", lastName: "Sutter", phone: "(555) 207-8899", serviceRequested: "Furnace Tune-Up", location: "62701", status: "appointment_booked", score: "warm", estimatedValueCents: 12900, createdAt: t - 5 * DAY });
  const l8 = await mk({ firstName: "Anne", lastName: "Kowalski", phone: "(555) 208-1122", serviceRequested: "Furnace Installation", location: "62704", status: "customer", score: "hot", estimatedValueCents: 720000, createdAt: t - 30 * DAY });
  const l9 = await mk({ firstName: "Rob", lastName: "Delgado", phone: "(555) 209-6677", serviceRequested: "Duct Cleaning", location: "Chatham", status: "customer", score: "warm", estimatedValueCents: 39900, createdAt: t - 21 * DAY });
  const l10 = await mk({ firstName: "Stacy", lastName: "Moore", phone: "(555) 210-3344", serviceRequested: "AC Tune-Up", location: "62712", status: "lost", score: "cold", estimatedValueCents: 0, createdAt: t - 10 * DAY });

  // Conversations + messages (AI receptionist exchange for two leads)
  const conv1 = await repo.createConversation(business.id, { leadId: l2.id, channel: "chat", status: "ai_handling" });
  await repo.addMessage(business.id, { conversationId: conv1.id, sender: "lead", body: "Hi, my furnace is making a loud noise and I think I need a new one. Can you help?", createdAt: t - 5 * 60 * 60 * 1000 });
  await repo.addMessage(business.id, { conversationId: conv1.id, sender: "ai", body: "Hi Dana — I'm sorry to hear about your furnace! We install high-efficiency units. Could you tell me which neighborhood you're in and when you'd like someone to come take a look?", createdAt: t - 5 * 60 * 60 * 1000 + 60_000 });
  await repo.addMessage(business.id, { conversationId: conv1.id, sender: "lead", body: "I'm in the 62702 area. Would Thursday morning work?", createdAt: t - 4 * 60 * 60 * 1000 });
  await repo.addMessage(business.id, { conversationId: conv1.id, sender: "ai", body: "Thursday works — let me check availability and confirm a time for you.", createdAt: t - 4 * 60 * 60 * 1000 + 45_000 });

  const conv2 = await repo.createConversation(business.id, { leadId: l4.id, channel: "chat", status: "human_takeover" });
  await repo.addMessage(business.id, { conversationId: conv2.id, sender: "lead", body: "Do you clean ducts in houses with pets? We have two dogs.", createdAt: t - 2 * DAY });
  await repo.addMessage(business.id, { conversationId: conv2.id, sender: "ai", body: "Great question — let me get a definitive answer for you from the team.", createdAt: t - 2 * DAY + 30_000 });

  // Appointments (2 upcoming, 1 completed, 1 cancelled)
  const apptService = await repo.listServices(business.id);
  await repo.createAppointment({ businessId: business.id, leadId: l6.id, serviceId: apptService.find((s) => s.name === "AC Repair")?.id ?? null, startAt: t + 1 * DAY + 3 * 3600_000, endAt: t + 1 * DAY + 3 * 3600_000 + 90 * 60_000, status: "booked", createdAt: t - 4 * DAY });
  await repo.createAppointment({ businessId: business.id, leadId: l7.id, serviceId: apptService.find((s) => s.name === "Furnace Tune-Up")?.id ?? null, startAt: t + 2 * DAY + 5 * 3600_000, endAt: t + 2 * DAY + 5 * 3600_000 + 60 * 60_000, status: "confirmed", createdAt: t - 5 * DAY });
  await repo.createAppointment({ businessId: business.id, leadId: l8.id, serviceId: apptService.find((s) => s.name === "Furnace Installation")?.id ?? null, startAt: t - 25 * DAY + 2 * 3600_000, endAt: t - 25 * DAY + 2 * 3600_000 + 240 * 60_000, status: "completed", createdAt: t - 30 * DAY });
  await repo.createAppointment({ businessId: business.id, leadId: l10.id, serviceId: apptService.find((s) => s.name === "AC Tune-Up")?.id ?? null, startAt: t - 8 * DAY + 2 * 3600_000, endAt: t - 8 * DAY + 2 * 3600_000 + 60 * 60_000, status: "cancelled", createdAt: t - 10 * DAY });

  // Follow-ups
  await repo.createFollowUp(business.id, { leadId: l1.id, type: "sms", scheduledFor: t + 1 * DAY, templateKey: "followup_1d" });
  await repo.createFollowUp(business.id, { leadId: l3.id, type: "email", scheduledFor: t + 2 * DAY, templateKey: "followup_3d" });
  await repo.createFollowUp(business.id, { leadId: l5.id, type: "sms", scheduledFor: t + 6 * 3600_000, templateKey: "followup_1d" });
  await repo.createFollowUp(business.id, { leadId: l2.id, type: "sms", scheduledFor: t + 2 * 3600_000, templateKey: "appointment_reminder" });

  await repo.setIntegrationStatus(business.id, "calendar", "mock", { provider: "mock-calendar" });
  await repo.setIntegrationStatus(business.id, "crm", "mock", { provider: "mock-crm" });
  await repo.setIntegrationStatus(business.id, "ai", "mock", { provider: "mock-ai" });

  // Website chat widget (spec §14): enabled with a brand color; the welcome
  // message falls back to the business's policies.welcomeMessage.
  await repo.saveWidgetSettings(business.id, { enabled: 1, primaryColor: "#2563eb", position: "bottom-right" });

  await ensureDemoEmployee(business.id);

  console.log("[seed] created demo owner (demo@leadflow.ai / demo1234) + Smith's HVAC");
  console.log("[seed]   10 leads, 2 conversations, 4 appointments, 4 follow-ups, 6 services, 6 KB entries");
  console.log(`[seed] business id: ${business.id}`);
}

/**
 * Idempotent: creates an employee account on the demo business (used to verify
 * the restricted employee role view) and assigns two seeded leads to them.
 */
async function ensureDemoEmployee(businessId?: string) {
  let business = businessId ? await repo.getBusinessById(businessId) : null;
  if (!business) {
    const owner = await repo.getUserByEmail("demo@leadflow.ai");
    if (!owner) return;
    business = await repo.getBusinessForUser(owner.id);
    if (!business) return;
  }
  const existing = await repo.getUserByEmail("team@leadflow.ai");
  if (!existing) {
    const emp = await repo.createUser({ name: "Alex Team", email: "team@leadflow.ai", passwordHash: hashPassword("team1234"), role: "employee" });
    await repo.addTeamMember(business.id, emp.id, "employee");
    console.log(`[seed] created employee (team@leadflow.ai / team1234) on ${business.name}`);
  }
  // Make sure a couple of demo leads are assigned to the employee so the
  // restricted view has data to show.
  const leads = await repo.listLeads(business.id);
  const emp = await repo.getUserByEmail("team@leadflow.ai");
  if (emp) {
    const unassigned = leads.filter((l) => !l.assignedTo).slice(0, 2);
    for (const l of unassigned) await repo.updateLead(business.id, l.id, { assignedTo: emp.id });
  }
}

if (import.meta.main) {
  seed()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[seed] failed:", err);
      process.exit(1);
    });
}
