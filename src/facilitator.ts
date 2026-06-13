import type { VerifyResponse, SettleResponse } from "./types.js";

/**
 * HTTP client for an x402 facilitator's /verify and /settle endpoints.
 * No API keys required — the default facilitators are permissionless.
 */
export class FacilitatorClient {
  private baseUrl: string;

  constructor(facilitatorUrl: string) {
    this.baseUrl = facilitatorUrl.replace(/\/$/, "");
  }

  async verify(
    paymentPayload: Record<string, unknown>,
    paymentRequirements: Record<string, unknown>,
  ): Promise<VerifyResponse> {
    const res = await fetch(`${this.baseUrl}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paymentPayload, paymentRequirements }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new FacilitatorError(
        `Facilitator /verify returned ${res.status}: ${text}`,
        res.status,
      );
    }

    return (await res.json()) as VerifyResponse;
  }

  async settle(
    paymentPayload: Record<string, unknown>,
    paymentRequirements: Record<string, unknown>,
  ): Promise<SettleResponse> {
    const res = await fetch(`${this.baseUrl}/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paymentPayload, paymentRequirements }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new FacilitatorError(
        `Facilitator /settle returned ${res.status}: ${text}`,
        res.status,
      );
    }

    return (await res.json()) as SettleResponse;
  }
}

export class FacilitatorError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "FacilitatorError";
    this.status = status;
  }
}
