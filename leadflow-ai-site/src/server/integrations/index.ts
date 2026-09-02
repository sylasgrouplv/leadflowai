/**
 * Provider factories — env-var-driven selection.
 *
 *   AI_PROVIDER=mock          (default) | openai | anthropic (future)
 *   SMS_PROVIDER=mock         (default) | twilio (future)
 *   EMAIL_PROVIDER=mock       (default) | sendgrid (future)
 *   CALENDAR_PROVIDER=mock    (default) | google (future)
 *   CRM_PROVIDER=mock         (default) | hubspot (future)
 *   STRIPE_PROVIDER=mock      (default) | live (future)
 *   WEBFETCH_PROVIDER=mock    (default) | live (future)
 *   SOCIAL_PROVIDER=mock      (default) | live (future)
 *
 * Swapping a provider to a real implementation later = write the class
 * (same interface from ./types), then flip the env var. App code calls the
 * factory, never constructs providers directly.
 */
import type { AiProvider, SmsProvider, EmailProvider, CalendarProvider, CrmProvider, StripeProvider, WebFetchProvider, SocialProvider } from "./types";
import { MockAiProvider } from "./ai";
import { OpenAiProvider } from "./openai";
import { AnthropicProvider } from "./anthropic";
import { MockSmsProvider } from "./sms";
import { MockEmailProvider } from "./email";
import { MockCalendarProvider } from "./calendar";
import { MockCrmProvider } from "./crm";
import { HubSpotCrmProvider } from "./hubspot";
import { MockStripeProvider } from "./stripe";
import { MockWebFetchProvider } from "./webfetch";
import { MockSocialProvider } from "./social";
import { env } from "../env";

const ai: Record<string, () => AiProvider> = {
  mock: () => new MockAiProvider(),
  // Real LLM providers: registered + interface-complete, but they throw a
  // clear "set AI_API_KEY" error until a key is actually configured — the swap
  // is config-only and never a rewrite (owner decision).
  openai: () => new OpenAiProvider(),
  anthropic: () => new AnthropicProvider(),
};
const sms: Record<string, () => SmsProvider> = {
  mock: () => new MockSmsProvider(),
};
const email: Record<string, () => EmailProvider> = {
  mock: () => new MockEmailProvider(),
};
const calendar: Record<string, () => CalendarProvider> = {
  mock: () => new MockCalendarProvider(),
};
const crm: Record<string, () => CrmProvider> = {
  mock: () => new MockCrmProvider(),
  // Real CRM provider: registered + interface-complete, but it throws a clear
  // "set HUBSPOT_API_KEY" error until a key is configured (config-only swap).
  hubspot: () => new HubSpotCrmProvider(),
};
const stripe: Record<string, () => StripeProvider> = {
  mock: () => new MockStripeProvider(),
};
const webFetch: Record<string, () => WebFetchProvider> = {
  mock: () => new MockWebFetchProvider(),
};
const social: Record<string, () => SocialProvider> = {
  mock: () => new MockSocialProvider(),
};

function pick<T>(registry: Record<string, () => T>, kind: string, configured: string): T {
  const make = registry[configured];
  if (!make) {
    throw new Error(
      `Provider "${configured}" for ${kind} is not implemented yet. ` +
        `Available: ${Object.keys(registry).join(", ")}. Implement the class behind the same interface and add it to the registry.`
    );
  }
  return make();
}

// Singleton per process (providers may hold connection state).
let _ai: AiProvider | null = null;
let _sms: SmsProvider | null = null;
let _email: EmailProvider | null = null;
let _calendar: CalendarProvider | null = null;
let _crm: CrmProvider | null = null;
let _stripe: StripeProvider | null = null;
let _webFetch: WebFetchProvider | null = null;
let _social: SocialProvider | null = null;

export function getAiProvider(): AiProvider {
  return (_ai ??= pick(ai, "AI", env.aiProvider));
}
export function getSmsProvider(): SmsProvider {
  return (_sms ??= pick(sms, "SMS", env.smsProvider));
}
export function getEmailProvider(): EmailProvider {
  return (_email ??= pick(email, "email", env.emailProvider));
}
export function getCalendarProvider(): CalendarProvider {
  return (_calendar ??= pick(calendar, "calendar", env.calendarProvider));
}
export function getCrmProvider(): CrmProvider {
  return (_crm ??= pick(crm, "CRM", env.crmProvider));
}
export function getStripeProvider(): StripeProvider {
  return (_stripe ??= pick(stripe, "Stripe", env.stripeProvider));
}
export function getWebFetchProvider(): WebFetchProvider {
  return (_webFetch ??= pick(webFetch, "WebFetch", env.webFetchProvider));
}
export function getSocialProvider(): SocialProvider {
  return (_social ??= pick(social, "Social", env.socialProvider));
}
