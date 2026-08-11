/** SMS provider — mock. Real provider (Twilio) later: same interface, env swap. */
import type { SmsProvider, SmsMessage } from "./types";
import { randomUUID } from "node:crypto";

export class MockSmsProvider implements SmsProvider {
  readonly name = "mock-sms";
  async send(msg: SmsMessage) {
    console.log(`[mock-sms] to=${msg.to} body=${msg.body.slice(0, 80)}`);
    return { id: `mock_sms_${randomUUID()}`, status: "delivered" as const };
  }
}
