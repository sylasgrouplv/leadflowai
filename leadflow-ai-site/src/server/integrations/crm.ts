/** CRM provider — mock. Real provider (HubSpot / HighLevel / Salesforce) later. */
import type { CrmProvider, CrmLead } from "./types";
import { randomUUID } from "node:crypto";

export class MockCrmProvider implements CrmProvider {
  readonly name = "mock-crm";
  async syncLead(lead: CrmLead) {
    return { ok: true as const, externalId: `mock_crm_${randomUUID()}` };
  }
  async updateLeadStatus(leadId: string, status: string) {
    return { ok: true as const };
  }
}
