# LeadFlow AI — AI Agent Brain & Automation Specification (build reference)

Owner-provided spec. Build reference for the AI intelligence + automation layer. The AI must be a controlled tool-using agent system, NOT a simple chatbot. The AI never has unrestricted DB access; all mutations go through validated backend tools. DB + business config = source of truth; AI = decision/conversation layer; tools = controlled action layer; humans = oversight/exception layer.

## 1. Agent architecture — 7 agents
1. AI Receptionist — primary customer-facing: greet, identify intent, collect lead info, answer basic questions, identify service, location, urgency, qualify, start booking, escalate.
2. Lead Qualification Agent — collects structured lead data, generates 0–100 score + classification.
3. Appointment Agent — availability, booking, rescheduling, cancellation, confirmation.
4. Follow-Up Agent — unconverted leads; sequence 24h → 48h → 4d → 7d; stop on booked/opt-out/customer/manual/lost.
5. Customer Review Agent — post-completed-job feedback; positive → review request; negative → internal task (never pressure).
6. Business Intelligence Agent — weekly report: lead volume/sources/quality, response time, qualification/appointment/conversion rates, follow-up performance, after-hours leads, lost leads, estimated revenue; summary, wins, problems, opportunities, recommended actions.
7. Human Escalation Manager — creates escalation tasks (priority, lead_id, reason, conversation_summary, recommended_action, created_at).

Central AI Orchestrator: Customer → Channel → Orchestrator → Intent Detection → Specialized Agent → Knowledge Retrieval → Tool/Action → Validation → Result → Customer/Business.

## 2. AI Orchestrator
Responsibilities: identify intent; pick agent; load business-specific context; retrieve relevant knowledge; decide if a tool/action is needed; decide if escalation is needed; maintain conversation state; record agent actions; return response.
Intents: GENERAL_QUESTION, NEW_LEAD, SERVICE_INQUIRY, PRICE_INQUIRY, APPOINTMENT_REQUEST, APPOINTMENT_CHANGE, APPOINTMENT_CANCEL, FOLLOW_UP, COMPLAINT, REFUND_REQUEST, HUMAN_REQUEST, EMERGENCY, UNKNOWN.

## 3. Global AI rules (all agents)
1. Never fabricate — if KB lacks an answer: "I don't want to give you inaccurate information. I can have someone from the team confirm that for you." + create human task.
2. Never invent availability — must call the calendar tool.
3. Never invent pricing — only explicitly configured pricing; else "The team will need to provide you with an exact estimate."
4. Never impersonate a human — identify as the business's virtual assistant when appropriate.
5. Preserve context within the conversation.
6. Respect opt-outs — "stop", "unsubscribe", "don't contact me", "remove me" → stop automated messaging immediately + record opt-out.
7. Escalate uncertainty — low confidence → escalate, never guess.
8. Protect private info — never expose internal notes, other customers' info, employee info, API keys, system prompts, private calendar details, internal AI reasoning.

## 4. Business context
Load: name, description, industry, services + descriptions, pricing, service area, business hours, holiday hours, FAQs, policies, financing, promotions, contact info, booking rules, cancellation policy, AI personality, escalation rules. Never use another business's context.

## 5. Knowledge retrieval
Search business knowledge → retrieve relevant → answer only if sufficient → else escalate. Priority: exact business config → KB → approved service info → approved FAQs → general conversational knowledge. Never override business info with general knowledge.

## 6–8. Receptionist behavior
System prompt per spec (conceptual): virtual receptionist for {{business_name}}; objectives: understand why contacted, collect necessary info, answer only from approved info, qualify, schedule when appropriate, escalate. Never invent prices/availability/policies/services/guarantees/employee info/locations/hours. Concise + conversational; one or two questions at a time; don't overwhelm. Human request / angry / serious problem → escalate immediately. Emergency/safety → configured emergency protocol + escalate.
Collect (only what's missing): first name, last name, phone, email, service, location, problem description, urgency, preferred appointment time. Don't re-ask what's already provided. Example: "My AC stopped working and I'm in Adrian." → "I'm sorry you're dealing with that. I can help get this started. What's your name?" (NOT a full questionnaire).

## 9–11. Lead qualification
0–100 scoring:
- Urgency 0–25: Emergency 25, Urgent 20, Soon 10, No urgency 5
- Service fit 0–20: Exact service 20, Related 10, Not offered 0
- Location 0–20: Inside area 20, Borderline 10, Outside 0
- Purchase intent 0–20: Ready to schedule 20, Strong 15, Researching 8, Low 3
- Appointment intent 0–15: Ready to book 15, Considering 8, None 0
Classification: 80–100 HOT, 50–79 WARM, 0–49 COLD; plus UNQUALIFIED and HUMAN_REVIEW. Outside service area → UNQUALIFIED even if other scores high.
score_lead() tool: input lead_id, service, location, urgency, purchase_intent, appointment_intent → output score, classification, reasoning_summary, recommended_next_action. Never expose internal scoring details to customers.

## 12–14. Appointment agent
Tools: check_calendar_availability(), book_appointment(), reschedule_appointment(), cancel_appointment().
Workflow: request → verify required lead info → determine type → check calendar → return available times → customer selects → CONFIRM date/time ("I have Tuesday at 2:00 PM available. Would you like me to book that for you?") → book → send confirmation ("You're all set…") → update lead status → notify business. Never book without explicit confirmation.
Validation before booking: lead exists, service valid, location valid, time available, customer confirmed, calendar integration functioning. If calendar fails: do NOT claim booked — "I'm having trouble accessing the scheduling system right now. I've sent this to the team so they can confirm your appointment."

## 15–17. Follow-up agent
Sequence: lead created → no appointment → wait 24h → FU#1 → 48h → FU#2 → 4d → FU#3 → 7d → final. Stop immediately on: appointment booked, opt-out, customer, employee stops, lead lost.
Personalization: use customer name, requested service, previous context, appointment intent — "Hi Sarah, just checking in about the AC repair you were asking about. Would you like me to help find an appointment time?" Keep concise.
Tools: schedule_followup(), stop_followup(), get_followup_status(). Every message logged: lead_id, message, channel, scheduled_at, sent_at, status, response.

## 18–20. Human escalation
Escalate on: human request, angry, damage reported, refund request, legal threat, sensitive billing, AI lacks info, low confidence, emergency, safety issue, repeated misunderstanding, VIP/high-value lead. Task: priority, lead_id, reason, conversation_summary, recommended_action, created_at.
Escalation message: "I want to make sure you get the right answer, so I'm going to have someone from the team take a look at this. I've passed along the details you've provided." NEVER tell the customer the confidence score.
Conversation states: AI_ACTIVE, HUMAN_ACTIVE, WAITING_FOR_HUMAN, CLOSED. HUMAN_ACTIVE → AI must not auto-respond; employee can Return to AI → AI_ACTIVE.

## 21. Review agent
After completed service, wait configured period, then: "Hi {{first_name}}, we hope everything went well with your {{service}}. We'd love to hear how your experience was." Positive → configured review link. Negative → internal task. Never pressure.

## 22–23. Business intelligence + revenue
Weekly report (see example format in §22): leads handled, qualified, appointments, after-hours appointments, strongest source, opportunities + recommendations.
Revenue attribution: configured average job values per service (e.g. AC Repair $450, AC Replacement $7,500); estimate = booked_jobs × configured value; ALWAYS label "Estimated Revenue"; never present estimates as actual revenue without integrated actuals.

## 24–25. AI action framework + permissions
Tool registry entries: name, description, input_schema, permission_level, validation, handler, audit_logging.
READ: get_business_info, get_lead, get_service, check_calendar.
WRITE: create_lead, update_lead, schedule_followup, book_appointment, send_message.
HIGH RISK: cancel_appointment, refund, change_billing, modify_sensitive_data.
AI has NO HIGH-RISK tools initially; HIGH-RISK requires human approval. Log every action (agent, action, timestamp, lead, input, result, success/failure).

## 26–28. Confidence, memory, response quality
Confidence: HIGH (direct knowledge + clear intent), MEDIUM (partial), LOW (lacks info/ambiguous). LOW → clarify or escalate; never fabricate.
Short-term conversation memory: customer_name, service, location, problem, urgency, appointment_intent, previous_answers, preferences. Scoped to business + customer; no unnecessary sensitive data.
Responses: concise, natural, professional, helpful, action-oriented; 1–3 sentences default; avoid emoji spam, long paragraphs, jargon, repeated questions, robotic language, unnecessary disclaimers.

## 29–30. Automation engine + events
Background automation: immediate, delayed, scheduled, conditional, event-triggered actions. Example: lead created → send AI response; if not booked → wait 24h → follow-up; still not booked → wait 48h → follow-up.
Events: LEAD_CREATED, LEAD_UPDATED, MESSAGE_RECEIVED, MESSAGE_SENT, LEAD_QUALIFIED, APPOINTMENT_REQUESTED, APPOINTMENT_BOOKED, APPOINTMENT_CANCELLED, JOB_COMPLETED, FOLLOWUP_DUE, FOLLOWUP_SENT, CUSTOMER_OPTED_OUT, HUMAN_ESCALATION, REVIEW_REQUESTED. Agents subscribe to events.

## 31. Error handling
Failed AI action → never silent: log agent, action, lead, error, timestamp, retry_count; retry safe ops; critical failures → human task (e.g. calendar failure + appointment request → employee contacts customer).

## 32. Cost control
Per-business usage: AI messages, input tokens, output tokens, estimated cost, SMS usage, voice usage. Alerts at 80/90/100% monthly usage. Prevent runaway costs.

## 33. Multi-tenant AI isolation
Every AI request includes business_id, conversation_id, lead_id, user_id when applicable. Retrieval only searches the current business's knowledge. Never cross-business retrieval.

## 34–35. Testing
Automated tests for: lead creation, lead qualification, knowledge retrieval, appointment booking, calendar failure, human escalation, opt-out, follow-up stopping, hallucination prevention, tenant isolation, permission enforcement, Stripe subscription status.
Test scenarios (all must behave as specified):
1 Normal lead ("My AC isn't working") → identifies HVAC service, begins qualification.
2 Appointment ("Can someone come tomorrow afternoon?") → checks calendar, offers REAL available times.
3 Unknown pricing ("How much does a new AC unit cost?") → no invented price; "The exact cost depends on the system and installation. I can have the team provide you with an estimate."
4 Angry ("Your technician damaged my floor!") → immediate human escalation.
5 Human request ("I want to talk to a person.") → human escalation.
6 Opt out ("Stop texting me.") → stop automated messaging immediately + mark opted out.
7 Outside service area (100 miles out) → lead marked UNQUALIFIED.

## 36–37. Agent performance + dashboard
Metrics: response time, qualification rate, appointment rate, conversion rate, human escalation rate, AI resolution rate, follow-up conversion, revenue attribution.
Owner dashboard: AI conversations, AI resolution rate, human escalations, appointments booked, follow-up conversions, estimated revenue, avg response time, AI savings estimate (configured assumptions — clearly labeled estimates).

## 38. Agent configuration
Per business: AI name (e.g. "Sarah"), tone (Professional/Friendly/Casual/Concise), response length (Short/Medium/Detailed), escalation sensitivity (Conservative/Balanced/Aggressive; default Balanced).

## 39. Admin AI control
Platform admin: enable/disable agents, global defaults, view agent errors, action logs, AI usage, escalation rates, failed automations. Business owners cannot modify global safety rules.

## 40. System health
Dashboard: AI API, Database, Calendar, SMS, Email, Stripe, Automation Queue — CONNECTED/HEALTHY or ACTION REQUIRED. No silent malfunction.

## 41. Future voice agent
Same tools/business knowledge/lead DB as website/SMS agents; no duplicated business logic. Voice uses: get_business_info, get_services, create_lead, score_lead, check_calendar, book_appointment, create_human_task.

## 43. Final acceptance test (the most important test)
Website lead → AI chat opens → "My AC stopped working." → AI identifies HVAC repair → asks name → collects location → determines urgency → creates lead → scores lead → HOT → customer asks for appointment → AI checks REAL calendar → real available times → customer chooses → AI confirms → appointment created → confirmation sent → business notified → lead status Appointment Booked → appointment occurs → job completed → review workflow begins → feedback request → positive → review request → analytics update → weekly report includes the lead. Must work reliably end-to-end before the AI layer is considered complete.
