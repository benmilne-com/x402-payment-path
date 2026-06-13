# Supported Assets, Networks, and Facilitators

All facilitators listed below are **keyless** — no signup, no API keys, no accounts. They verify payment signatures and execute on-chain settlement, covering gas costs.

## Default: `x402.stablecoin.xyz`

Operated by [Stablecoin Inc.](https://stablecoin.xyz) Supports both SBC and USDC across multiple networks.

| Asset | Network | CAIP-2 ID | Notes |
|---|---|---|---|
| USDC | Base | `eip155:8453` | Mainnet |
| SBC | Base | `eip155:8453` | Mainnet |
| USDC | Base Sepolia | `eip155:84532` | Testnet |
| SBC | Base Sepolia | `eip155:84532` | Testnet |
| SBC | Radius | `eip155:723487` | Mainnet |
| SBC | Radius Testnet | `eip155:72344` | Testnet |
| SBC | Solana | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | Mainnet |

### Usage

```typescript
import { paymentPath } from "x402-payment-path";

// SBC and USDC on Base via x402.stablecoin.xyz (default)
const config = {
  price: "$1.00",
  payTo: "0xYourWallet",
  accepts: [
    { asset: "USDC", network: "eip155:8453", facilitatorUrl: "https://x402.stablecoin.xyz" },
    { asset: "SBC",  network: "eip155:8453", facilitatorUrl: "https://x402.stablecoin.xyz" },
  ],
  onFulfill: async (payload, receipt) => {
    return { status: "ok", txHash: receipt.txHash };
  },
};
```

## Backup: `facilitator.openx402.ai`

USDC only. Operated by the x402 open-source community.

| Asset | Network | CAIP-2 ID | Notes |
|---|---|---|---|
| USDC | Base | `eip155:8453` | Mainnet |
| USDC | Solana | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | Mainnet |

## Other Facilitators (Documented, Not Bundled)

These facilitators exist but may require API keys or have limited asset/network support.

| Facilitator | Assets | Notes |
|---|---|---|
| `api.cdp.coinbase.com/.../x402` | USDC | Coinbase CDP — requires API keys |
| `facilitator.xpay.sh` | USDC | XPay — keyless, Base only |
| `facilitator.svmacc.tech` | USDC | SVM Accelerator — keyless, Solana only |

## How Facilitators Work

A facilitator sits between your server and the blockchain. When an agent pays:

1. Your server sends the agent's payment signature to the facilitator's `/verify` endpoint
2. The facilitator checks the signature is valid and the permit hasn't been used
3. After your `onFulfill` callback succeeds, your server calls `/settle`
4. The facilitator executes the on-chain transfer, paying gas on behalf of both parties
5. The facilitator returns the transaction hash

The facilitator never touches your funds directly — it submits the pre-signed ERC-2612 permit to the token contract, which transfers funds from the agent's wallet to your wallet.

## Adding a New Asset

To accept a new stablecoin or network, add an entry to your `accepts` array:

```typescript
{
  asset: "TOKEN_NAME",       // or contract address
  network: "eip155:CHAIN_ID", // CAIP-2 identifier
  facilitatorUrl: "https://facilitator.example.com",
}
```

The facilitator must support the asset/network combination.
