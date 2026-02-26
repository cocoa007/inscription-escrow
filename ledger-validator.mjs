/**
 * Ledger Validator — Pre-acceptance trade validation via ledger.drx4.xyz
 * 
 * Implements inscription-escrow#3 point 1:
 * Before accepting an inscription trade in escrow, query the public ledger
 * to check if the inscription has been traded before, detect potential
 * double-spend attempts, and surface seller reputation.
 * 
 * Usage:
 *   import { validateInscription, getSellerReputation } from './ledger-validator.mjs';
 *   const result = await validateInscription(inscriptionId);
 *   const rep = await getSellerReputation(btcAddress);
 */

const LEDGER_API = process.env.LEDGER_API || 'https://ledger.drx4.xyz/api';

/**
 * Check if an inscription has any prior trades on the ledger.
 * Returns { safe, trades, warnings }
 * - safe: true if no conflicting trades found
 * - trades: matching trade records
 * - warnings: human-readable risk flags
 */
export async function validateInscription(inscriptionId) {
  const warnings = [];

  try {
    const res = await fetch(`${LEDGER_API}/trades?inscription_id=${encodeURIComponent(inscriptionId)}`);
    if (!res.ok) {
      warnings.push(`Ledger API returned ${res.status} — cannot validate`);
      return { safe: null, trades: [], warnings };
    }

    const data = await res.json();
    const trades = data.trades || [];

    // Filter trades involving this inscription
    const matching = trades.filter(t =>
      t.inscription_id === inscriptionId
    );

    if (matching.length === 0) {
      return { safe: true, trades: [], warnings: [] };
    }

    // Check for completed trades — inscription may have changed hands
    const completed = matching.filter(t => t.status === 'completed');
    if (completed.length > 0) {
      const latest = completed.sort((a, b) =>
        new Date(b.created_at) - new Date(a.created_at)
      )[0];
      warnings.push(
        `Inscription was last traded ${latest.created_at} ` +
        `(${latest.from_name} → ${latest.to_name}). ` +
        `Verify current ownership before accepting.`
      );
    }

    // Check for open offers — potential double-listing
    const open = matching.filter(t => t.status === 'open');
    if (open.length > 0) {
      warnings.push(
        `${open.length} open offer(s) exist for this inscription — possible double-listing`
      );
    }

    return {
      safe: warnings.length === 0,
      trades: matching,
      warnings
    };
  } catch (err) {
    warnings.push(`Ledger check failed: ${err.message}`);
    return { safe: null, trades: [], warnings };
  }
}

/**
 * Get seller reputation from trade history.
 * Returns { totalTrades, completedTrades, asSellerCount, asBuyerCount, firstTradeDate }
 */
export async function getSellerReputation(btcAddress) {
  try {
    const res = await fetch(`${LEDGER_API}/trades`);
    if (!res.ok) return null;

    const data = await res.json();
    const trades = data.trades || [];

    const asSeller = trades.filter(t => t.from_agent === btcAddress && t.status === 'completed');
    const asBuyer = trades.filter(t => t.to_agent === btcAddress && t.status === 'completed');
    const all = [...asSeller, ...asBuyer];

    if (all.length === 0) return { totalTrades: 0, completedTrades: 0, asSellerCount: 0, asBuyerCount: 0, firstTradeDate: null };

    const sorted = all.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    return {
      totalTrades: all.length,
      completedTrades: all.length,
      asSellerCount: asSeller.length,
      asBuyerCount: asBuyer.length,
      firstTradeDate: sorted[0].created_at
    };
  } catch {
    return null;
  }
}

/**
 * Full pre-acceptance check — combines inscription validation + seller reputation.
 * Returns { proceed, inscription, seller, summary }
 */
export async function preAcceptanceCheck(inscriptionId, sellerBtcAddress) {
  const inscription = await validateInscription(inscriptionId);
  const seller = await getSellerReputation(sellerBtcAddress);

  const risks = [...inscription.warnings];
  if (seller && seller.totalTrades === 0) {
    risks.push('Seller has no prior trade history on the ledger');
  }

  const proceed = inscription.safe !== false && risks.length <= 1;

  return {
    proceed,
    inscription,
    seller,
    summary: risks.length === 0
      ? 'No risks detected — safe to proceed'
      : `${risks.length} risk(s): ${risks.join('; ')}`
  };
}
