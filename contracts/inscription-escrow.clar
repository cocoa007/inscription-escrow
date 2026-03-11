;; inscription-escrow.clar
;; Trustless ordinals inscription trading via sBTC escrow on Stacks
;;
;; Flow (2-phase settlement + buyer-confirmed delivery):
;; 1. Seller lists an inscription by specifying the UTXO (txid:vout) holding it,
;;    the asking price in sBTC, and their BTC receive address
;; 2. Buyer accepts by depositing sBTC into escrow (price + premium - both held)
;;    Premium is capped at 20% of price (H1 fix)
;; 3. Seller commits within COMMIT_EXPIRY blocks by depositing collateral >= premium
;;    Transitions listing to "committed" state and resets the expiry timer
;; 4. Seller sends the inscription UTXO to the buyer's BTC address
;; 5. Anyone submits the BTC tx proof -> status moves COMMITTED -> DELIVERED
;;    sBTC stays locked. delivery-block is recorded for confirmation window.
;; 6. Buyer calls confirm-delivery -> DELIVERED -> COMPLETED
;;    sBTC released to seller; collateral returned to seller.
;;    OR buyer calls reject-delivery -> DELIVERED -> DISPUTED
;; 7. If buyer does NOT confirm or reject within CONFIRMATION_WINDOW blocks,
;;    anyone can call timeout-delivery -> DELIVERED -> DISPUTED
;; 8. If seller doesn't commit within COMMIT_EXPIRY, buyer cancels and gets full refund
;;    (price + premium)
;; 9. If seller commits but doesn't deliver within EXPIRY, buyer cancels and receives
;;    price + premium + collateral as compensation
;;
;; C1 fix: 2-phase buyer-confirmed settlement (no code path releases sBTC without
;;         explicit confirm-delivery from buyer's tx-sender)
;; H1 fix: Premium capped at 20% of price and escrowed until confirm-delivery
;;
;; Based on catamaran-sbtc swap pattern by friedger
;; Extended for UTXO-specific (inscription) verification

;; ============================================================
;; Constants
;; ============================================================

(define-constant CONTRACT_OWNER tx-sender)
(define-constant ERR_OUT_OF_BOUNDS (err u1))
(define-constant ERR_INVALID_ID (err u3))
(define-constant ERR_FORBIDDEN (err u4))
(define-constant ERR_TX_VALUE_TOO_SMALL (err u5))
(define-constant ERR_TX_NOT_FOR_RECEIVER (err u6))
(define-constant ERR_ALREADY_DONE (err u7))
(define-constant ERR_NO_BUYER (err u8))
(define-constant ERR_BTC_TX_ALREADY_USED (err u9))
(define-constant ERR_LISTING_EXISTS (err u10))
(define-constant ERR_INSCRIPTION_MISMATCH (err u11))
(define-constant ERR_EXPIRED (err u12))
(define-constant ERR_NOT_EXPIRED (err u13))
(define-constant ERR_DUST_AMOUNT (err u14))
(define-constant ERR_SELF_TRADE (err u15))
(define-constant ERR_NOT_COMMITTED (err u16))
(define-constant ERR_NOT_DELIVERED (err u17))
(define-constant ERR_PREMIUM_TOO_HIGH (err u18))
(define-constant ERR_WINDOW_NOT_ELAPSED (err u19))
(define-constant ERR_NATIVE_FAILURE (err u99))

;; Minimum listing price in sats (prevent dust listings)
(define-constant MIN_PRICE u1000)

;; Expiry in burn blocks after commit (~100 blocks ~ ~17 hours)
;; Seller must deliver within this many blocks after committing
(define-constant EXPIRY u100)

;; Commit expiry: seller must call commit-listing within this many blocks
;; after buyer accepts (~50 blocks ~ ~8 hours)
(define-constant COMMIT_EXPIRY u50)

;; C1 fix: buyer must confirm or reject delivery within this many blocks
;; after submit-proof moves status to "delivered" (~36 blocks ~ ~6 hours)
(define-constant CONFIRMATION_WINDOW u36)

;; H1 fix: premium cap as a percentage of price (20%)
;; premium must be <= price * MAX_PREMIUM_PCT / 100
(define-constant MAX_PREMIUM_PCT u20)

;; ============================================================
;; Data
;; ============================================================

(define-data-var next-id uint u0)

;; Core listing/escrow map
;; status values: "open", "escrowed", "committed", "delivered", "disputed", "done", "cancelled"
;; string-ascii length bumped to 12 to accommodate "delivered" and "disputed"
(define-map listings
  uint
  {
    ;; Inscription identifier (the UTXO holding the inscription)
    inscription-txid: (buff 32),
    inscription-vout: uint,
    ;; Pricing
    price: uint,            ;; sBTC price in sats
    premium: uint,          ;; optional premium buyer pays to accept (escrowed until confirm-delivery)
    ;; Participants
    seller: principal,
    buyer: (optional principal),
    ;; Seller's BTC address to receive sBTC equivalent (scriptPubKey)
    seller-btc: (buff 40),
    ;; Buyer's BTC address to receive the inscription (scriptPubKey)
    buyer-btc: (optional (buff 40)),
    ;; SEC-09: seller collateral deposited at commit time
    collateral: uint,
    ;; State
    when: uint,             ;; block height of last state change
    ;; C1 fix: block height when submit-proof succeeded (start of confirmation window)
    delivery-block: uint,
    status: (string-ascii 12),  ;; "open","escrowed","committed","delivered","disputed","done","cancelled"
  }
)

;; Prevent double-use of BTC proof txs
(define-map submitted-btc-txs (buff 32) uint)

;; Index: inscription UTXO -> listing id (prevent duplicate listings)
(define-map inscription-listings { txid: (buff 32), vout: uint } uint)

;; ============================================================
;; Private helpers
;; ============================================================

(define-private (sbtc-transfer (amount uint) (sender principal) (recipient principal))
  (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
    transfer amount sender recipient none)
)

(define-read-only (read-uint32
    (ctx { txbuff: (buff 4096), index: uint }))
  (let (
    (data (get txbuff ctx))
    (base (get index ctx))
  )
    (ok {
      uint32: (buff-to-uint-le
        (unwrap-panic (as-max-len?
          (unwrap! (slice? data base (+ base u4)) ERR_OUT_OF_BOUNDS)
          u4))),
      ctx: { txbuff: data, index: (+ u4 base) },
    })
  )
)

;; Find an output matching a given scriptPubKey
(define-private (find-out
    (entry { scriptPubKey: (buff 128), value: (buff 8) })
    (result { pubscriptkey: (buff 40), out: (optional { scriptPubKey: (buff 128), value: uint }) }))
  (if (is-eq (get scriptPubKey entry) (get pubscriptkey result))
    (merge result {
      out: (some {
        scriptPubKey: (get scriptPubKey entry),
        value: (get uint32
          (unwrap-panic (read-uint32 { txbuff: (get value entry), index: u0 })))
      })
    })
    result
  )
)

;; get-out-value: read-only helper - find first output matching a scriptPubKey
(define-read-only (get-out-value
    (tx {
      version: (buff 4),
      ins: (list 8 {
        outpoint: { hash: (buff 32), index: (buff 4) },
        scriptSig: (buff 256),
        sequence: (buff 4),
      }),
      outs: (list 8 { value: (buff 8), scriptPubKey: (buff 128) }),
      locktime: (buff 4),
    })
    (pubscriptkey (buff 40)))
  (ok (fold find-out (get outs tx) { pubscriptkey: pubscriptkey, out: none }))
)

;; Check if a specific input spends the inscription UTXO
(define-private (check-input
    (entry {
      outpoint: { hash: (buff 32), index: (buff 4) },
      scriptSig: (buff 256),
      sequence: (buff 4),
    })
    (result {
      target-txid: (buff 32),
      target-vout: uint,
      found: bool,
    }))
  (if (get found result)
    result  ;; already found
    (if (and
          (is-eq (get hash (get outpoint entry)) (get target-txid result))
          (is-eq
            (get uint32 (unwrap-panic (read-uint32 {
              txbuff: (get index (get outpoint entry)),
              index: u0,
            })))
            (get target-vout result)))
      (merge result { found: true })
      result
    )
  )
)

;; ============================================================
;; Read-only
;; ============================================================

(define-read-only (get-listing (id uint))
  (map-get? listings id)
)

(define-read-only (get-next-id)
  (var-get next-id)
)

;; ============================================================
;; Public functions
;; ============================================================

;; List an inscription for sale
;; Seller specifies the inscription UTXO, price, and optional premium
(define-public (list-inscription
    (inscription-txid (buff 32))
    (inscription-vout uint)
    (price uint)
    (premium uint)
    (seller-btc (buff 40)))
  (let ((id (var-get next-id)))
    ;; Minimum price check
    (asserts! (>= price MIN_PRICE) ERR_DUST_AMOUNT)
    ;; H1 fix: premium cap at 20% of price
    (asserts! (<= (* premium u100) (* price MAX_PREMIUM_PCT)) ERR_PREMIUM_TOO_HIGH)
    ;; Prevent duplicate listing of same inscription
    (asserts!
      (map-insert inscription-listings
        { txid: inscription-txid, vout: inscription-vout } id)
      ERR_LISTING_EXISTS)
    (asserts!
      (map-insert listings id {
        inscription-txid: inscription-txid,
        inscription-vout: inscription-vout,
        price: price,
        premium: premium,
        seller: tx-sender,
        buyer: none,
        seller-btc: seller-btc,
        buyer-btc: none,
        collateral: u0,
        when: burn-block-height,
        delivery-block: u0,
        status: "open",
      })
      ERR_INVALID_ID)
    (var-set next-id (+ id u1))
    (print { event: "list", id: id, seller: tx-sender })
    (ok id)
  )
)

;; Buyer accepts a listing by depositing sBTC (price + premium) into escrow.
;; H1 fix: Premium is ESCROWED (not paid immediately to seller).
;; The full amount (price + premium) is released to seller only on confirm-delivery.
;; On cancellation/refund, buyer gets price + premium back.
(define-public (accept-listing
    (id uint)
    (buyer-btc (buff 40)))
  (let (
    (listing (unwrap! (map-get? listings id) ERR_INVALID_ID))
    (price (get price listing))
    (premium (get premium listing))
    (total (+ price premium))
  )
    (asserts! (is-eq (get status listing) "open") ERR_ALREADY_DONE)
    (asserts! (is-none (get buyer listing)) ERR_ALREADY_DONE)
    ;; Prevent self-trade
    (asserts! (not (is-eq tx-sender (get seller listing))) ERR_SELF_TRADE)
    ;; Transfer full amount (price + premium) to escrow - both held until confirm-delivery
    (try! (sbtc-transfer total tx-sender (as-contract tx-sender)))
    ;; Update listing: seller must commit within COMMIT_EXPIRY blocks
    (map-set listings id
      (merge listing {
        buyer: (some tx-sender),
        buyer-btc: (some buyer-btc),
        when: burn-block-height,
        status: "escrowed",
      }))
    (print { event: "accept", id: id, buyer: tx-sender })
    (ok true)
  )
)

;; SEC-08: Seller commits to fulfilling the trade after buyer accepts.
;; Seller must call this within COMMIT_EXPIRY blocks of acceptance.
;; Seller deposits collateral (>= premium) to demonstrate seriousness.
;; If seller fails to commit in time, buyer gets full refund (price + premium).
;; If seller commits but fails to deliver within EXPIRY, buyer gets
;; price + premium + collateral as compensation.
(define-public (commit-listing
    (id uint)
    (collateral uint))
  (let (
    (listing (unwrap! (map-get? listings id) ERR_INVALID_ID))
  )
    ;; Must be in escrowed state (buyer has accepted, waiting for seller commit)
    (asserts! (is-eq (get status listing) "escrowed") ERR_ALREADY_DONE)
    ;; Only seller can commit
    (asserts! (is-eq tx-sender (get seller listing)) ERR_FORBIDDEN)
    ;; Must commit within COMMIT_EXPIRY blocks of acceptance
    (asserts! (< burn-block-height (+ (get when listing) COMMIT_EXPIRY)) ERR_EXPIRED)
    ;; SEC-09: Minimum collateral = premium (prevents griefing)
    (asserts! (>= collateral (get premium listing)) ERR_DUST_AMOUNT)
    ;; Deposit collateral into escrow (skip transfer if zero to avoid ft-transfer? failure)
    (if (> collateral u0)
      (try! (sbtc-transfer collateral tx-sender (as-contract tx-sender)))
      true
    )
    ;; Update listing: reset timer for delivery phase
    (map-set listings id (merge listing {
      collateral: collateral,
      status: "committed",
      when: burn-block-height,
    }))
    (print { event: "commit", id: id, collateral: collateral })
    (ok true)
  )
)

;; Cancel a listing
;; - Seller can cancel if no buyer yet (open state)
;; - "escrowed" + COMMIT_EXPIRY elapsed: buyer gets full refund (price + premium)
;; - "committed" + EXPIRY elapsed: buyer gets price + premium + collateral
;; - "delivered" + CONFIRMATION_WINDOW elapsed: handled by timeout-delivery instead
;; - "disputed": must be resolved separately (not cancelable here)
(define-public (cancel-listing (id uint))
  (let ((listing (unwrap! (map-get? listings id) ERR_INVALID_ID)))
    (asserts! (not (is-eq (get status listing) "done")) ERR_ALREADY_DONE)
    (asserts! (not (is-eq (get status listing) "cancelled")) ERR_ALREADY_DONE)
    (asserts! (not (is-eq (get status listing) "delivered")) ERR_ALREADY_DONE)
    (asserts! (not (is-eq (get status listing) "disputed")) ERR_ALREADY_DONE)
    (if (is-eq (get status listing) "open")
      ;; Open listing: only seller can cancel
      (begin
        (asserts! (is-eq tx-sender (get seller listing)) ERR_FORBIDDEN)
        (map-set listings id (merge listing { status: "cancelled" }))
        (map-delete inscription-listings
          { txid: (get inscription-txid listing), vout: (get inscription-vout listing) })
        (print { event: "cancel", id: id, status: (get status listing) })
        (ok true)
      )
      (if (is-eq (get status listing) "escrowed")
        ;; Escrowed (not yet committed): cancel after COMMIT_EXPIRY
        ;; Seller missed their commit window - buyer gets full refund (price + premium)
        (begin
          (asserts! (<= (+ (get when listing) COMMIT_EXPIRY) burn-block-height) ERR_NOT_EXPIRED)
          (map-set listings id (merge listing { status: "cancelled" }))
          (map-delete inscription-listings
            { txid: (get inscription-txid listing), vout: (get inscription-vout listing) })
          (print { event: "cancel", id: id, status: (get status listing) })
          ;; Refund buyer full amount: price + premium (premium was never paid to seller)
          (as-contract (sbtc-transfer
            (+ (get price listing) (get premium listing))
            tx-sender
            (unwrap! (get buyer listing) ERR_NO_BUYER)))
        )
        ;; Committed: cancel after EXPIRY (seller delivered too late)
        ;; Buyer receives price + premium + collateral as compensation
        (begin
          (asserts! (<= (+ (get when listing) EXPIRY) burn-block-height) ERR_NOT_EXPIRED)
          (map-set listings id (merge listing { status: "cancelled" }))
          (map-delete inscription-listings
            { txid: (get inscription-txid listing), vout: (get inscription-vout listing) })
          (print { event: "cancel", id: id, status: (get status listing) })
          ;; Refund buyer: price + premium + collateral (collateral = compensation for seller breach)
          (as-contract (sbtc-transfer
            (+ (+ (get price listing) (get premium listing)) (get collateral listing))
            tx-sender
            (unwrap! (get buyer listing) ERR_NO_BUYER)))
        )
      )
    )
  )
)

;; Submit BTC transaction proof that the inscription was delivered.
;; C1 fix: Moves status COMMITTED -> DELIVERED. sBTC stays locked.
;; Buyer must call confirm-delivery to release sBTC to seller.
;; Records delivery-block for the CONFIRMATION_WINDOW timeout.
;; Anyone can submit (permissionless proof submission).
;;
;; Verifies: (1) tx spends the inscription UTXO, (2) output goes to buyer's address.
(define-public (submit-proof
    (id uint)
    (height uint)
    (header (buff 80))
    (tx {
      version: (buff 4),
      ins: (list 8 {
        outpoint: { hash: (buff 32), index: (buff 4) },
        scriptSig: (buff 256),
        sequence: (buff 4),
      }),
      outs: (list 8 { value: (buff 8), scriptPubKey: (buff 128) }),
      locktime: (buff 4),
    })
    (proof {
      tx-index: uint,
      hashes: (list 14 (buff 32)),
      tree-depth: uint,
    }))
  (let (
    (listing (unwrap! (map-get? listings id) ERR_INVALID_ID))
    (buyer-btc (unwrap! (get buyer-btc listing) ERR_NO_BUYER))
    (tx-buff (contract-call?
      'SP2PABAF9FTAJYNFZH93XENAJ8FVY99RRM50D2JG9.clarity-bitcoin-helper
      concat-tx tx))
  )
    ;; Must be in committed state (not just escrowed)
    (asserts! (is-eq (get status listing) "committed") ERR_NOT_COMMITTED)
    ;; Verify BTC tx was mined
    (match (contract-call?
      'SP2PABAF9FTAJYNFZH93XENAJ8FVY99RRM50D2JG9.clarity-bitcoin-lib-v5
      was-tx-mined-compact height tx-buff header proof)
      mined-tx-buff
      (begin
        ;; Prevent reuse of same BTC tx
        (asserts! (is-none (map-get? submitted-btc-txs mined-tx-buff))
          ERR_BTC_TX_ALREADY_USED)
        ;; Verify the tx spends the inscription UTXO
        (let (
          (input-check (fold check-input (get ins tx) {
            target-txid: (get inscription-txid listing),
            target-vout: (get inscription-vout listing),
            found: false,
          }))
        )
          (asserts! (get found input-check) ERR_INSCRIPTION_MISMATCH)
        )
        ;; Verify there's an output to the buyer's BTC address
        (match (get out
          (unwrap! (get-out-value tx buyer-btc) ERR_NATIVE_FAILURE))
          out
          (begin
            ;; Output exists to buyer -- inscription delivered
            ;; (We check value >= 546 sats i.e. dust limit, since inscriptions sit on dust UTXOs)
            (asserts! (>= (get value out) u546) ERR_TX_VALUE_TOO_SMALL)
            ;; C1 fix: Move to DELIVERED state. sBTC stays locked.
            ;; Buyer must call confirm-delivery to release funds.
            (map-set listings id (merge listing {
              status: "delivered",
              delivery-block: burn-block-height,
            }))
            (map-set submitted-btc-txs mined-tx-buff id)
            (print { event: "delivered", id: id, delivery-block: burn-block-height })
            (ok true)
          )
          ERR_TX_NOT_FOR_RECEIVER
        )
      )
      error (err (* error u1000))
    )
  )
)

;; C1 fix: Buyer confirms delivery, releasing sBTC to seller.
;; Only the buyer (tx-sender == buyer principal) can call this.
;; Moves status DELIVERED -> DONE and releases price + premium to seller;
;; collateral is returned to seller.
;; This is the ONLY code path that releases sBTC to the seller.
(define-public (confirm-delivery (id uint))
  (let (
    (listing (unwrap! (map-get? listings id) ERR_INVALID_ID))
  )
    ;; Must be in delivered state (checked before unwrapping optional buyer)
    (asserts! (is-eq (get status listing) "delivered") ERR_NOT_DELIVERED)
    (let (
      (buyer (unwrap! (get buyer listing) ERR_NO_BUYER))
    )
      ;; Only the buyer can confirm delivery
      (asserts! (is-eq tx-sender buyer) ERR_FORBIDDEN)
      ;; Mark as done
      (map-set listings id (merge listing { status: "done" }))
      (map-delete inscription-listings
        { txid: (get inscription-txid listing), vout: (get inscription-vout listing) })
      (print { event: "confirmed", id: id })
      ;; Pay seller: price + premium (both were held in escrow)
      (try! (as-contract (sbtc-transfer
        (+ (get price listing) (get premium listing))
        tx-sender
        (get seller listing))))
      ;; Return collateral to seller
      (if (> (get collateral listing) u0)
        (as-contract (sbtc-transfer
          (get collateral listing)
          tx-sender
          (get seller listing)))
        (ok true)
      )
    )
  )
)

;; C1 fix: Buyer rejects delivery, moving to DISPUTED state.
;; Only the buyer (tx-sender == buyer principal) can call this.
;; Moves status DELIVERED -> DISPUTED. sBTC stays locked pending dispute resolution.
(define-public (reject-delivery (id uint))
  (let (
    (listing (unwrap! (map-get? listings id) ERR_INVALID_ID))
  )
    ;; Must be in delivered state (checked before unwrapping optional buyer)
    (asserts! (is-eq (get status listing) "delivered") ERR_NOT_DELIVERED)
    (let (
      (buyer (unwrap! (get buyer listing) ERR_NO_BUYER))
    )
      ;; Only the buyer can reject delivery
      (asserts! (is-eq tx-sender buyer) ERR_FORBIDDEN)
      ;; Move to disputed state
      (map-set listings id (merge listing { status: "disputed" }))
      (print { event: "rejected", id: id })
      (ok true)
    )
  )
)

;; C1 fix: Timeout handler for unconfirmed deliveries.
;; If buyer has not confirmed or rejected within CONFIRMATION_WINDOW blocks
;; after submit-proof, anyone can call this to move status DELIVERED -> DISPUTED.
;; This prevents the buyer from silently holding the seller's funds hostage
;; while also ensuring a real dispute is raised for investigation.
(define-public (timeout-delivery (id uint))
  (let (
    (listing (unwrap! (map-get? listings id) ERR_INVALID_ID))
  )
    ;; Must be in delivered state
    (asserts! (is-eq (get status listing) "delivered") ERR_NOT_DELIVERED)
    ;; CONFIRMATION_WINDOW must have elapsed since delivery-block
    (asserts!
      (<= (+ (get delivery-block listing) CONFIRMATION_WINDOW) burn-block-height)
      ERR_WINDOW_NOT_ELAPSED)
    ;; Move to disputed state
    (map-set listings id (merge listing { status: "disputed" }))
    (print { event: "timeout-disputed", id: id, delivery-block: (get delivery-block listing) })
    (ok true)
  )
)

;; ============================================================
;; SegWit proof variant (for witness transactions)
;; ============================================================

;; C1 fix: Requires "committed" state. Moves to "delivered" (not "done").
;; sBTC stays locked until buyer calls confirm-delivery.
;; See submit-proof for full documentation.
(define-public (submit-proof-segwit
    (id uint)
    (height uint)
    (wtx {
      version: (buff 4),
      ins: (list 8 {
        outpoint: { hash: (buff 32), index: (buff 4) },
        scriptSig: (buff 256),
        sequence: (buff 4),
      }),
      outs: (list 8 { value: (buff 8), scriptPubKey: (buff 128) }),
      locktime: (buff 4),
    })
    (witness-data (buff 1650))
    (header (buff 80))
    (tx-index uint)
    (tree-depth uint)
    (wproof (list 14 (buff 32)))
    (witness-merkle-root (buff 32))
    (witness-reserved-value (buff 32))
    (ctx (buff 1024))
    (cproof (list 14 (buff 32))))
  (let (
    (listing (unwrap! (map-get? listings id) ERR_INVALID_ID))
    (buyer-btc (unwrap! (get buyer-btc listing) ERR_NO_BUYER))
    (tx-buff (contract-call?
      'SP2PABAF9FTAJYNFZH93XENAJ8FVY99RRM50D2JG9.clarity-bitcoin-helper
      concat-tx wtx))
  )
    ;; Must be in committed state
    (asserts! (is-eq (get status listing) "committed") ERR_NOT_COMMITTED)
    (match (contract-call?
      'SP2PABAF9FTAJYNFZH93XENAJ8FVY99RRM50D2JG9.clarity-bitcoin-lib-v5
      was-segwit-tx-mined-compact
      height tx-buff header tx-index tree-depth wproof
      witness-merkle-root witness-reserved-value ctx cproof)
      mined-tx-buff
      (begin
        (asserts! (is-none (map-get? submitted-btc-txs mined-tx-buff))
          ERR_BTC_TX_ALREADY_USED)
        ;; Verify inscription UTXO is spent
        (let (
          (input-check (fold check-input (get ins wtx) {
            target-txid: (get inscription-txid listing),
            target-vout: (get inscription-vout listing),
            found: false,
          }))
        )
          (asserts! (get found input-check) ERR_INSCRIPTION_MISMATCH)
        )
        ;; Verify output to buyer
        (match (get out
          (unwrap! (get-out-value wtx buyer-btc) ERR_NATIVE_FAILURE))
          out
          (begin
            (asserts! (>= (get value out) u546) ERR_TX_VALUE_TOO_SMALL)
            ;; C1 fix: Move to DELIVERED state. sBTC stays locked.
            ;; Buyer must call confirm-delivery to release funds.
            (map-set listings id (merge listing {
              status: "delivered",
              delivery-block: burn-block-height,
            }))
            (map-set submitted-btc-txs mined-tx-buff id)
            (print { event: "delivered", id: id, delivery-block: burn-block-height })
            (ok true)
          )
          ERR_TX_NOT_FOR_RECEIVER
        )
      )
      error (err (* error u1000))
    )
  )
)
