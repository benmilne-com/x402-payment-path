# x402-payment-path

Gate any action behind x402 stablecoin payments.

Agent-first. Server-side. No client UI. One function call.

```typescript
import { paymentPath } from "x402-payment-path";

export default {
  async fetch(request: Request) {
    return paymentPath(request, {
      price: "$1.00",
      payTo: "0xYourWallet",
      accepts: [
        { asset: "USDC", network: "eip155:8453", facilitatorUrl: "https://x402.stablecoin.xyz" },
      ],
      onFulfill: async (payload, receipt) => {
        // Your logic here — send an email, deliver a file, trigger a webhook
        return { status: "delivered", txHash: receipt.txHash };
      },
    });
  },
};
```

## What this does

An agent POSTs to your endpoint. No payment header? The server returns `402 Payment Required` with the price, accepted assets, and a machine-readable field schema. The agent reads the response, signs a stablecoin permit with its wallet, and retries with a `PAYMENT-SIGNATURE` header. The server verifies the signature through a facilitator, runs your `onFulfill` callback, settles payment on-chain, and returns a receipt.

One round-trip. No API keys. No credit cards. No accounts.

## How it works

```
Agent → POST (no payment)
Server → 402 + price + field schema
Agent → signs permit
Agent → POST + PAYMENT-SIGNATURE + body
Server → facilitator /verify → onFulfill → facilitator /settle
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
| `payTo` | `string` | Yes | Your wallet address |
| `accepts` | `AcceptedAsset[]` | Yes | Stablecoins and networks you accept |
| `onFulfill` | `FulfillmentHandler` | Yes | Called after payment verification |
| `fields` | `FieldSchema[]` | No | Describes expected request body fields |

### `AcceptedAsset`

| Field | Type | Description |
|---|---|---|
| `asset` | `string` | Token name (`"USDC"`, `"SBC"`) or contract address |
| `network` | `string` | CAIP-2 network identifier (e.g. `"eip155:8453"` for Base) |
| `facilitatorUrl` | `string` | Facilitator endpoint (e.g. `"https://x402.stablecoin.xyz"`) |

### `FieldSchema`

Included in the 402 response body so agents can self-discover what data to send.

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Key in the JSON body |
| `type` | `"string" \| "email" \| "url"` | Expected value type |
| `required` | `boolean` | Whether the field must be present |
| `description` | `string` | Machine-readable purpose |

### `FulfillmentHandler`

```typescript
type FulfillmentHandler = (
  payload: FulfillmentPayload,
  receipt: PaymentReceipt,
) => Promise<unknown>;
```

Called after the payment signature is verified. The return value becomes the 200 response body. Throw to reject — the payment will not be settled.

## Use cases

### Agent-to-human contact

An agent pays $1 to send a message. The `onFulfill` callback emails the message to a human.

```typescript
onFulfill: async (payload, receipt) => {
  const { sender, body } = payload.body as Record<string, string>;
  await sendEmail({
    to: "you@yourdomain.com",
    subject: `x402 message from ${sender}`,
    text: `${body}\n\nWallet: ${receipt.from}\nTx: ${receipt.txHash}`,
  });
  return { status: "delivered" };
},
```

### Digital product purchase

An agent pays $5 for a time-limited download URL.

```typescript
onFulfill: async (_payload, receipt) => {
  const url = await signDownloadUrl("product.pdf", SECRET, 3600);
  return { downloadUrl: url, expiresIn: 3600, txHash: receipt.txHash };
},
```

### Webhook trigger

An agent pays to trigger an external action.

```typescript
onFulfill: async (payload, receipt) => {
  await fetch("https://api.example.com/trigger", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event: "paid", ...payload.body, receipt }),
  });
  return { status: "triggered" };
},
```

## Facilitators

Facilitators verify payment signatures and settle transactions on-chain. They pay the gas.

The default facilitator is [`x402.stablecoin.xyz`](https://x402.stablecoin.xyz) — keyless, free, supports USDC and SBC.

See [docs/ASSETS.md](docs/ASSETS.md) for all supported assets, networks, and facilitators. See [docs/PAYMASTERS.md](docs/PAYMASTERS.md) for documentation on adding gasless agent UX (not implemented in v1).

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
      "asset": "USDC",
      "network": "eip155:8453",
      "facilitatorUrl": "https://x402.stablecoin.xyz"
    }
  ],
  "fields": [
    {
      "name": "sender",
      "type": "string",
      "required": true,
      "description": "Agent or service identifier"
    },
    {
      "name": "body",
      "type": "string",
      "required": true,
      "description": "Message content"
    }
  ]
}
```

## Runtime compatibility

Runs anywhere with a standard `fetch` API:

- Cloudflare Workers
- Deno / Deno Deploy
- Node.js 18+ (with `--experimental-fetch` on 18, native on 20+)
- Bun
- Vercel Edge Functions
- Netlify Edge Functions

No Node.js-specific APIs. No `Buffer`. No `fs`. Pure web standards.

## License

MIT
