/**
 * CUSTOMER REVIEW AGENT (spec §21) — AI BRAIN 4.
 *
 * Subscribes to JOB_COMPLETED through the automation engine: the default rule
 * `job_completed_review` fires `send_review_request` after the business's
 * configured delay (default 1 day). The tool registry is the only mutation
 * path — this module implements the tool handlers, and the automation engine
 * calls them via callAiTool (validated + tenant-scoped + audited).
 *
 * Flow (spec §21 — never pressure for positive reviews):
 *   JOB_COMPLETED ──delay──▶ feedback request (SMS/email, audited)
 *     → customer replies (conversation message endpoint or POST
 *       /api/reviews/feedback)
 *       ├─ POSITIVE → send the business's configured public review link
 *       │            (review_url) + record review_link_sent_at
 *       └─ NEGATIVE → create an internal customer-service human task;
 *                     NO public review link is ever sent
 *       └─ UNKNOWN  → stored; no further action (never guess)
 *
 * Every send goes through the mock SMS/email providers and is logged to
 * agent_actions (spec §26). REVIEW_REQUESTED is emitted when the feedback
 * request is sent (spec §30). Negative feedback raises a HUMAN_ESCALATION via
 * createHumanTaskRecord (spec §18).
 */
import * as repo from "../db/repo";
import { isAgentEnabled } from "../platform/settings";
import { getEmailProvider, getSmsProvider } from "../integrations";
import { emitEvent } from "../ai/events";
import { createHumanTaskRecord } from "../ai/tools/registry";
import { recordSmsUsage } from "../usage/record";
import type { ReviewSentiment } from "../db/schema";

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Sentiment classification (deterministic keyword scoring — mock-LLM)
// ---------------------------------------------------------------------------

const POSITIVE_WORDS = [
  "great", "amazing", "excellent", "awesome", "fantastic", "wonderful", "happy", "satisfied",
  "love", "loved", "recommend", "thank", "thanks", "perfect", "best", "friendly", "professional",
  "quick", "good", "nice", "helpful", "prompt", "smooth", "pleased", "outstanding",
];
const NEGATIVE_WORDS = [
  "bad", "poor", "awful", "terrible", "worst", "horrible", "disappointed", "disappointing",
  "upset", "angry", "rude", "late", "damage", "damaged", "refund", "unprofessional",
  "issue", "problem", "never", "broke", "broken", "sloppy", "unhappy", "worse", "terrible",
  "complaint", "unacceptable", "dissatisfied",
];

function wordHits(text: string, words: string[]): number {
  const lower = ` ${text.toLowerCase()} `;
  let hits = 0;
  for (const w of words) {
    const re = new RegExp(`[^a-z]${w}[^a-z]`, "g");
    const m = lower.match(re);
    if (m) hits += m.length;
  }
  return hits;
}

/** Deterministic sentiment from a customer's feedback text. */
export function classifySentiment(text: string): ReviewSentiment {
  const t = text.trim();
  if (!t) return "unknown";
  const pos = wordHits(t, POSITIVE_WORDS);
  const neg = wordHits(t, NEGATIVE_WORDS);
  if (pos > neg) return "positive";
  if (neg > pos) return "negative";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Channels — every send is provider-mediated + audit-logged (spec §26)
// ---------------------------------------------------------------------------

async function sendViaChannel(
  businessId: string,
  lead: { id: string; firstName: string; phone: string | null; email: string | null },
  opts: { smsBody: string; emailSubject: string; emailHtml: string; action: string; templateKey: string }
): Promise<{ channel: "sms" | "email" | "none"; provider: string; id: string }> {
  if (lead.phone) {
    const res = await getSmsProvider().send({ to: lead.phone, body: opts.smsBody });
    await repo.logAgentAction(businessId, {
      agent: "review",
      action: "send_sms",
      leadId: lead.id,
      input: { to: lead.phone, templateKey: opts.templateKey, body: opts.smsBody },
      result: { provider: getSmsProvider().name, id: res.id },
      success: true,
    });
    // Spec §32 — every SMS send counts toward the monthly usage budget.
    await recordSmsUsage({ businessId, leadId: lead.id, agent: "review", body: opts.smsBody, meta: { templateKey: opts.templateKey } });
    return { channel: "sms", provider: getSmsProvider().name, id: res.id };
  }
  if (lead.email) {
    const res = await getEmailProvider().send({ to: lead.email, subject: opts.emailSubject, html: opts.emailHtml });
    await repo.logAgentAction(businessId, {
      agent: "review",
      action: "send_email",
      leadId: lead.id,
      input: { to: lead.email, templateKey: opts.templateKey, subject: opts.emailSubject },
      result: { provider: getEmailProvider().name, id: res.id },
      success: true,
    });
    return { channel: "email", provider: getEmailProvider().name, id: res.id };
  }
  return { channel: "none", provider: "", id: "" };
}

// ---------------------------------------------------------------------------
// Feedback request (after the configured delay post JOB_COMPLETED)
// ---------------------------------------------------------------------------

export interface ReviewRequestResult {
  status: "sent" | "skipped" | "already-requested";
  reviewId?: string;
  channel?: "sms" | "email" | "none";
  reason?: string;
}

/**
 * Send the post-completed-job feedback request. Called by the automation
 * engine through the `send_review_request` tool (spec §21 + §29).
 *   - idempotent per appointment (one review row),
 *   - respects opt-outs and the business's review config (enabled / channel),
 *   - emits REVIEW_REQUESTED (spec §30).
 */
export async function requestReview(businessId: string, appointmentId: string): Promise<ReviewRequestResult> {
  // Spec §39 — the platform admin can disable the review agent globally.
  if (!(await isAgentEnabled("review"))) {
    await repo.logAgentAction(businessId, {
      agent: "review",
      action: "send_review_request",
      input: { appointmentId },
      result: { blocked: true, reason: "review-agent-disabled" },
      success: false,
    });
    return { status: "skipped", reason: "agent-disabled" };
  }
  const appointment = await repo.getAppointmentById(businessId, appointmentId);
  if (!appointment) return { status: "skipped", reason: "no-appointment" };
  if (appointment.status !== "completed") return { status: "skipped", reason: `appointment-${appointment.status}` };

  const existing = await repo.getReviewForAppointment(businessId, appointmentId);
  if (existing && existing.reviewRequestSentAt) return { status: "already-requested", reviewId: existing.id };

  const lead = appointment.leadId ? await repo.getLeadById(businessId, appointment.leadId) : null;
  if (!lead) return { status: "skipped", reason: "no-lead" };
  if (lead.optedOut === 1) return { status: "skipped", reason: "opted-out" };

  const config = await repo.getReviewConfig(businessId);
  if (config.enabled !== 1) return { status: "skipped", reason: "review-disabled" };
  if (!lead.phone && !lead.email) return { status: "skipped", reason: "no-channel" };

  // Idempotent row exists but request not marked sent (retry-safe).
  const review = existing ?? (await repo.createReview({ businessId, leadId: lead.id, appointmentId }));
  if (!review) return { status: "skipped", reason: "create-failed" };

  const service = appointment.serviceId ? await repo.getServiceById(businessId, appointment.serviceId) : null;
  const business = await repo.getBusinessById(businessId);
  const businessName = business?.name ?? "Your service provider";
  const first = lead.firstName || "there";
  const serviceName = service?.name ?? "your service";

  // Spec §21 message — asks for feedback, never pressures for a review.
  const smsBody = `Hi ${first}, we hope everything went well with your ${serviceName}. We'd love to hear how your experience was — reply and let us know. (Reply STOP to opt out.)`;
  const emailSubject = `How was your ${serviceName}?`;
  const emailHtml = `<p>Hi ${first},</p><p>We hope everything went well with your ${serviceName}. We'd love to hear how your experience was — just reply to this email.</p><p style="color:#888;font-size:12px">${businessName} via LeadFlow AI. Reply "STOP" to opt out.</p>`;

  const sent = await sendViaChannel(businessId, lead, {
    smsBody,
    emailSubject,
    emailHtml,
    action: "send_review_request",
    templateKey: "review_feedback_request",
  });
  if (sent.channel === "none") return { status: "skipped", reason: "no-channel" };

  await repo.updateReview(businessId, review.id, { reviewRequestSentAt: repo.now() });
  await repo.createNotification(businessId, {
    kind: "review",
    title: `Feedback request sent — ${lead.firstName} ${lead.lastName}`.trim(),
    body: `${serviceName} · ${sent.channel.toUpperCase()}`,
  });
  await repo.logAgentAction(businessId, {
    agent: "review",
    action: "review_requested",
    leadId: lead.id,
    input: { appointmentId, serviceId: appointment.serviceId ?? null },
    result: { reviewId: review.id, channel: sent.channel, delayDays: config.delayDays },
    success: true,
  });
  await emitEvent({
    type: "REVIEW_REQUESTED",
    businessId,
    leadId: lead.id,
    payload: { reviewId: review.id, appointmentId, channel: sent.channel, serviceName },
  });

  return { status: "sent", reviewId: review.id, channel: sent.channel };
}

// ---------------------------------------------------------------------------
// Feedback response (the reply channel — conversation message endpoint or
// POST /api/reviews/feedback)
// ---------------------------------------------------------------------------

export interface FeedbackResult {
  reviewId: string;
  sentiment: ReviewSentiment;
  reviewLinkSent: boolean;
  humanTaskCreated: boolean;
  message: string;
}

/**
 * Record the customer's feedback reply and act on it (spec §21):
 *   positive → send the configured public review link (never before feedback),
 *   negative → internal customer-service task, NO public review link,
 *   unknown  → stored, no further action.
 * Called through the `record_feedback` tool (validated + audited).
 */
export async function recordFeedback(businessId: string, reviewId: string, feedbackText: string): Promise<FeedbackResult> {
  const review = await repo.getReviewById(businessId, reviewId);
  if (!review) throw new Error("Review not found");
  if (review.sentiment !== "unknown") {
    return {
      reviewId: review.id,
      sentiment: review.sentiment as ReviewSentiment,
      reviewLinkSent: !!review.reviewLinkSentAt,
      humanTaskCreated: false,
      message: "feedback already recorded",
    };
  }
  const lead = await repo.getLeadById(businessId, review.leadId);
  if (!lead) throw new Error("Lead not found");

  const sentiment = classifySentiment(feedbackText);
  let reviewLinkSent = false;
  let humanTaskCreated = false;

  if (sentiment === "positive") {
    const business = await repo.getBusinessById(businessId);
    const config = await repo.getReviewConfig(businessId);
    // The business's configured public review link — fall back to their
    // website, then a LeadFlow review page (never invented).
    const reviewUrl =
      config.reviewUrl ||
      business?.website ||
      `https://reviews.leadflow.app/b/${businessId}`;
    const first = lead.firstName || "there";
    const smsBody = `Thanks so much, ${first}! We're glad you had a great experience. If you're willing, we'd appreciate a quick review: ${reviewUrl} (Reply STOP to opt out.)`;
    const emailSubject = "Thanks for your feedback!";
    const emailHtml = `<p>Hi ${first},</p><p>Thank you for your feedback — we're glad to hear it!</p><p>If you're willing, we'd appreciate a quick review: <a href="${reviewUrl}">${reviewUrl}</a></p><p style="color:#888;font-size:12px">Sent by LeadFlow AI. Reply "STOP" to opt out.</p>`;
    const sent = await sendViaChannel(businessId, lead, {
      smsBody,
      emailSubject,
      emailHtml,
      action: "send_review_link",
      templateKey: "review_link_positive",
    });
    reviewLinkSent = sent.channel !== "none";
    await repo.updateReview(businessId, review.id, { feedbackText, sentiment, reviewLinkSentAt: reviewLinkSent ? repo.now() : null });
    await repo.createNotification(businessId, {
      kind: "review",
      title: `Positive feedback — ${lead.firstName} ${lead.lastName}`.trim(),
      body: `Review link sent · "${feedbackText.slice(0, 80)}${feedbackText.length > 80 ? "…" : ""}"`,
    });
  } else if (sentiment === "negative") {
    // Internal customer-service task — NEVER request a public review.
    await repo.updateReview(businessId, review.id, { feedbackText, sentiment });
    await createHumanTaskRecord(businessId, {
      leadId: lead.id,
      priority: "medium",
      reason: `Negative feedback after completed job: ${feedbackText.slice(0, 300)}`,
      conversationSummary: `Customer feedback (review ${review.id.slice(0, 8)}): ${feedbackText.slice(0, 500)}`,
      recommendedAction: "Reach out to the customer to address their concern. Do NOT request a public review.",
    });
    humanTaskCreated = true;
    await repo.createNotification(businessId, {
      kind: "review",
      title: `Negative feedback — ${lead.firstName} ${lead.lastName}`.trim(),
      body: `Customer service task created · "${feedbackText.slice(0, 80)}${feedbackText.length > 80 ? "…" : ""}"`,
    });
  } else {
    await repo.updateReview(businessId, review.id, { feedbackText, sentiment });
  }

  await repo.logAgentAction(businessId, {
    agent: "review",
    action: "record_feedback",
    leadId: lead.id,
    input: { reviewId: review.id, feedbackText: feedbackText.slice(0, 500) },
    result: { sentiment, reviewLinkSent, humanTaskCreated },
    success: true,
  });

  const message =
    sentiment === "positive"
      ? "Thanks for your feedback! If you'd like to share your experience, we've sent you a review link."
      : sentiment === "negative"
        ? "We're sorry to hear that — someone from our team will reach out to make things right."
        : "Thanks for your feedback — we've passed it along.";
  return { reviewId: review.id, sentiment, reviewLinkSent, humanTaskCreated, message };
}

export const REVIEW_DELAY_DEFAULT_DAYS = 1;
export const REVIEW_DAY_MS = DAY_MS;
