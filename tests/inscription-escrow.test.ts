import { describe, it, expect, beforeEach } from "vitest";
import { Cl, ClarityType } from "@stacks/transactions";

// Simnet accounts (from default Clarinet Simnet config)
const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const seller = accounts.get("wallet_1")!;
const buyer = accounts.get("wallet_2")!;
const anyone = accounts.get("wallet_3")!;

// Test inscription UTXO
const inscriptionTxid = new Uint8Array(32).fill(0xab);
const inscriptionVout = 0;

// BTC scriptPubKeys (fake 20-byte addresses padded to 40)
const sellerBtc = new Uint8Array(40).fill(0x01);
const buyerBtc = new Uint8Array(40).fill(0x02);

const CONTRACT = "inscription-escrow";
const SBTC = "sbtc-token";

function mintSbtc(recipient: string, amount: number) {
  return simnet.callPublicFn(SBTC, "mint", [Cl.uint(amount), Cl.principal(recipient)], deployer);
}

describe("inscription-escrow", () => {

  describe("list-inscription", () => {
    it("creates a listing successfully", () => {
      const result = simnet.callPublicFn(
        CONTRACT,
        "list-inscription",
        [
          Cl.buffer(inscriptionTxid),
          Cl.uint(inscriptionVout),
          Cl.uint(100000), // price: 100k sats sBTC
          Cl.uint(5000),   // premium: 5k sats
          Cl.buffer(sellerBtc),
        ],
        seller
      );
      expect(result.result).toBeOk(Cl.uint(0)); // first listing id = 0
    });

    it("increments listing id", () => {
      const r1 = simnet.callPublicFn(
        CONTRACT, "list-inscription",
        [Cl.buffer(inscriptionTxid), Cl.uint(0), Cl.uint(50000), Cl.uint(0), Cl.buffer(sellerBtc)],
        seller
      );
      expect(r1.result).toBeOk(Cl.uint(0));

      // Different inscription
      const txid2 = new Uint8Array(32).fill(0xcd);
      const r2 = simnet.callPublicFn(
        CONTRACT, "list-inscription",
        [Cl.buffer(txid2), Cl.uint(0), Cl.uint(50000), Cl.uint(0), Cl.buffer(sellerBtc)],
        seller
      );
      expect(r2.result).toBeOk(Cl.uint(1));
    });

    it("prevents duplicate listing of same inscription", () => {
      simnet.callPublicFn(
        CONTRACT, "list-inscription",
        [Cl.buffer(inscriptionTxid), Cl.uint(0), Cl.uint(50000), Cl.uint(0), Cl.buffer(sellerBtc)],
        seller
      );
      const r2 = simnet.callPublicFn(
        CONTRACT, "list-inscription",
        [Cl.buffer(inscriptionTxid), Cl.uint(0), Cl.uint(50000), Cl.uint(0), Cl.buffer(sellerBtc)],
        seller
      );
      expect(r2.result).toBeErr(Cl.uint(10)); // ERR_LISTING_EXISTS
    });
  });

  describe("get-listing", () => {
    it("returns listing details", () => {
      simnet.callPublicFn(
        CONTRACT, "list-inscription",
        [Cl.buffer(inscriptionTxid), Cl.uint(0), Cl.uint(100000), Cl.uint(5000), Cl.buffer(sellerBtc)],
        seller
      );
      const result = simnet.callReadOnlyFn(CONTRACT, "get-listing", [Cl.uint(0)], deployer);
      expect(result.result.type).toBe(ClarityType.OptionalSome);
    });

    it("returns none for nonexistent listing", () => {
      const result = simnet.callReadOnlyFn(CONTRACT, "get-listing", [Cl.uint(999)], deployer);
      expect(result.result).toBeNone();
    });
  });

  describe("accept-listing", () => {
    it("buyer accepts and full amount (price + premium) is escrowed", () => {
      // List
      simnet.callPublicFn(
        CONTRACT, "list-inscription",
        [Cl.buffer(inscriptionTxid), Cl.uint(0), Cl.uint(100000), Cl.uint(5000), Cl.buffer(sellerBtc)],
        seller
      );
      // Mint sBTC to buyer (price + premium = 105000)
      mintSbtc(buyer, 105000);

      // Accept
      const result = simnet.callPublicFn(
        CONTRACT, "accept-listing",
        [Cl.uint(0), Cl.buffer(buyerBtc)],
        buyer
      );
      expect(result.result).toBeOk(Cl.bool(true));

      // Verify buyer balance is 0 (all in escrow)
      const buyerBal = simnet.callReadOnlyFn(SBTC, "get-balance", [Cl.principal(buyer)], deployer);
      expect(buyerBal.result).toBeOk(Cl.uint(0)); // all escrowed

      // SEC-08: Premium is NO LONGER paid immediately to seller.
      // Seller gets nothing until settlement.
      const sellerBal = simnet.callReadOnlyFn(SBTC, "get-balance", [Cl.principal(seller)], deployer);
      expect(sellerBal.result).toBeOk(Cl.uint(0)); // nothing yet
    });

    it("rejects accept on non-open listing", () => {
      simnet.callPublicFn(
        CONTRACT, "list-inscription",
        [Cl.buffer(inscriptionTxid), Cl.uint(0), Cl.uint(100000), Cl.uint(0), Cl.buffer(sellerBtc)],
        seller
      );
      mintSbtc(buyer, 200000);

      // First accept
      simnet.callPublicFn(CONTRACT, "accept-listing", [Cl.uint(0), Cl.buffer(buyerBtc)], buyer);

      // Second accept should fail
      const r2 = simnet.callPublicFn(CONTRACT, "accept-listing", [Cl.uint(0), Cl.buffer(buyerBtc)], anyone);
      expect(r2.result).toBeErr(Cl.uint(7)); // ERR_ALREADY_DONE
    });

    it("fails if buyer has insufficient sBTC", () => {
      simnet.callPublicFn(
        CONTRACT, "list-inscription",
        [Cl.buffer(inscriptionTxid), Cl.uint(0), Cl.uint(100000), Cl.uint(0), Cl.buffer(sellerBtc)],
        seller
      );
      // Don't mint any sBTC
      const result = simnet.callPublicFn(CONTRACT, "accept-listing", [Cl.uint(0), Cl.buffer(buyerBtc)], buyer);
      expect(result.result.type).toBe(ClarityType.ResponseErr);
    });
  });

  describe("commit-listing (SEC-08)", () => {
    it("seller commits successfully after buyer accepts", () => {
      // List with premium = 5000
      simnet.callPublicFn(
        CONTRACT, "list-inscription",
        [Cl.buffer(inscriptionTxid), Cl.uint(0), Cl.uint(100000), Cl.uint(5000), Cl.buffer(sellerBtc)],
        seller
      );
      mintSbtc(buyer, 105000);
      simnet.callPublicFn(CONTRACT, "accept-listing", [Cl.uint(0), Cl.buffer(buyerBtc)], buyer);

      // Seller needs sBTC for collateral (>= premium = 5000)
      mintSbtc(seller, 5000);

      // Commit with collateral = 5000 (== premium)
      const result = simnet.callPublicFn(
        CONTRACT, "commit-listing",
        [Cl.uint(0), Cl.uint(5000)],
        seller
      );
      expect(result.result).toBeOk(Cl.bool(true));

      // Seller balance should be 0 (collateral in escrow)
      const sellerBal = simnet.callReadOnlyFn(SBTC, "get-balance", [Cl.principal(seller)], deployer);
      expect(sellerBal.result).toBeOk(Cl.uint(0));

      // Listing should be in "committed" state
      const listing = simnet.callReadOnlyFn(CONTRACT, "get-listing", [Cl.uint(0)], deployer);
      expect(listing.result.type).toBe(ClarityType.OptionalSome);
    });

    it("fails if caller is not seller", () => {
      simnet.callPublicFn(
        CONTRACT, "list-inscription",
        [Cl.buffer(inscriptionTxid), Cl.uint(0), Cl.uint(100000), Cl.uint(0), Cl.buffer(sellerBtc)],
        seller
      );
      mintSbtc(buyer, 100000);
      simnet.callPublicFn(CONTRACT, "accept-listing", [Cl.uint(0), Cl.buffer(buyerBtc)], buyer);
      mintSbtc(buyer, 0); // give buyer some to try committing

      const result = simnet.callPublicFn(
        CONTRACT, "commit-listing",
        [Cl.uint(0), Cl.uint(0)],
        buyer // not the seller
      );
      expect(result.result).toBeErr(Cl.uint(4)); // ERR_FORBIDDEN
    });

    it("fails if listing is not in escrowed state", () => {
      // Try to commit on an open listing
      simnet.callPublicFn(
        CONTRACT, "list-inscription",
        [Cl.buffer(inscriptionTxid), Cl.uint(0), Cl.uint(100000), Cl.uint(0), Cl.buffer(sellerBtc)],
        seller
      );
      mintSbtc(seller, 0);

      const result = simnet.callPublicFn(
        CONTRACT, "commit-listing",
        [Cl.uint(0), Cl.uint(0)],
        seller
      );
      expect(result.result).toBeErr(Cl.uint(7)); // ERR_ALREADY_DONE (wrong state)
    });

    it("fails if collateral is below premium (ERR_DUST_AMOUNT)", () => {
      // List with premium = 5000
      simnet.callPublicFn(
        CONTRACT, "list-inscription",
        [Cl.buffer(inscriptionTxid), Cl.uint(0), Cl.uint(100000), Cl.uint(5000), Cl.buffer(sellerBtc)],
        seller
      );
      mintSbtc(buyer, 105000);
      simnet.callPublicFn(CONTRACT, "accept-listing", [Cl.uint(0), Cl.buffer(buyerBtc)], buyer);
      mintSbtc(seller, 4999);

      const result = simnet.callPublicFn(
        CONTRACT, "commit-listing",
        [Cl.uint(0), Cl.uint(4999)], // below premium
        seller
      );
      expect(result.result).toBeErr(Cl.uint(14)); // ERR_DUST_AMOUNT
    });

    it("fails if commit window has expired (ERR_EXPIRED)", () => {
      simnet.callPublicFn(
        CONTRACT, "list-inscription",
        [Cl.buffer(inscriptionTxid), Cl.uint(0), Cl.uint(100000), Cl.uint(0), Cl.buffer(sellerBtc)],
        seller
      );
      mintSbtc(buyer, 100000);
      simnet.callPublicFn(CONTRACT, "accept-listing", [Cl.uint(0), Cl.buffer(buyerBtc)], buyer);

      // Mine 51 blocks to pass COMMIT_EXPIRY (50 blocks)
      simnet.mineEmptyBurnBlocks(51);

      mintSbtc(seller, 0);
      const result = simnet.callPublicFn(
        CONTRACT, "commit-listing",
        [Cl.uint(0), Cl.uint(0)],
        seller
      );
      expect(result.result).toBeErr(Cl.uint(12)); // ERR_EXPIRED
    });
  });

  describe("cancel-listing", () => {
    it("seller cancels open listing", () => {
      simnet.callPublicFn(
        CONTRACT, "list-inscription",
        [Cl.buffer(inscriptionTxid), Cl.uint(0), Cl.uint(100000), Cl.uint(0), Cl.buffer(sellerBtc)],
        seller
      );
      const result = simnet.callPublicFn(CONTRACT, "cancel-listing", [Cl.uint(0)], seller);
      expect(result.result).toBeOk(Cl.bool(true));
    });

    it("non-seller cannot cancel open listing", () => {
      simnet.callPublicFn(
        CONTRACT, "list-inscription",
        [Cl.buffer(inscriptionTxid), Cl.uint(0), Cl.uint(100000), Cl.uint(0), Cl.buffer(sellerBtc)],
        seller
      );
      const result = simnet.callPublicFn(CONTRACT, "cancel-listing", [Cl.uint(0)], buyer);
      expect(result.result).toBeErr(Cl.uint(4)); // ERR_FORBIDDEN
    });

    it("cannot cancel already cancelled listing", () => {
      simnet.callPublicFn(
        CONTRACT, "list-inscription",
        [Cl.buffer(inscriptionTxid), Cl.uint(0), Cl.uint(100000), Cl.uint(0), Cl.buffer(sellerBtc)],
        seller
      );
      simnet.callPublicFn(CONTRACT, "cancel-listing", [Cl.uint(0)], seller);
      const r2 = simnet.callPublicFn(CONTRACT, "cancel-listing", [Cl.uint(0)], seller);
      expect(r2.result).toBeErr(Cl.uint(7)); // ERR_ALREADY_DONE
    });

    it("escrowed listing cannot be cancelled before commit expiry", () => {
      simnet.callPublicFn(
        CONTRACT, "list-inscription",
        [Cl.buffer(inscriptionTxid), Cl.uint(0), Cl.uint(100000), Cl.uint(0), Cl.buffer(sellerBtc)],
        seller
      );
      mintSbtc(buyer, 100000);
      simnet.callPublicFn(CONTRACT, "accept-listing", [Cl.uint(0), Cl.buffer(buyerBtc)], buyer);

      // Try cancel before COMMIT_EXPIRY (50 blocks)
      const result = simnet.callPublicFn(CONTRACT, "cancel-listing", [Cl.uint(0)], anyone);
      expect(result.result).toBeErr(Cl.uint(13)); // ERR_NOT_EXPIRED
    });

    it("escrowed listing can be cancelled after commit expiry, refunds buyer price + premium", () => {
      // List with premium = 5000 so we can verify both are returned
      simnet.callPublicFn(
        CONTRACT, "list-inscription",
        [Cl.buffer(inscriptionTxid), Cl.uint(0), Cl.uint(100000), Cl.uint(5000), Cl.buffer(sellerBtc)],
        seller
      );
      mintSbtc(buyer, 105000);
      simnet.callPublicFn(CONTRACT, "accept-listing", [Cl.uint(0), Cl.buffer(buyerBtc)], buyer);

      // Mine 51 blocks to pass COMMIT_EXPIRY (50 blocks)
      simnet.mineEmptyBurnBlocks(51);

      const result = simnet.callPublicFn(CONTRACT, "cancel-listing", [Cl.uint(0)], anyone);
      expect(result.result).toBeOk(Cl.bool(true));

      // SEC-08: Buyer should receive full refund: price + premium (both were escrowed)
      const buyerBal = simnet.callReadOnlyFn(SBTC, "get-balance", [Cl.principal(buyer)], deployer);
      expect(buyerBal.result).toBeOk(Cl.uint(105000)); // price + premium

      // Seller got nothing (griefing attack prevented)
      const sellerBal = simnet.callReadOnlyFn(SBTC, "get-balance", [Cl.principal(seller)], deployer);
      expect(sellerBal.result).toBeOk(Cl.uint(0));
    });

    it("escrowed listing (no premium) refunds buyer exact price after commit expiry", () => {
      simnet.callPublicFn(
        CONTRACT, "list-inscription",
        [Cl.buffer(inscriptionTxid), Cl.uint(0), Cl.uint(100000), Cl.uint(0), Cl.buffer(sellerBtc)],
        seller
      );
      mintSbtc(buyer, 100000);
      simnet.callPublicFn(CONTRACT, "accept-listing", [Cl.uint(0), Cl.buffer(buyerBtc)], buyer);

      simnet.mineEmptyBurnBlocks(51);

      const result = simnet.callPublicFn(CONTRACT, "cancel-listing", [Cl.uint(0)], anyone);
      expect(result.result).toBeOk(Cl.bool(true));

      const buyerBal = simnet.callReadOnlyFn(SBTC, "get-balance", [Cl.principal(buyer)], deployer);
      expect(buyerBal.result).toBeOk(Cl.uint(100000));
    });

    it("committed listing cannot be cancelled before delivery expiry", () => {
      simnet.callPublicFn(
        CONTRACT, "list-inscription",
        [Cl.buffer(inscriptionTxid), Cl.uint(0), Cl.uint(100000), Cl.uint(0), Cl.buffer(sellerBtc)],
        seller
      );
      mintSbtc(buyer, 100000);
      simnet.callPublicFn(CONTRACT, "accept-listing", [Cl.uint(0), Cl.buffer(buyerBtc)], buyer);
      mintSbtc(seller, 0);
      simnet.callPublicFn(CONTRACT, "commit-listing", [Cl.uint(0), Cl.uint(0)], seller);

      // Try cancel before EXPIRY (100 blocks from commit)
      const result = simnet.callPublicFn(CONTRACT, "cancel-listing", [Cl.uint(0)], anyone);
      expect(result.result).toBeErr(Cl.uint(13)); // ERR_NOT_EXPIRED
    });

    it("committed listing cancel after expiry: buyer gets price + premium + collateral", () => {
      // List with premium = 5000
      simnet.callPublicFn(
        CONTRACT, "list-inscription",
        [Cl.buffer(inscriptionTxid), Cl.uint(0), Cl.uint(100000), Cl.uint(5000), Cl.buffer(sellerBtc)],
        seller
      );
      mintSbtc(buyer, 105000);
      simnet.callPublicFn(CONTRACT, "accept-listing", [Cl.uint(0), Cl.buffer(buyerBtc)], buyer);

      // Seller commits with collateral = 10000 (> premium of 5000)
      mintSbtc(seller, 10000);
      simnet.callPublicFn(CONTRACT, "commit-listing", [Cl.uint(0), Cl.uint(10000)], seller);

      // Seller balance = 0 now (collateral in escrow)
      const sellerBalAfterCommit = simnet.callReadOnlyFn(SBTC, "get-balance", [Cl.principal(seller)], deployer);
      expect(sellerBalAfterCommit.result).toBeOk(Cl.uint(0));

      // Mine 101 blocks to pass EXPIRY (100 blocks from commit)
      simnet.mineEmptyBurnBlocks(101);

      const result = simnet.callPublicFn(CONTRACT, "cancel-listing", [Cl.uint(0)], anyone);
      expect(result.result).toBeOk(Cl.bool(true));

      // Buyer should receive: price (100000) + premium (5000) + collateral (10000) = 115000
      const buyerBal = simnet.callReadOnlyFn(SBTC, "get-balance", [Cl.principal(buyer)], deployer);
      expect(buyerBal.result).toBeOk(Cl.uint(115000));

      // Seller lost their collateral
      const sellerBal = simnet.callReadOnlyFn(SBTC, "get-balance", [Cl.principal(seller)], deployer);
      expect(sellerBal.result).toBeOk(Cl.uint(0));
    });
  });

  describe("relisting after cancel", () => {
    it("same inscription can be relisted after cancel", () => {
      simnet.callPublicFn(
        CONTRACT, "list-inscription",
        [Cl.buffer(inscriptionTxid), Cl.uint(0), Cl.uint(100000), Cl.uint(0), Cl.buffer(sellerBtc)],
        seller
      );
      simnet.callPublicFn(CONTRACT, "cancel-listing", [Cl.uint(0)], seller);

      // Relist same inscription
      const result = simnet.callPublicFn(
        CONTRACT, "list-inscription",
        [Cl.buffer(inscriptionTxid), Cl.uint(0), Cl.uint(80000), Cl.uint(0), Cl.buffer(sellerBtc)],
        seller
      );
      expect(result.result).toBeOk(Cl.uint(1)); // new id
    });
  });

  describe("get-next-id", () => {
    it("starts at 0", () => {
      const result = simnet.callReadOnlyFn(CONTRACT, "get-next-id", [], deployer);
      expect(result.result).toBeUint(0);
    });

    it("increments after listing", () => {
      simnet.callPublicFn(
        CONTRACT, "list-inscription",
        [Cl.buffer(inscriptionTxid), Cl.uint(0), Cl.uint(50000), Cl.uint(0), Cl.buffer(sellerBtc)],
        seller
      );
      const result = simnet.callReadOnlyFn(CONTRACT, "get-next-id", [], deployer);
      expect(result.result).toBeUint(1);
    });
  });

  describe("hardening: minimum price", () => {
    it("rejects listing with price below MIN_PRICE (1000)", () => {
      const result = simnet.callPublicFn(
        CONTRACT, "list-inscription",
        [Cl.buffer(inscriptionTxid), Cl.uint(0), Cl.uint(999), Cl.uint(0), Cl.buffer(sellerBtc)],
        seller
      );
      expect(result.result).toBeErr(Cl.uint(14)); // ERR_DUST_AMOUNT
    });

    it("accepts listing with price exactly MIN_PRICE", () => {
      const result = simnet.callPublicFn(
        CONTRACT, "list-inscription",
        [Cl.buffer(inscriptionTxid), Cl.uint(0), Cl.uint(1000), Cl.uint(0), Cl.buffer(sellerBtc)],
        seller
      );
      expect(result.result).toBeOk(Cl.uint(0));
    });

    it("rejects listing with zero price", () => {
      const result = simnet.callPublicFn(
        CONTRACT, "list-inscription",
        [Cl.buffer(inscriptionTxid), Cl.uint(0), Cl.uint(0), Cl.uint(0), Cl.buffer(sellerBtc)],
        seller
      );
      expect(result.result).toBeErr(Cl.uint(14)); // ERR_DUST_AMOUNT
    });
  });

  describe("hardening: self-trade prevention", () => {
    it("rejects buyer == seller", () => {
      simnet.callPublicFn(
        CONTRACT, "list-inscription",
        [Cl.buffer(inscriptionTxid), Cl.uint(0), Cl.uint(100000), Cl.uint(0), Cl.buffer(sellerBtc)],
        seller
      );
      mintSbtc(seller, 100000);
      const result = simnet.callPublicFn(
        CONTRACT, "accept-listing",
        [Cl.uint(0), Cl.buffer(buyerBtc)],
        seller  // same as listing seller
      );
      expect(result.result).toBeErr(Cl.uint(15)); // ERR_SELF_TRADE
    });
  });

  describe("zero-premium listing", () => {
    it("works without premium", () => {
      simnet.callPublicFn(
        CONTRACT, "list-inscription",
        [Cl.buffer(inscriptionTxid), Cl.uint(0), Cl.uint(50000), Cl.uint(0), Cl.buffer(sellerBtc)],
        seller
      );
      mintSbtc(buyer, 50000);
      const result = simnet.callPublicFn(CONTRACT, "accept-listing", [Cl.uint(0), Cl.buffer(buyerBtc)], buyer);
      expect(result.result).toBeOk(Cl.bool(true));

      // SEC-08: Seller gets 0 until settlement (premium also 0 so same net effect)
      const sellerBal = simnet.callReadOnlyFn(SBTC, "get-balance", [Cl.principal(seller)], deployer);
      expect(sellerBal.result).toBeOk(Cl.uint(0));
    });

    it("seller can commit with zero collateral on zero-premium listing", () => {
      simnet.callPublicFn(
        CONTRACT, "list-inscription",
        [Cl.buffer(inscriptionTxid), Cl.uint(0), Cl.uint(50000), Cl.uint(0), Cl.buffer(sellerBtc)],
        seller
      );
      mintSbtc(buyer, 50000);
      simnet.callPublicFn(CONTRACT, "accept-listing", [Cl.uint(0), Cl.buffer(buyerBtc)], buyer);

      // Zero premium => zero minimum collateral
      const result = simnet.callPublicFn(
        CONTRACT, "commit-listing",
        [Cl.uint(0), Cl.uint(0)],
        seller
      );
      expect(result.result).toBeOk(Cl.bool(true));
    });
  });

  describe("2-phase settlement: submit-proof requires committed state", () => {
    it("submit-proof fails if listing is escrowed (not yet committed)", () => {
      simnet.callPublicFn(
        CONTRACT, "list-inscription",
        [Cl.buffer(inscriptionTxid), Cl.uint(0), Cl.uint(100000), Cl.uint(0), Cl.buffer(sellerBtc)],
        seller
      );
      mintSbtc(buyer, 100000);
      simnet.callPublicFn(CONTRACT, "accept-listing", [Cl.uint(0), Cl.buffer(buyerBtc)], buyer);

      // Attempt submit-proof from escrowed state (should fail ERR_NOT_COMMITTED = u16)
      // We use minimal/fake proof args — should fail at state check before BTC verification
      const dummyHeader = new Uint8Array(80).fill(0x00);
      const dummyTx = {
        version: Cl.buffer(new Uint8Array(4).fill(0x01)),
        ins: Cl.list([]),
        outs: Cl.list([]),
        locktime: Cl.buffer(new Uint8Array(4).fill(0x00)),
      };
      const dummyProof = {
        "tx-index": Cl.uint(0),
        hashes: Cl.list([]),
        "tree-depth": Cl.uint(0),
      };

      const result = simnet.callPublicFn(
        CONTRACT, "submit-proof",
        [
          Cl.uint(0),
          Cl.uint(800000),
          Cl.buffer(dummyHeader),
          Cl.tuple({
            version: Cl.buffer(new Uint8Array(4).fill(0x01)),
            ins: Cl.list([]),
            outs: Cl.list([]),
            locktime: Cl.buffer(new Uint8Array(4).fill(0x00)),
          }),
          Cl.tuple({
            "tx-index": Cl.uint(0),
            hashes: Cl.list([]),
            "tree-depth": Cl.uint(0),
          }),
        ],
        anyone
      );
      // Should fail with ERR_NOT_COMMITTED (u16)
      expect(result.result).toBeErr(Cl.uint(16));
    });
  });
});
