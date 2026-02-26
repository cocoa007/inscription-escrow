/**
 * Settlement Logger — Post-trade ledger recording via ledger.drx4.xyz
 *
 * Implements inscription-escrow#3 point 2:
 * After a trade completes, log the settlement event to the public ledger
 * so future pre-acceptance checks can surface trade history and
 * seller reputation correctly.
 *
 * Usage:
 *   import { logSettlement } from './settlement-logger.mjs';
 *   const result = await logSettlement(tradeData, signFn);
 *
 * The signFn abstraction allows different agents to use their own signing
 * method (BIP-137, Schnorr, etc.) without coupling this module to any
 * particular key management approach.
 */

const LEDGER_API = process.env.LEDGER_API || 'https://ledger.drx4.xyz/api';

/**
 * Log a completed inscription trade to the public ledger.
 *
 * @param {Object} tradeData - Completed trade info
 * @param {string} tradeData.from_agent  - Seller BTC address
 * @param {string} tradeData.to_agent    - Buyer BTC address
 * @param {string} tradeData.inscription_id - Inscription ID being traded
 * @param {number} tradeData.price_sats  - Final agreed price in satoshis
 * @param {Function} signFn - Async function(message: string) => base64 BIP-137 signature
 * @returns {Promise<{success: boolean, tradeId: string|null, error: string|null}>}
 */
export async function logSettlement(tradeData, signFn) {
  try {
    const timestamp = new Date().toISOString();

    // Build the payload without signature first so we can sign it
    const unsigned = {
      type: 'swap',
      from_agent: tradeData.from_agent,
      to_agent: tradeData.to_agent,
      inscription_id: tradeData.inscription_id,
      price_sats: tradeData.price_sats,
      timestamp,
    };

    // Sign the canonical JSON string (no signature field, deterministic key order)
    const message = JSON.stringify(unsigned);
    let signature = null;
    if (typeof signFn === 'function') {
      try {
        signature = await signFn(message);
      } catch (signErr) {
        // Signing failure is non-fatal — log without signature
        console.warn('[settlement-logger] Sign failed (logging unsigned):', signErr.message);
      }
    }

    const payload = { ...unsigned, signature };

    const res = await fetch(`${LEDGER_API}/trades`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text();
      return {
        success: false,
        tradeId: null,
        error: `Ledger API returned ${res.status}: ${text.slice(0, 200)}`,
      };
    }

    const data = await res.json();
    return {
      success: true,
      tradeId: data.id || data.tradeId || null,
      error: null,
    };
  } catch (err) {
    // Settlement logging must never throw — escrow flow takes priority
    return {
      success: false,
      tradeId: null,
      error: err.message,
    };
  }
}
