/** Configuration for a payment-gated endpoint. */
export interface PaymentPathConfig {
  /** Price in human-readable USD format, e.g. "$1.00". */
  price: string;
  /** Wallet address that receives payment (EVM default). */
  payTo: string;
  /** Accepted stablecoins, networks, and facilitators. */
  accepts: AcceptedAsset[];
  /** Called after payment is settled on-chain.
   *  Return value becomes the 200 response body (JSON).
   *  Receipt includes the settlement tx hash. */
  onFulfill: FulfillmentHandler;
  /** Describes expected fields in the request body.
   *  Included in the 402 response so agents can self-discover what to send. */
  fields?: FieldSchema[];
}

/** A stablecoin + network + facilitator combination the server accepts. */
export interface AcceptedAsset {
  /** Token contract address, e.g. "0x833589f..." or Solana mint address. */
  asset: string;
  /** Network short name matching the x402 SDK, e.g. "base", "solana", "radius". */
  network: string;
  /** Facilitator URL for verify and settle, e.g. "https://x402.stablecoin.xyz". */
  facilitatorUrl: string;
  /** Override payTo for this asset/network (e.g. Solana address vs EVM address).
   *  Falls back to the top-level `payTo` if not set. */
  payTo?: string;
  /** Token decimals for converting USD price to atomic units (default: 6). */
  decimals?: number;
  /** On-chain facilitator signer address (included in the 402 requirement). */
  facilitatorAddress?: string;
  /** Token metadata passed in the `extra` field (e.g. `{ name: "Stable Coin" }`). */
  extra?: Record<string, unknown>;
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
  /** Max character length. Enforced server-side before fulfillment. */
  maxLength?: number;
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
  valid?: boolean;
  isValid?: boolean;
  invalidReason?: string;
  payer?: string;
}

/** Facilitator /settle response. */
export interface SettleResponse {
  success: boolean;
  txHash?: string;
  transaction?: string;
  network?: string;
  error?: string;
  errorReason?: string;
}
