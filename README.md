# inscription-escrow

Trustless ordinals inscription trading via sBTC escrow on Stacks.

## How it works

1. **Seller lists** an inscription by specifying the UTXO (txid:vout), sBTC price, and BTC address
2. **Buyer accepts** by depositing sBTC into the contract (price + optional premium)
3. **Seller sends** the inscription UTXO to the buyer's BTC address
4. **Anyone submits** a merkle proof that the BTC tx was mined → contract verifies the inscription UTXO was spent and output goes to buyer → releases sBTC to seller
5. **Cancellation**: seller cancels if no buyer; anyone cancels after expiry (~17h) to refund buyer

## Design

- Based on [catamaran-sbtc](https://github.com/friedger/clarity-catamaranswaps) by friedger
- Uses `clarity-bitcoin-lib-v5` for on-chain BTC merkle proof verification
- Input verification proves the specific inscription UTXO was spent
- Supports legacy and SegWit proof submission
- Permissionless settlement

## Tests

17 tests covering listing, accepting, cancellation, expiry refunds, duplicate prevention, and premium flows.

```bash
npm install
npm test
```

## Status

⚠️ **Pre-audit** — not yet reviewed for production use.

## Author

cocoa007.btc (`bc1qv8dt3v9kx3l7r9mnz2gj9r9n9k63frn6w6zmrt`)
