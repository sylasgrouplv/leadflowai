/** Typed fetch helper for the LeadFlow API. Cookies ride along (same origin). */

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
    ...opts,
  });
  if (res.status === 204) return undefined as T;
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    const msg = (body as { error?: string } | null)?.error || `Request failed (${res.status})`;
    throw new ApiError(msg, res.status);
  }
  return body as T;
}

// ---------------------------------------------------------------------------
// API types
// ---------------------------------------------------------------------------

export type UserRole = "admin" | "owner" | "employee";
export type LeadStatus =
  | "new"
  | "contacted"
  | "qualified"
  | "appointment_booked"
  | "customer"
  | "lost"
  | "unqualified"
  | "needs_human";
export type LeadScore = "hot" | "warm" | "cold";

export interface User {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  createdAt: number;
}

export interface DayHours {
  open: string;
  close: string;
  closed: boolean;
}
export type WeekHours = Record<"monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday", DayHours>;

export interface Business {
  id: string;
  name: string;
  category: string;
  phone: string;
  email: string;
  website: string;
  description: string;
  serviceArea: { zipCodes: string[]; cities: string[] };
  hours: Partial<WeekHours>;
  policies: { cancellationPolicy: string; financing: string; promotions: string; welcomeMessage: string };
  onboardingStep: number;
  onboardingCompleted: boolean;
  createdAt: number;
}

export interface MeResponse {
  user: User;
  business: Business | null;
  subscription: { plan: string; status: string } | null;
}

export interface Service {
  id: string;
  businessId: string;
  name: string;
  description: string;
  priceCents: number;
  durationMin: number;
  /** Revenue attribution (spec §23): configured average job value; 0 = use priceCents. */
  averageValueCents: number;
  active: number;
}

export interface KnowledgeEntry {
  id: string;
  kind: "faq" | "policy" | "service_info" | "general";
  question: string;
  answer: string;
}

export interface Lead {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  source: string;
  serviceRequested: string;
  location: string;
  status: LeadStatus;
  score: LeadScore;
  notes: string;
  assignedTo: string | null;
  assignedName: string | null;
  estimatedValueCents: number;
  lastContactedAt: number | null;
  nextFollowUp: { scheduledFor: number; type: string } | null;
  createdAt: number;
  updatedAt: number;
}

export type ConversationStatus = "active" | "ai_handling" | "human_takeover" | "closed";
export type MessageSender = "ai" | "lead" | "employee" | "system";

export interface Conversation {
  id: string;
  businessId: string;
  leadId: string | null;
  channel: string;
  status: ConversationStatus;
  aiEnabled: number;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationListItem extends Conversation {
  lead: Lead | null;
  lastMessage: { body: string; sender: MessageSender; createdAt: number } | null;
  priority: boolean;
}

export interface Message {
  id: string;
  conversationId: string;
  sender: MessageSender;
  body: string;
  createdAt: number;
}

export interface LeadAppointment {
  appointment: { id: string; startAt: number; endAt: number; status: string; notes: string | null };
  serviceName: string | null;
}

export interface ConversationBundle {
  conversation: Conversation;
  lead: Lead | null;
  messages: Message[];
  appointments: LeadAppointment[];
  nextFollowUp: { scheduledFor: number; type: string } | null;
  ai: { name: string; active: boolean; status: string; heldByHuman: boolean };
}

export interface TeamMember {
  id: string;
  role: UserRole;
  userId: string;
  name: string;
  email: string;
}

export interface LeadDetail {
  lead: Lead;
  conversations: Conversation[];
  appointments: LeadAppointment[];
  team: TeamMember[];
}

export interface UpcomingAppointment {
  appointment: {
    id: string;
    startAt: number;
    endAt: number;
    status: string;
  };
  leadName: string | null;
  leadLastName: string | null;
  serviceName: string | null;
}

export interface DashboardData {
  businessId: string;
  businessName: string;
  stats: {
    leads: number;
    qualified: number;
    appointments: number;
    customers: number;
    conversionRate: number;
    estimatedRevenueCents: number;
  };
  funnel: { leads: number; qualified: number; appointments: number; customers: number };
  recentLeads: Lead[];
  upcomingAppointments: UpcomingAppointment[];
}

// ---------------------------------------------------------------------------
// AI agent config / usage (spec §38 + §32)
// ---------------------------------------------------------------------------
export type EscalationSensitivity = "Conservative" | "Balanced" | "Aggressive";
export type AiTone = "Professional" | "Friendly" | "Casual" | "Concise";
export type AiResponseLength = "Short" | "Medium" | "Detailed";
export interface AiConfig {
  autoRespond: boolean;
  agentName: string;
  tone: AiTone;
  responseLength: AiResponseLength;
  escalationSensitivity: EscalationSensitivity;
  escalationKeywords: string[];
  monthlyBudgetCents: number;
}
export interface AiConfigResponse {
  config: AiConfig;
  welcomeMessage: string;
}
export interface UsageSummary {
  aiMessages: number;
  smsMessages: number;
  voiceMessages: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostCents: number;
}
export interface BudgetStatus {
  monthStart: number;
  monthEnd: number;
  usage: UsageSummary;
  budgetCents: number;
  percentUsed: number;
  exhausted: boolean;
  alerts: { threshold: number; reached: boolean }[];
}
export interface AnalyticsData {
  businessId: string;
  businessName: string;
  funnel: { leads: number; qualified: number; appointments: number; customers: number };
  stats: {
    leads: number;
    qualified: number;
    appointments: number;
    customers: number;
    conversionRate: number;
    estimatedRevenueCents: number;
    aiMessages: number;
    humanMessages: number;
  };
  leadsOverTime: { date: string; count: number }[];
  sources: { source: string; count: number; share: number }[];
  topServices: { service: string; count: number }[];
}

// ---------------------------------------------------------------------------
// AI BRAIN 4 — reviews + weekly business-intelligence reports
// ---------------------------------------------------------------------------

export interface ReviewConfig {
  id: string;
  businessId: string;
  enabled: number;
  delayDays: number;
  reviewUrl: string;
}

export interface ReviewRecord {
  review: {
    id: string;
    businessId: string;
    leadId: string;
    appointmentId: string | null;
    feedbackText: string;
    sentiment: "positive" | "negative" | "unknown";
    reviewRequestSentAt: number | null;
    reviewLinkSentAt: number | null;
    createdAt: number;
    updatedAt: number;
  };
  lead: Lead | null;
  serviceName: string | null;
}

export interface WeeklyMetrics {
  weekStart: number;
  weekEnd: number;
  newLeads: number;
  qualified: number;
  appointmentsBooked: number;
  jobsCompleted: number;
  customers: number;
  leadToAppointmentRate: number;
  conversionRate: number;
  /** Revenue attribution estimate (§23) — always label "Estimated Revenue". */
  estimatedRevenueCents: number;
  aiMessages: number;
  aiConversations: number;
  afterHoursLeads: number;
  afterHoursAppointments: number;
  topServices: { service: string; count: number }[];
  leadSources: { source: string; count: number }[];
  avgResponseTimeMs: number;
  lostLeads: number;
  followupsSent: number;
  followupsDue: number;
  followupSendRate: number;
  feedbackRequests: number;
  positiveFeedback: number;
  negativeFeedback: number;
}

export interface WeeklyNarrative {
  summary: string;
  wins: string[];
  problems: string[];
  opportunities: string[];
  recommendedActions: string[];
}

export interface WeeklyReport {
  id: string;
  businessId: string;
  weekStart: number;
  weekEnd: number;
  metrics: WeeklyMetrics;
  narrative: WeeklyNarrative;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Appointments / follow-ups / notifications
// ---------------------------------------------------------------------------

export type AppointmentStatus = "booked" | "confirmed" | "completed" | "cancelled" | "no_show";

export interface Appointment {
  id: string;
  businessId: string;
  leadId: string | null;
  serviceId: string | null;
  startAt: number;
  endAt: number;
  status: AppointmentStatus;
  notes: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface AppointmentListItem {
  appointment: Appointment;
  lead: Lead | null;
  serviceName: string | null;
}

export interface AvailabilitySlot {
  startAt: number;
  endAt: number;
}

export interface DaySlots {
  date: string;
  slots: AvailabilitySlot[];
}

export type FollowUpType = "sms" | "email";
export type FollowUpStatus = "pending" | "sent" | "skipped" | "cancelled" | "paused";

export interface FollowUp {
  id: string;
  businessId: string;
  leadId: string;
  type: FollowUpType;
  scheduledFor: number;
  templateKey: string | null;
  status: FollowUpStatus;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  lead: Lead | null;
  stepInfo: { step: number | null; label: string };
}

export interface FollowUpStepConfig {
  step: number;
  days: number;
  type: FollowUpType;
  enabled: boolean;
  templateKey: string;
}

export interface Notification {
  id: string;
  businessId: string;
  userId: string | null;
  kind: string;
  title: string;
  body: string | null;
  read: number;
  createdAt: number;
}

export const appointmentStatusLabel: Record<AppointmentStatus, string> = {
  booked: "Booked",
  confirmed: "Confirmed",
  completed: "Completed",
  cancelled: "Cancelled",
  no_show: "No-show",
};

export const appointmentStatusColor: Record<AppointmentStatus, string> = {
  booked: "bg-indigo-100 text-indigo-700",
  confirmed: "bg-blue-100 text-blue-700",
  completed: "bg-emerald-100 text-emerald-700",
  cancelled: "bg-slate-100 text-slate-500",
  no_show: "bg-red-100 text-red-700",
};

export const followUpStatusColor: Record<FollowUpStatus, string> = {
  pending: "bg-amber-100 text-amber-700",
  sent: "bg-emerald-100 text-emerald-700",
  skipped: "bg-slate-100 text-slate-500",
  cancelled: "bg-slate-100 text-slate-500",
  paused: "bg-orange-100 text-orange-700",
};

export const followUpStatusLabel: Record<FollowUpStatus, string> = {
  pending: "Scheduled",
  sent: "Sent",
  skipped: "Skipped",
  cancelled: "Stopped",
  paused: "Paused",
};

export const fmtTime = (ms: number) =>
  new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export const money = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100);

export const fmtDate = (ms: number) =>
  new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });

export const fmtDateTime = (ms: number) =>
  new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export const scoreColor: Record<LeadScore, string> = {
  hot: "bg-red-100 text-red-700",
  warm: "bg-amber-100 text-amber-700",
  cold: "bg-slate-100 text-slate-600",
};

export const statusColor: Record<LeadStatus, string> = {
  new: "bg-indigo-100 text-indigo-700",
  contacted: "bg-blue-100 text-blue-700",
  qualified: "bg-emerald-100 text-emerald-700",
  appointment_booked: "bg-violet-100 text-violet-700",
  customer: "bg-green-100 text-green-700",
  lost: "bg-slate-100 text-slate-500",
  unqualified: "bg-slate-100 text-slate-500",
  needs_human: "bg-red-100 text-red-700",
};

export const statusLabel: Record<LeadStatus, string> = {
  new: "New",
  contacted: "Contacted",
  qualified: "Qualified",
  appointment_booked: "Appt. Booked",
  customer: "Customer",
  lost: "Lost",
  unqualified: "Unqualified",
  needs_human: "Needs Human",
};
