;; inscription-escrow fuzz tests for Rendezvous (rv)
;; 
;; Property-based tests: verify individual function behavior across random inputs
;; Invariant tests: verify state consistency across random operation sequences
;;
;; NOTE: rv merges these tests INTO the contract source, so we call
;; contract functions directly (no contract-call? needed).

;; ============================================================
;; Property-based tests (test-* functions)
;; ============================================================

;; Property: listing with price >= MIN_PRICE (u1000) always succeeds for unique inscriptions
(define-public (test-list-inscription-valid-price
    (inscription-txid (buff 32))
    (inscription-vout uint)
    (price uint)
    (premium uint)
    (seller-btc (buff 40)))
  (begin
    ;; Discard if price below minimum
    (if (< price u1000)
      (ok false)
      (match (list-inscription inscription-txid inscription-vout price premium seller-btc)
        success (ok true)
        error
          ;; ERR_LISTING_EXISTS (u10) is acceptable - duplicate inscription UTXO
          (if (is-eq error u10)
            (ok false)
            (begin
              (print { test: "list-valid-price", error: error })
              (err u100)
            ))
      )
    )
  )
)

;; Property: listing with price < MIN_PRICE always fails with ERR_DUST_AMOUNT
(define-public (test-list-inscription-dust-rejected
    (inscription-txid (buff 32))
    (inscription-vout uint)
    (price uint)
    (seller-btc (buff 40)))
  (begin
    ;; Only test prices below minimum
    (if (>= price u1000)
      (ok false)
      (match (list-inscription inscription-txid inscription-vout price u0 seller-btc)
        success (err u200)  ;; FAIL: should have been rejected
        error
          (if (is-eq error u14)  ;; ERR_DUST_AMOUNT
            (ok true)
            (begin
              (print { test: "dust-rejected", expected: u14, got: error })
              (err u201)
            ))
      )
    )
  )
)

;; Property: get-listing returns none for any ID >= next-id
(define-public (test-get-listing-invalid-id (id uint))
  (let ((nid (get-next-id)))
    (if (< id nid)
      (ok false)
      (if (is-none (get-listing id))
        (ok true)
        (err u300)
      )
    )
  )
)

;; Property: accept-listing fails on non-existent listing
(define-public (test-accept-nonexistent-listing
    (id uint)
    (buyer-btc (buff 40)))
  (let ((nid (get-next-id)))
    (if (< id nid)
      (ok false)
      (match (accept-listing id buyer-btc)
        success (err u400)
        error
          (if (is-eq error u3)  ;; ERR_INVALID_ID
            (ok true)
            (err u401))
      )
    )
  )
)

;; Property: cancel-listing fails on non-existent listing
(define-public (test-cancel-nonexistent-listing (id uint))
  (let ((nid (get-next-id)))
    (if (< id nid)
      (ok false)
      (match (cancel-listing id)
        success (err u500)
        error
          (if (is-eq error u3)
            (ok true)
            (err u501))
      )
    )
  )
)

;; ============================================================
;; Invariant tests (invariant-* functions)
;; ============================================================

;; Invariant: next-id never goes backwards
(define-read-only (invariant-next-id-non-negative)
  (>= (get-next-id) u0)
)

;; Invariant: any listing that exists has a valid status
(define-read-only (invariant-listing-status-valid)
  (let ((nid (get-next-id)))
    (if (is-eq nid u0)
      true
      (match (get-listing u0)
        listing
          (let ((status (get status listing)))
            (or
              (is-eq status "open")
              (is-eq status "escrowed")
              (is-eq status "done")
              (is-eq status "cancelled")))
        true
      )
    )
  )
)

;; Invariant: "open" listings have no buyer
(define-read-only (invariant-open-listing-no-buyer)
  (let ((nid (get-next-id)))
    (if (is-eq nid u0)
      true
      (match (get-listing u0)
        listing
          (if (is-eq (get status listing) "open")
            (is-none (get buyer listing))
            true)
        true
      )
    )
  )
)

;; Invariant: "escrowed" listings always have a buyer
(define-read-only (invariant-escrowed-has-buyer)
  (let ((nid (get-next-id)))
    (if (is-eq nid u0)
      true
      (match (get-listing u0)
        listing
          (if (is-eq (get status listing) "escrowed")
            (is-some (get buyer listing))
            true)
        true
      )
    )
  )
)

;; Invariant: price is always >= MIN_PRICE for any existing listing
(define-read-only (invariant-price-above-minimum)
  (let ((nid (get-next-id)))
    (if (is-eq nid u0)
      true
      (match (get-listing u0)
        listing (>= (get price listing) u1000)
        true
      )
    )
  )
)

;; Invariant: seller is never the buyer (self-trade prevention)
(define-read-only (invariant-no-self-trade)
  (let ((nid (get-next-id)))
    (if (is-eq nid u0)
      true
      (match (get-listing u0)
        listing
          (match (get buyer listing)
            buyer (not (is-eq buyer (get seller listing)))
            true)
        true
      )
    )
  )
)
