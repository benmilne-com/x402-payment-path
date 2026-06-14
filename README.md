# x402-payment-path

Gate any action behind x402 stablecoin payments.

Agent-first. Server-side. No client UI. One function call.

Read the full write-up: [Talking to Agents](https://benmilne.com/talking-to-agents) — how this library was built, tested on chain, and what I learned.

```typescript
import { paymentPath } from "x402-payment-path";

export default {
  async fetch(request: Request, env: Env) {
    return paymentPath(request, {
      price: "$1.00",
      payTo: "0xYourWallet",
      accepts: [
        {
          asset: "0xfdcC3dd6671eaB0709A4C0f3F53De9a333d80798",
          network: "base",
          facilitatorUrl: "https://x402.stablecoin.xyz",
          decimals: 18,
          facilitatorAddress: "0xdeE710bB6a3b652C35B5cB74E7bdb03EE1F641E6",
          extra: { name: "Stable Coin" },
        },
      ],
      onFulfill: async (payload, receipt) => {
        return { status: "delivered", txHash: receipt.txHash };
      },
    });
  },
};
```

## What this does

An agent POSTs to your endpoint. No payment header? The server returns `402 Payment Required` with the price, accepted assets, and a machine-readable field schema. The agent reads the response, signs a stablecoin permit with its wallet, and retries with a `PAYMENT-SIGNATURE` header. The server verifies the signature through a facilitator, settles payment on-chain, runs your `onFulfill` callback, and returns a receipt.

One round-trip. No API keys. No credit cards. No accounts.

## How it works

```
Agent → POST (no payment)
Server → 402 + price + field schema
Agent → signs permit, retries with PAYMENT-SIGNATURE
Server → facilitator /verify → facilitator /settle → onFulfill
Server → 200 + receipt
```

The 402 response is self-describing — the agent discovers what to pay and what fields to send from a single response.

## Install

```bash
npm install x402-payment-path
```

## Configuration

### `PaymentPathConfig`

| Field | Type | Required | Description |
|---|---|---|---|
| `price` | `string` | Yes | Price in USD, e.g. `"$1.00"` |
| `payTo` | `string` | Yes | Your wallet address (EVM default) |
| `accepts` | `AcceptedAsset[]` | Yes | Stablecoins and networks you accept |
| `onFulfill` | `FulfillmentHandler` | Yes | Called after on-chain settlement |
| `fields` | `FieldSchema[]` | No | Describes expected request body fields |
| `deduplicationStore` | `DeduplicationStore` | No | Replay protection — rejects duplicate payment signatures |
| `onFulfillmentFailure` | `function` | No | Called when `onFulfill` throws after successful settlement |
| `corsOrigin` | `string` | No | CORS origin (`"*"` or specific). Default: no CORS headers |
| `maxBodyBytes` | `number` | No | Max request body size in bytes (default: 65536) |

### `AcceptedAsset`

| Field | Type | Required | Description |
|---|---|---|---|
| `asset` | `string` | Yes | Token contract address |
| `network` | `string` | Yes | Network short name: `"base"`, `"solana"`, `"radius"` |
| `facilitatorUrl` | `string` | Yes | Facilitator endpoint |
| `payTo` | `string` | No | Per-asset wallet override (e.g. Solana address) |
| `decimals` | `number` | No | Token decimals for price conversion (default: 6) |
| `facilitatorAddress` | `string` | No | On-chain facilitator signer address |
| `extra` | `object` | No | Token metadata, e.g. `{ name: "Stable Coin" }` |

**Important:** The `network` field uses short names (`"base"`, `"solana"`, `"radius"`), not CAIP-2 identifiers. The `asset` field must be the token contract address, not a human-readable name.

### Network reference

| Network | Short name | Contract addresses |
|---|---|---|
| Base | `"base"` | SBC: `0xfdcC3dd6671eaB0709A4C0f3F53De9a333d80798` (18 decimals) |
| Solana | `"solana"` | SBC: `DBAzBUXaLj1qANCseUPZz4sp9F8d2sc78C4vKjhbTGMA` (9 decimals) |
| Radius | `"radius"` | SBC: `0x33ad9e4BD16B69B5BFdED37D8B5D9fF9aba014Fb` (6 decimals) |

### `FieldSchema`

Included in the 402 response body so agents can self-discover what data to send.

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Key in the JSON body |
| `type` | `"string" \| "email" \| "url"` | Expected value type |
| `required` | `boolean` | Whether the field must be present |
| `description` | `string` | Machine-readable purpose |
| `maxLength` | `number` | Max character length (enforced server-side) |

### `FulfillmentHandler`

```typescript
type FulfillmentHandler = (
  payload: FulfillmentPayload,
  receipt: PaymentReceipt,
) => Promise<unknown>;
```

Called after payment is settled on-chain. The `receipt` includes the settlement transaction hash. The return value becomes the 200 response body.

## Multi-chain example

Accept SBC on both Base (EVM) and Solana with separate wallet addresses:

```typescript
{
  price: "$1.00",
  payTo: "0xYourEvmWallet",
  accepts: [
    {
      asset: "0xfdcC3dd6671eaB0709A4C0f3F53De9a333d80798",
      network: "base",
      facilitatorUrl: "https://x402.stablecoin.xyz",
      decimals: 18,
      facilitatorAddress: "0xdeE710bB6a3b652C35B5cB74E7bdb03EE1F641E6",
      extra: { name: "Stable Coin" },
    },
    {
      asset: "DBAzBUXaLj1qANCseUPZz4sp9F8d2sc78C4vKjhbTGMA",
      network: "solana",
      facilitatorUrl: "https://x402.stablecoin.xyz",
      payTo: "YourSolanaWallet",
      decimals: 9,
      facilitatorAddress: "2mSjKVjzRGXcipq3DdJCijbepugfNSJCN1yVN2tgdw5K",
    },
  ],
  onFulfill: async (payload, receipt) => {
    await db.insert("messages", {
      sender: payload.body.sender,
      body: payload.body.body,
      txHash: receipt.txHash,
      network: receipt.network,
    });
    return { status: "delivered", txHash: receipt.txHash };
  },
}
```

## Facilitators

Facilitators verify payment signatures and settle transactions on-chain. They pay the gas.

The default facilitator is [`x402.stablecoin.xyz`](https://x402.stablecoin.xyz) — keyless, free, supports SBC on Base, Solana, and Radius.

**Note:** The `x402.stablecoin.xyz` facilitator on Base uses SBC-style ERC-2612 permits. USDC on Base uses a different signing scheme (`transferWithAuthorization`) and is not currently supported through this facilitator. For USDC, use the Coinbase or community facilitators documented in [docs/ASSETS.md](docs/ASSETS.md).

See [docs/ASSETS.md](docs/ASSETS.md) for all supported assets, networks, and facilitators.

## 402 response format

When an agent POSTs without a `PAYMENT-SIGNATURE` header, the server responds:

```
HTTP/1.1 402 Payment Required
PAYMENT-REQUIRED: <base64-encoded payment requirements>
Content-Type: application/json

{
  "message": "Payment required",
  "price": "$1.00",
  "accepts": [
    {
      "asset": "0xfdcC3dd6671eaB0709A4C0f3F53De9a333d80798",
      "network": "base",
      "facilitatorUrl": "https://x402.stablecoin.xyz"
    }
  ],
  "fields": [
    {
      "name": "sender",
      "type": "string",
      "required": true,
      "description": "Agent or service identifier"
    }
  ]
}
```

The `PAYMENT-REQUIRED` header contains the full payment requirements (including `facilitator` address, `maxTimeoutSeconds`, `extra` metadata) that the x402 client library needs to sign the permit.

## Security

### Replay protection

Without a `deduplicationStore`, replay protection depends entirely on the facilitator. For production use, provide a store that persists seen payment signature hashes. The interface is two methods:

```typescript
interface DeduplicationStore {
  has(key: string): Promise<boolean>;
  add(key: string): Promise<void>;
}
```

On Cloudflare Workers, a KV-backed implementation takes ~10 lines:

```typescript
const deduplicationStore = {
  async has(key: string) {
    return (await env.PAYMENT_DEDUP.get(key)) !== null;
  },
  async add(key: string) {
    await env.PAYMENT_DEDUP.put(key, "1", { expirationTtl: 86400 });
  },
};
```

### Fulfillment failure recovery

If `onFulfill` throws after payment is settled on-chain, the agent has paid but received nothing. The `onFulfillmentFailure` callback lets you queue a retry, issue a refund, or alert an operator:

```typescript
onFulfillmentFailure: async (error, payload, receipt) => {
  await deadLetterQueue.send({ error: String(error), payload, receipt });
},
```

The receipt (including `txHash`) is always returned in the 500 response so the agent can prove payment.

### Request hardening

- **POST-only**: GET, PUT, DELETE, and other methods return 405.
- **Body size limit**: Streaming body reader rejects oversized payloads before buffering. Configure via `maxBodyBytes`.
- **Field type validation**: `type: "email"` is validated against a pattern. `type: "url"` is validated via `URL()` and restricted to `http`/`https`. Non-string values are rejected for all declared fields.
- **Prototype pollution protection**: `__proto__`, `constructor`, and `prototype` keys are recursively stripped from the parsed request body.
- **No information leakage**: Internal error details (stack traces, connection strings, facilitator URLs) are never returned to the caller. Only generic error messages are sent.
- **CORS is opt-in**: No CORS headers are emitted unless `corsOrigin` is explicitly set. Agent-to-server flows don't need CORS.

## Runtime compatibility

Runs anywhere with a standard `fetch` API:

- Cloudflare Workers
- Deno / Deno Deploy
- Node.js 18+
- Bun
- Vercel Edge Functions

No Node.js-specific APIs. No `Buffer`. No `fs`. Pure web standards.

## License

MIT
