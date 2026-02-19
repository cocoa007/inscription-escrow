/**
 * Trade Protocol Handler
 * 
 * Handles Tiny Marten's JSON trade messages:
 *   {"t":"trade","a":"list","i":"<inscription-id>","p":<price>,"n":"<name>"}
 *   {"t":"trade","a":"counter","i":"<inscription-id>","p":<price>}
 *   {"t":"trade","a":"accept","i":"<inscription-id>","psbt":"<base64>"}
 *   {"t":"trade","a":"complete","txid":"<broadcast-txid>"}
 * 
 * Flow:
 *   1. Seller sends "list" → offers inscription at a price
 *   2. Buyer sends "counter" or "accept"
 *   3. Seller sends "accept" with PSBT (partially signed)
 *   4. Buyer completes PSBT, broadcasts, sends "complete" with txid
 */

import { parsePsbt, validateSellerPsbt, completeBuyerPsbt } from './psbt-handler.mjs';

/**
 * Parse a trade protocol message from inbox
 */
export function parseTradeMessage(content) {
  try {
    const msg = JSON.parse(content);
    if (msg.t !== 'trade') return null;
    return {
      type: 'trade',
      action: msg.a,
      inscriptionId: msg.i,
      price: msg.p,
      name: msg.n,
      psbt: msg.psbt,
      txid: msg.txid,
    };
  } catch {
    return null;
  }
}

/**
 * Generate a bid/counter message
 */
export function createBidMessage(inscriptionId, priceSats) {
  return JSON.stringify({
    t: 'trade',
    a: 'counter',
    i: inscriptionId,
    p: priceSats,
  });
}

/**
 * Generate an accept message (buyer accepts seller's price)
 */
export function createAcceptMessage(inscriptionId) {
  return JSON.stringify({
    t: 'trade',
    a: 'accept',
    i: inscriptionId,
  });
}

/**
 * Generate a complete message after broadcast
 */
export function createCompleteMessage(txid) {
  return JSON.stringify({
    t: 'trade',
    a: 'complete',
    txid,
  });
}

/**
 * Evaluate a trade: should we accept, counter, or reject?
 * 
 * @param {Object} trade - parsed trade message
 * @param {number} maxBudget - max sats we're willing to spend
 * @param {number} currentBalance - our available BTC balance in sats
 * @returns {Object} decision
 */
export function evaluateTrade(trade, maxBudget, currentBalance) {
  if (!trade || trade.type !== 'trade') {
    return { action: 'ignore', reason: 'not a trade message' };
  }

  if (trade.action === 'list' || trade.action === 'counter') {
    const price = trade.price;
    
    // Can we afford it (with room for fees)?
    const estimatedFee = 2000; // ~2k sats for typical swap tx
    const totalCost = price + estimatedFee;
    
    if (totalCost > currentBalance) {
      return {
        action: 'reject',
        reason: `Can't afford: need ${totalCost} sats (${price} + ~${estimatedFee} fee), have ${currentBalance}`,
      };
    }

    if (price > maxBudget) {
      return {
        action: 'counter',
        reason: `Price ${price} exceeds budget ${maxBudget}`,
        suggestedPrice: maxBudget,
      };
    }

    return {
      action: 'accept',
      reason: `Price ${price} within budget ${maxBudget}`,
      price,
    };
  }

  if (trade.action === 'accept') {
    if (trade.psbt) {
      return {
        action: 'complete',
        reason: 'Seller accepted and provided PSBT — verify and sign',
        psbt: trade.psbt,
      };
    }
    return { action: 'wait', reason: 'Seller accepted but no PSBT yet' };
  }

  if (trade.action === 'complete') {
    return {
      action: 'verify',
      reason: 'Trade complete — verify txid on-chain',
      txid: trade.txid,
    };
  }

  return { action: 'ignore', reason: `Unknown trade action: ${trade.action}` };
}

// --- CLI ---
const [,, command, ...args] = process.argv;

if (command === 'parse') {
  const msg = parseTradeMessage(args[0]);
  console.log(JSON.stringify(msg, null, 2));
}

else if (command === 'bid') {
  const [inscId, price] = args;
  console.log(createBidMessage(inscId, parseInt(price)));
}

else if (command === 'accept') {
  console.log(createAcceptMessage(args[0]));
}

else if (command === 'evaluate') {
  const [msgJson, budget, balance] = args;
  const trade = parseTradeMessage(msgJson);
  const decision = evaluateTrade(trade, parseInt(budget), parseInt(balance));
  console.log(JSON.stringify(decision, null, 2));
}

else {
  console.log(`Trade Protocol Handler

Commands:
  parse <json>                        Parse a trade message
  bid <inscription-id> <price>        Create a counter/bid message
  accept <inscription-id>             Create an accept message
  evaluate <json> <budget> <balance>  Evaluate a trade offer

Trade Flow:
  1. Seller: {"t":"trade","a":"list","i":"...","p":10000,"n":"Test"}
  2. Buyer:  {"t":"trade","a":"counter","i":"...","p":8000}
  3. Seller: {"t":"trade","a":"accept","i":"...","psbt":"<base64>"}
  4. Buyer completes PSBT, broadcasts
  5. Buyer: {"t":"trade","a":"complete","txid":"..."}
`);
}
