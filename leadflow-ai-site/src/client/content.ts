/** Shared public-site content — pricing, agents, benefits, FAQs.
 * Single source of truth used by the landing page and the marketing pages,
 * so pricing always matches the business plan exactly. */

export type Plan = {
  name: string;
  price: string;
  blurb: string;
  features: string[];
  highlight: boolean;
};

export const SETUP_FEE_NOTE =
  "One-time setup and onboarding: $1,500–$3,000 depending on your business's needs. Then a flat monthly subscription — no per-lead surprises.";

export const PLANS: Plan[] = [
  {
    name: "Starter",
    price: "$497",
    blurb: "For solo operators who want to stop missing leads.",
    features: [
      "AI receptionist & website chat",
      "Lead qualification & scoring",
      "Basic follow-up",
      "Appointment booking",
      "Basic analytics",
    ],
    highlight: false,
  },
  {
    name: "Professional",
    price: "$997",
    blurb: "For growing teams that need the full lead engine.",
    features: [
      "Everything in Starter, plus:",
      "SMS & advanced follow-up",
      "CRM integration",
      "Review automation",
      "Multiple team members",
      "Advanced analytics",
    ],
    highlight: true,
  },
  {
    name: "Premium",
    price: "$1,497",
    blurb: "For multi-location businesses going all-in.",
    features: [
      "Everything in Professional, plus:",
      "AI voice receptionist",
      "Advanced integrations",
      "Custom workflows",
      "Priority support",
      "Advanced reporting",
    ],
    highlight: false,
  },
];

export type Agent = {
  name: string;
  desc: string;
};

export const AGENTS: Agent[] = [
  {
    name: "AI Receptionist",
    desc: "Answers every lead in seconds from your business's own knowledge base — services, hours, pricing, policies — and hands off when a human is needed.",
  },
  {
    name: "Lead Qualification",
    desc: "Collects name, phone, service, location, and urgency, then scores each lead HOT, WARM, or COLD with an estimated value.",
  },
  {
    name: "Appointment Booking",
    desc: "Checks your real calendar availability and books appointments for you — it never invents a time that doesn't exist.",
  },
  {
    name: "Follow-Up",
    desc: "Re-engages unconverted prospects on a 1, 3, 7, and 14-day sequence until they book, opt out, or you turn it off.",
  },
  {
    name: "Review",
    desc: "Asks happy customers for a public review after the job — and quietly flags unhappy ones to you instead of asking them to post.",
  },
  {
    name: "Business Intelligence",
    desc: "Sends a weekly report of new leads, appointments, conversion, and after-hours activity so you always know what's working.",
  },
];

export type Benefit = { title: string; body: string };

export const BENEFITS: Benefit[] = [
  {
    title: "Instant lead response",
    body: "Leads are answered in seconds — even at 2 a.m. — while they're still in the mood to buy.",
  },
  {
    title: "Book more appointments",
    body: "Qualify leads and book them straight onto your calendar automatically, no phone tag required.",
  },
  {
    title: "Automatic follow-up",
    body: "Prospects who aren't ready today get gentle, on-brand follow-ups over the next two weeks.",
  },
  {
    title: "Never miss an after-hours lead",
    body: "Evening and weekend leads are captured, qualified, and booked before your competitors open.",
  },
  {
    title: "Less admin work",
    body: "Scores, statuses, and notes update themselves. You run the job; we handle the chasing.",
  },
  {
    title: "Know where leads come from",
    body: "See which channels actually produce customers — website, chat, or referrals — and spend where it pays.",
  },
];

export type Faq = { q: string; a: string };

export const FAQS: Faq[] = [
  {
    q: "What is LeadFlow AI?",
    a: "LeadFlow AI is an AI receptionist for local service businesses — HVAC, plumbing, roofing, landscaping, cleaning, auto repair, restoration, and home services. It responds to leads instantly, answers questions from your business's own knowledge base, qualifies and scores every lead, books appointments from your real availability, follows up with unconverted prospects, and hands unusual or sensitive situations to you.",
  },
  {
    q: "How is this different from a website chatbot?",
    a: "Most chatbots just answer questions. LeadFlow AI works the full funnel: it collects contact details, qualifies and scores leads, books real appointments on your calendar, runs follow-up sequences, and surfaces a weekly report — with a human takeover queue for anything it shouldn't handle alone.",
  },
  {
    q: "How long does setup take?",
    a: "The guided setup walks you through your services, hours, service area, and the answers your AI should know — most businesses are live in about 10 minutes. You can also try it immediately with the included Smith's HVAC demo business.",
  },
  {
    q: "What does it cost?",
    a: "Plans are $497, $997, or $1,497 per month, plus a one-time setup fee of $1,500–$3,000 based on your needs. New accounts start with a free trial — no credit card required — so you can see it working before you pay anything.",
  },
  {
    q: "What happens when the AI doesn't know an answer?",
    a: "The AI never guesses or fabricates. When it doesn't know something — or a conversation involves pricing it hasn't been given, an angry customer, a refund request, or anything sensitive — it says so honestly and escalates the conversation to your team's queue, where a human takes over.",
  },
  {
    q: "Can I see and control what the AI says to my leads?",
    a: "Yes. Every conversation lives in your inbox, and you can take over any conversation manually at any time. The AI stops responding until you hand it back. You also control what it knows: it only answers from the services, hours, pricing, and policies you configure.",
  },
  {
    q: "Do I need to connect my calendar?",
    a: "Appointment booking always checks real availability — the AI never invents a time. Calendar and SMS/email connections plug in during setup; until they're connected, the platform runs on built-in booking and messaging so the experience still works end to end.",
  },
  {
    q: "Who is LeadFlow AI for?",
    a: "Local service businesses that live or die by responding fast: HVAC, plumbing, roofing, landscaping, cleaning, auto repair, restoration, and other home services — especially owners who can't sit by the phone all day.",
  },
];

export const TRUST_LINE = "Free trial · No credit card required · Cancel anytime";
