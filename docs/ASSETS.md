# Supported Assets, Networks, and Facilitators

## Default: `x402.stablecoin.xyz`

Operated by [Stablecoin Inc.](https://stablecoin.xyz) Keyless — no signup, no API keys. The facilitator pays gas for settlement.

**Important:** This facilitator uses SBC-style ERC-2612 permits on EVM networks. USDC on Base uses `transferWithAuthorization` (a different signing scheme) and is **not supported** through this facilitator. Use the Coinbase or community facilitators below for USDC.

| Asset | Network | Short name | Contract | Decimals | Facilitator address |
|---|---|---|---|---|---|
| SBC | Base | `base` | `0xfdcC3dd6671eaB0709A4C0f3F53De9a333d80798` | 18 | `0xdeE710bB6a3b652C35B5cB74E7bdb03EE1F641E6` |
| SBC | Base Sepolia | `base-sepolia` | `0xf9FB20B8E097904f0aB7d12e9DbeE88f2dcd0F16` | 6 | `0xdeE710bB6a3b652C35B5cB74E7bdb03EE1F641E6` |
| SBC | Radius | `radius` | `0x33ad9e4BD16B69B5BFdED37D8B5D9fF9aba014Fb` | 6 | `0xdeE710bB6a3b652C35B5cB74E7bdb03EE1F641E6` |
| SBC | Solana | `solana` | `DBAzBUXaLj1qANCseUPZz4sp9F8d2sc78C4vKjhbTGMA` | 9 | `2mSjKVjzRGXcipq3DdJCijbepugfNSJCN1yVN2tgdw5K` |

### Usage

```typescript
accepts: [
  {
    asset: "0xfdcC3dd6671eaB0709A4C0f3F53De9a333d80798",
    network: "base",
    facilitatorUrl: "https://x402.stablecoin.xyz",
    decimals: 18,
    facilitatorAddress: "0xdeE710bB6a3b652C35B5cB74E7bdb03EE1F641E6",
    extra: { name: "Stable Coin" },
  },
]
```

### Solana notes

- The receiving wallet must have an Associated Token Account (ATA) for SBC. Most wallets create this on first receive, but the facilitator does not create ATAs automatically.
- The sending wallet must delegate the facilitator address (`2mSjKVjzRGXcipq3DdJCijbepugfNSJCN1yVN2tgdw5K`) via SPL Token `approve` before the facilitator can settle.

## Other Facilitators (USDC)

These facilitators support USDC but may require API keys.

| Facilitator | Assets | Networks | Notes |
|---|---|---|---|
| `facilitator.openx402.ai` | USDC | Base, Solana | Community-operated, keyless |
| `api.cdp.coinbase.com/.../x402` | USDC | Base | Coinbase CDP — requires API keys |
| `facilitator.xpay.sh` | USDC | Base | XPay — keyless |
| `facilitator.svmacc.tech` | USDC | Solana | SVM Accelerator — keyless |

## How Facilitators Work

A facilitator sits between your server and the blockchain:

1. Your server sends the agent's payment signature to `/verify`
2. The facilitator checks the signature is valid and the permit hasn't been used
3. Your server calls `/settle`
4. The facilitator executes the on-chain transfer, paying gas
5. The facilitator returns the transaction hash

The facilitator never touches your funds directly — it submits the pre-signed permit to the token contract, which transfers funds from the agent's wallet to yours.
