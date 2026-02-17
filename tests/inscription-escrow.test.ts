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
    it("buyer accepts and sBTC is escrowed", () => {
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

      // Verify buyer balance decreased
      const buyerBal = simnet.callReadOnlyFn(SBTC, "get-balance", [Cl.principal(buyer)], deployer);
      expect(buyerBal.result).toBeOk(Cl.uint(0)); // all spent

      // Verify seller got premium
      const sellerBal = simnet.callReadOnlyFn(SBTC, "get-balance", [Cl.principal(seller)], deployer);
      expect(sellerBal.result).toBeOk(Cl.uint(5000));
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

    it("escrowed listing cannot be cancelled before expiry", () => {
      simnet.callPublicFn(
        CONTRACT, "list-inscription",
        [Cl.buffer(inscriptionTxid), Cl.uint(0), Cl.uint(100000), Cl.uint(0), Cl.buffer(sellerBtc)],
        seller
      );
      mintSbtc(buyer, 100000);
      simnet.callPublicFn(CONTRACT, "accept-listing", [Cl.uint(0), Cl.buffer(buyerBtc)], buyer);

      // Try cancel before expiry
      const result = simnet.callPublicFn(CONTRACT, "cancel-listing", [Cl.uint(0)], anyone);
      expect(result.result).toBeErr(Cl.uint(13)); // ERR_NOT_EXPIRED
    });

    it("escrowed listing can be cancelled after expiry, refunds buyer", () => {
      simnet.callPublicFn(
        CONTRACT, "list-inscription",
        [Cl.buffer(inscriptionTxid), Cl.uint(0), Cl.uint(100000), Cl.uint(0), Cl.buffer(sellerBtc)],
        seller
      );
      mintSbtc(buyer, 100000);
      simnet.callPublicFn(CONTRACT, "accept-listing", [Cl.uint(0), Cl.buffer(buyerBtc)], buyer);

      // Mine 101 blocks to pass expiry
      simnet.mineEmptyBurnBlocks(101);

      const result = simnet.callPublicFn(CONTRACT, "cancel-listing", [Cl.uint(0)], anyone);
      expect(result.result).toBeOk(Cl.bool(true));

      // Buyer should have sBTC refunded
      const buyerBal = simnet.callReadOnlyFn(SBTC, "get-balance", [Cl.principal(buyer)], deployer);
      expect(buyerBal.result).toBeOk(Cl.uint(100000));
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

      // Seller should have 0 sBTC (no premium)
      const sellerBal = simnet.callReadOnlyFn(SBTC, "get-balance", [Cl.principal(seller)], deployer);
      expect(sellerBal.result).toBeOk(Cl.uint(0));
    });
  });
});
