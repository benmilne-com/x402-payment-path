/** Configuration for a payment-gated endpoint. */
export interface PaymentPathConfig {
  /** Price in human-readable USD format, e.g. "$1.00". */
  price: string;
  /** Wallet address that receives payment. */
  payTo: string;
  /** Accepted stablecoins, networks, and facilitators. */
  accepts: AcceptedAsset[];
  /** Called after payment is verified, before settlement.
   *  Return value becomes the 200 response body (JSON).
   *  Throw to reject fulfillment — payment will not be settled. */
  onFulfill: FulfillmentHandler;
  /** Describes expected fields in the request body.
   *  Included in the 402 response so agents can self-discover what to send. */
  fields?: FieldSchema[];
}

/** A stablecoin + network + facilitator combination the server accepts. */
export interface AcceptedAsset {
  /** Token name or contract address, e.g. "USDC" or "0x833589f...". */
  asset: string;
  /** CAIP-2 network identifier, e.g. "eip155:8453" for Base. */
  network: string;
  /** Facilitator URL for verify and settle, e.g. "https://x402.stablecoin.xyz". */
  facilitatorUrl: string;
}

/** Describes a field the agent should include in the request body. */
export interface FieldSchema {
  /** Key in the JSON body. */
  name: string;
  /** Expected value type. */
  type: "string" | "email" | "url";
  /** Whether the field must be present. */
  required: boolean;
  /** Machine-readable purpose of this field. */
  description: string;
}

/** Payload passed to the fulfillment handler after payment verification. */
export interface FulfillmentPayload {
  /** Parsed JSON body from the agent's request. */
  body: Record<string, unknown>;
  /** Original request headers. */
  headers: Record<string, string>;
  /** Client IP address, if available. */
  ip?: string;
  /** ISO 8601 timestamp of the request. */
  timestamp: string;
}

/** On-chain payment receipt returned by the facilitator. */
export interface PaymentReceipt {
  /** Settlement transaction hash. */
  txHash: string;
  /** CAIP-2 network where settlement occurred. */
  network: string;
  /** Asset that was transferred. */
  asset: string;
  /** Amount transferred (atomic units). */
  amount: string;
  /** Agent's wallet address (payer). */
  from: string;
  /** Merchant's wallet address (payee). */
  to: string;
}

export type FulfillmentHandler = (
  payload: FulfillmentPayload,
  receipt: PaymentReceipt,
) => Promise<unknown>;

/** Internal representation of the x402 payment payload from the agent. */
export interface X402PaymentPayload {
  x402Version: number;
  scheme: string;
  network: string;
  payload: Record<string, unknown>;
}

/** Facilitator /verify response. */
export interface VerifyResponse {
  valid: boolean;
  invalidReason?: string;
  payer?: string;
}

/** Facilitator /settle response. */
export interface SettleResponse {
  success: boolean;
  txHash?: string;
  network?: string;
  invalidReason?: string;
}
