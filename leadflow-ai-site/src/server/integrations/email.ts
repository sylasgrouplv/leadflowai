/** Email provider — mock. Real provider (SendGrid/Resend) later: same interface, env swap. */
import type { EmailProvider, EmailMessage } from "./types";
import { randomUUID } from "node:crypto";

export class MockEmailProvider implements EmailProvider {
  readonly name = "mock-email";
  async send(msg: EmailMessage) {
    console.log(`[mock-email] to=${msg.to} subject=${msg.subject}`);
    return { id: `mock_email_${randomUUID()}`, status: "delivered" as const };
  }
}
