# LeadFlow AI — Build Specification (condensed reference)

Authoritative source: owner's build spec. This file is the working reference for all team members.

## Product
AI-powered lead conversion + appointment booking SaaS for local service businesses (HVAC, plumbing, roofing, landscaping, cleaning, auto repair, restoration, home services).
Business model: setup fee $1,500–$3,000; subscription $500–$1,500/month.
Core workflow: Lead enters → AI responds → AI qualifies → AI answers questions → AI books appointment → CRM updated → reminders sent → follow-up automated → owner notified → performance tracked. AI handles routine interactions; escalates unusual/sensitive/high-value situations to humans.

## User roles
- **Platform admin**: all customers, subscriptions, system activity, AI usage, revenue, plans, integrations, disable accounts, errors, agent performance.
- **Business owner**: business profile, services, service areas, hours, pricing, connect calendar/CRM/SMS, leads, conversations, appointments, analytics, AI agent config, follow-ups, team members.
- **Business employee**: assigned leads, conversations, appointments, update lead status, notes, manually take over conversations. NO billing/platform settings.

## Main pages
Public: Landing, Pricing, Features, Contact, Login, Sign Up, Terms, Privacy.
App: Dashboard, Leads, Conversations, Appointments, Follow-Ups, AI Agents, Knowledge Base, Analytics, Integrations, Settings, Billing.
Dashboard cards: Leads, Qualified, Appointments, Conversion %, Est. Revenue; funnel Leads → Qualified → Appointments → Customers; charts (leads/appointments over time, conversion, lead sources, revenue attribution, AI vs human).

## Lead management
Fields: ID, first/last name, phone, email, source, service requested, location, status, score, conversation history, notes, assigned employee, appointment, created date, last contacted, next follow-up, estimated value.
Statuses: New, Contacted, Qualified, Appointment Booked, Customer, Lost, Unqualified, Needs Human Attention.
Score: HOT (high purchase intent), WARM (interested, not ready), COLD (low intent). Display prominently.

## AI agents (6)
1. **Receptionist**: respond to leads, answer questions, collect contact info, identify service, location, urgency, explain services, business hours, start booking, escalate. Tone: professional/friendly/concise. Never claim what the KB doesn't contain; if unknown: "I'm not certain about that, but I can have someone from the team help you."
2. **Qualification**: collect name, phone, email, service, property/business type, location, urgency, preferred time, project details, budget when appropriate → generate score, status, estimated value.
3. **Appointment**: check availability → offer options → confirm → create → send confirmation → update lead status → notify business. NEVER invent availability.
4. **Follow-up**: default sequence after 1, 3, 7, 14 days; stop on booked/customer/opt-out/manual stop; owner-customizable.
5. **Review**: after job completed ask feedback; positive → request public review; negative → do NOT request review, notify business, create customer service task.
6. **Business intelligence**: weekly report (new leads, qualified, appointments, customers, lead-to-appointment rate, est. revenue, AI conversations, after-hours stats, top service, opportunity suggestions).

## Human escalation
Auto-escalate when: angry, legal threat, property damage, refund request, requests human, AI lacks info, sensitive billing, emergency/safety, low confidence. Needs Human Attention queue. Employee takes over; AI stops auto-responding until returned to AI.

## Knowledge base
Per-business: description, services + descriptions, pricing, service area, business hours, holiday hours, FAQs, policies, cancellation policy, financing, promotions, contact info. Document upload later. Strict isolation between businesses.

## Chat widget
Embeddable snippet: `<script src="https://app.leadflowai.com/widget.js" data-business-id="BUSINESS_ID"></script>`. Opens from website, business branding, collects lead info, chats with AI, creates lead, books appointments, syncs to CRM. Customizable: logo, name, welcome message, position, primary color.

## SMS / Email
SMS via Twilio or similar: inbound → AI response; outbound: lead responses, appointment confirmations, reminders, follow-ups, review requests. Opt-out handling; consent requirements respected. Email: lead/appointment confirmations, reminders, follow-ups, review requests, weekly report; reusable templates.

## Integrations
Integration layer; initially one CRM (sync contacts, leads, notes, appointments, status). Future: HubSpot, GoHighLevel, Salesforce, Pipedrive. Calendar: Google Calendar initially (read availability, create/modify/cancel; never expose private info). Never expose API keys in frontend code.

## Billing (Stripe)
Starter $497/mo: AI receptionist, website chat, lead qualification, basic follow-up, appointment booking, basic analytics.
Professional $997/mo: + SMS, advanced follow-up, CRM integration, review automation, advanced analytics, multiple users.
Premium $1,497/mo: + AI voice receptionist, advanced integrations, custom workflows, priority support, advanced reporting.
Monthly billing initially; annual later.

## Admin dashboard
Revenue: MRR, ARR, active subscriptions, churn, new customers. Usage: AI messages, SMS, voice minutes, API usage, cost estimates. Customers: total/active/trial/cancelled businesses. System: failed automations, API errors, AI failures, integration failures.

## Database (PostgreSQL)
Entities: Users, Businesses, TeamMembers, Leads, Conversations, Messages, Appointments, Services, KnowledgeBase, FollowUps, AI_Agents, AgentActions, Integrations, Subscriptions, Payments, Notifications, Reviews, Analytics, AuditLogs. Every business-owned record carries business_id; strict tenant isolation.

## Security
Secure auth, RBAC, password hashing, session management, API key protection, server-side authorization, input validation, rate limiting, audit logging, tenant isolation, webhook verification, env vars for secrets.

## AI safety rules
1. Never fabricate business info. 2. Never invent availability. 3. Never promise pricing unless configured. 4. Never make legal/medical/financial claims. 5. Escalate uncertainty. 6. Respect opt-outs. 7. Maintain context. 8. Identify as AI when appropriate. 9. Log AI actions. 10. Humans can override.

## AI action framework
Agents call validated backend functions only (never direct DB): create_lead, update_lead, score_lead, get_business_information, check_calendar, book_appointment, cancel_appointment, send_sms, send_email, schedule_followup, stop_followup, create_human_task, notify_employee, update_crm. Log every action (agent, action, timestamp, lead, input, result, success/failure).

## Landing page
Hero: "Turn More Leads Into Customers—Automatically." Sub: "AI-powered lead response, qualification, appointment booking, and follow-up for local businesses." CTAs: Start Free / Watch Demo. Sections: Problem, Solution, How It Works, AI Agents, Dashboard Demo, Benefits, Pricing, FAQ, CTA. Benefits: instant response, more appointments, auto follow-up, never miss after-hours leads, less admin work, know lead sources.

## Onboarding (10 steps)
Business info → Services → Service area → Business hours → Knowledge base → Calendar connection → SMS connection → AI configuration → Install widget → Test AI. Ends with "Your AI receptionist is ready."

## Demo mode
Smith's HVAC: fake services, pricing, hours, calendar, sample leads, sample conversations; interact with AI receptionist; NO real customer data.

## MVP phases
- P1: Auth, business accounts, dashboard, leads, AI receptionist, knowledge base, conversations, basic appointment booking.
- P2: SMS, follow-up automation, calendar integration, email, human takeover.
- P3: Stripe, analytics, admin dashboard, CRM integration, review automation.
- P4: Voice, advanced analytics, multiple CRMs, white-labeling, advanced workflows.

## Technical principles
Real DB operations, auth, AI API calls, calendar/messaging APIs, Stripe subscriptions, webhooks, background jobs, scheduled tasks. Where credentials unavailable: defined integration interfaces + mock services replaceable with production credentials. NOT a static mockup. Scalable, tenant-isolated, extensible without rewrites.

## MVP success criteria (operational when all 20 work)
1 create account, 2 create business, 3 add services, 4 add business info, 5 configure AI, 6 create test lead, 7 AI communicates with lead, 8 qualify lead, 9 score lead, 10 check calendar availability, 11 book appointment, 12 create follow-up tasks, 13 view conversation, 14 take over conversation manually, 15 view analytics, 16 connect Stripe, 17 create paid subscription, 18 install website widget, 19 receive real website lead, 20 AI processes it automatically.

## Long-term vision
Vertical AI OS for local service businesses: phone receptionist, SMS agent, website agent, sales agent, appointment setter, review manager, marketing assistant, reporting agent, customer service agent, reactivation agent. First version's one job: generate measurable additional revenue for the business.
