# Inscription Escrow — Technical Specification

## Overview

Trustless ordinals inscription trading using sBTC escrow on Stacks, with on-chain Bitcoin transaction proof verification. Based on the [catamaran-sbtc](https://github.com/friedger/clarity-catamaranswaps) swap pattern, extended for UTXO-specific inscription verification.

## Problem

Ordinals inscriptions live on Bitcoin L1. Payments between AI agents happen on Stacks L2 via sBTC. A trustless swap requires proving that a specific inscription UTXO was transferred on Bitcoin before releasing payment on Stacks — without any intermediary.

## Architecture

```
Bitcoin L1                          Stacks L2
┌─────────────────────┐            ┌─────────────────────────┐
│                     │            │  inscription-escrow.clar │
│  Inscription UTXO   │            │                         │
│  (seller controls)  │  ───────>  │  1. list-inscription    │
│                     │            │  2. accept-listing      │
│  BTC tx: seller     │            │  3. submit-proof        │
│  sends inscription  │  ───────>  │     (merkle proof)      │
│  to buyer address   │            │  4. sBTC released       │
│                     │            │                         │
└─────────────────────┘            └─────────────────────────┘
```

## State Machine

```
                 list-inscription
                      │
                      ▼
               ┌────────────┐
               │    OPEN     │
               └─────┬──────┘
                     │
          ┌──────────┼──────────┐
          │          │          │
   accept-listing    │    cancel (seller)
          │          │          │
          ▼          │          ▼
   ┌────────────┐    │   ┌────────────┐
   │  ESCROWED  │    │   │ CANCELLED  │
   └─────┬──────┘    │   └────────────┘
         │           │
    ┌────┼────┐      │
    │         │      │
submit-proof  │  cancel (expired)
    │         │      │
    ▼         ▼      ▼
┌────────┐  ┌────────────┐
│  DONE  │  │ CANCELLED  │
└────────┘  │ (refunded) │
            └────────────┘
```

### States

| State | Description |
|-------|-------------|
| `open` | Listing active, waiting for buyer |
| `escrowed` | Buyer deposited sBTC, waiting for inscription delivery |
| `done` | Proof submitted, sBTC released to seller |
| `cancelled` | Listing cancelled or expired, buyer refunded |

## Data Model

### Listing (per trade)

| Field | Type | Description |
|-------|------|-------------|
| `inscription-txid` | `(buff 32)` | Bitcoin txid of the UTXO holding the inscription |
| `inscription-vout` | `uint` | Output index of the inscription UTXO |
| `price` | `uint` | Asking price in sBTC sats |
| `premium` | `uint` | Optional premium buyer pays (goes directly to seller on accept) |
| `seller` | `principal` | Seller's Stacks address |
| `buyer` | `(optional principal)` | Buyer's Stacks address (set on accept) |
| `seller-btc` | `(buff 40)` | Seller's BTC scriptPubKey (for output verification) |
| `buyer-btc` | `(optional (buff 40))` | Buyer's BTC scriptPubKey (inscription destination) |
| `when` | `uint` | Burn block height of last state change |
| `status` | `(string-ascii 10)` | Current state: `open`, `escrowed`, `done`, `cancelled` |

### Maps

| Map | Key | Value | Purpose |
|-----|-----|-------|---------|
| `listings` | `uint` (listing ID) | Listing struct | Core state storage |
| `submitted-btc-txs` | `(buff 32)` (BTC txid) | `uint` (listing ID) | Prevent double-proof |
| `inscription-listings` | `{txid, vout}` | `uint` (listing ID) | Prevent duplicate listings |

## Functions

### Public Functions

#### `list-inscription`
```clarity
(list-inscription
  (inscription-txid (buff 32))
  (inscription-vout uint)
  (price uint)
  (premium uint)
  (seller-btc (buff 40)))
→ (response uint error)
```
Creates a new listing. Returns the listing ID.

**Constraints:**
- Price must be >= 1,000 sats (`MIN_PRICE`)
- Same inscription UTXO cannot be listed twice
- Seller is `tx-sender`

#### `accept-listing`
```clarity
(accept-listing (id uint) (buyer-btc (buff 40)))
→ (response bool error)
```
Buyer deposits sBTC (price + premium) into escrow.

**Constraints:**
- Listing must be in `open` state
- No existing buyer
- Buyer cannot be the seller (no self-trade)
- sBTC transfer must succeed
- Premium (if any) is paid directly to seller immediately

#### `cancel-listing`
```clarity
(cancel-listing (id uint))
→ (response bool error)
```
Cancel a listing.

**Rules:**
- `open` state: only the seller can cancel
- `escrowed` state: anyone can cancel, but only after expiry (~100 burn blocks / ~17 hours)
- On cancellation of escrowed listing: buyer gets refund of `price` (premium is non-refundable)
- `done` or `cancelled`: cannot cancel again

#### `submit-proof` (Legacy)
```clarity
(submit-proof
  (id uint) (height uint) (header (buff 80))
  (tx { version, ins, outs, locktime })
  (proof { tx-index, hashes, tree-depth }))
→ (response bool error)
```
Submit a Bitcoin transaction proof to settle the escrow.

**Verification steps:**
1. Listing must be in `escrowed` state
2. BTC tx was mined (via `clarity-bitcoin-lib-v5.was-tx-mined-compact`)
3. BTC tx hasn't been used for another proof
4. BTC tx spends the specific inscription UTXO (input verification)
5. BTC tx has an output to the buyer's BTC address with value >= 546 sats (dust limit)

**On success:** sBTC released to seller, listing marked `done`.

#### `submit-proof-segwit` (SegWit)
Same logic as `submit-proof` but for SegWit transactions. Uses `was-segwit-tx-mined-compact` with witness data, witness merkle root, and commitment proof.

### Read-Only Functions

| Function | Returns | Description |
|----------|---------|-------------|
| `get-listing (id uint)` | `(optional listing)` | Get listing details |
| `get-next-id` | `uint` | Next available listing ID |
| `get-out-value (tx) (scriptPubKey)` | Output match | Find output matching a scriptPubKey |

## Error Codes

| Code | Constant | Description |
|------|----------|-------------|
| `u1` | `ERR_OUT_OF_BOUNDS` | Buffer read out of bounds |
| `u3` | `ERR_INVALID_ID` | Listing ID doesn't exist |
| `u4` | `ERR_FORBIDDEN` | Caller not authorized |
| `u5` | `ERR_TX_VALUE_TOO_SMALL` | Output value below dust limit (546 sats) |
| `u6` | `ERR_TX_NOT_FOR_RECEIVER` | No output to buyer's address |
| `u7` | `ERR_ALREADY_DONE` | Listing already settled or cancelled |
| `u8` | `ERR_NO_BUYER` | No buyer on this listing |
| `u9` | `ERR_BTC_TX_ALREADY_USED` | BTC tx already used in another proof |
| `u10` | `ERR_LISTING_EXISTS` | Inscription already listed |
| `u11` | `ERR_INSCRIPTION_MISMATCH` | BTC tx doesn't spend the inscription UTXO |
| `u12` | `ERR_EXPIRED` | Listing has expired |
| `u13` | `ERR_NOT_EXPIRED` | Cannot cancel — listing hasn't expired yet |
| `u14` | `ERR_DUST_AMOUNT` | Price below minimum (1,000 sats) |
| `u15` | `ERR_SELF_TRADE` | Buyer and seller are the same principal |
| `u99` | `ERR_NATIVE_FAILURE` | Internal Clarity error |

## Dependencies

| Contract | Address | Purpose |
|----------|---------|---------|
| `clarity-bitcoin-lib-v5` | `SP2PABAF9FTAJYNFZH93XENAJ8FVY99RRM50D2JG9` | BTC merkle proof verification |
| `clarity-bitcoin-helper` | `SP2PABAF9FTAJYNFZH93XENAJ8FVY99RRM50D2JG9` | Transaction serialization |
| `sbtc-token` | `SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4` | sBTC transfers |

## Constants

| Name | Value | Description |
|------|-------|-------------|
| `MIN_PRICE` | 1,000 sats | Minimum listing price |
| `EXPIRY` | 100 burn blocks (~17 hours) | Time before escrowed listing can be cancelled |

## PSBT Atomic Swap (Off-Chain Alternative)

In addition to the on-chain escrow, this repo includes a PSBT-based atomic swap handler (`psbt-handler.mjs`) for direct Bitcoin-to-inscription swaps without Stacks involvement:

1. **Seller** creates PSBT with inscription input + payment output, signs with `SIGHASH_SINGLE|ANYONECANPAY`
2. **Buyer** adds funding inputs, change output, signs remaining inputs
3. **Broadcast** — inscription and payment swap atomically in one Bitcoin tx

The trade protocol (`trade-protocol.mjs`) handles negotiation via JSON messages:
```json
{"t":"trade","a":"list","i":"<inscription-id>","p":10000,"n":"Test Inscription"}
{"t":"trade","a":"counter","i":"<inscription-id>","p":8000}
{"t":"trade","a":"accept","i":"<inscription-id>","psbt":"<base64>"}
{"t":"trade","a":"complete","txid":"<broadcast-txid>"}
```

## Security Considerations

1. **Input verification**: The contract verifies the *specific* inscription UTXO was spent, not just any transfer to the buyer. This prevents proof fraud with unrelated transactions.
2. **Double-proof prevention**: Each BTC txid can only be used once across all listings.
3. **Duplicate listing prevention**: Same inscription UTXO cannot be listed twice simultaneously.
4. **Self-trade prevention**: Buyer and seller must be different principals.
5. **Expiry protection**: Buyer's sBTC is refunded if seller doesn't deliver within ~17 hours.
6. **Permissionless settlement**: Anyone can submit the proof — no party can hold the trade hostage.
7. **Non-refundable premium**: Premium goes to seller on accept, incentivizing honest listing.

## Test Coverage

17 tests covering:
- Listing creation and duplicate prevention
- Buyer acceptance and sBTC escrow
- Self-trade rejection
- Seller cancellation (open state)
- Expiry-based cancellation and refund (escrowed state)
- Premature cancellation rejection
- Premium flow (immediate payment to seller)
- Dust amount rejection

## Status

⚠️ **Pre-audit** — not yet reviewed for production use.

## Author

cocoa007.btc (`bc1qv8dt3v9kx3l7r9mnz2gj9r9n9k63frn6w6zmrt`)
