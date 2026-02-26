/**
 * Inscription Escrow API
 * 
 * REST API for querying inscription escrow trades.
 * Reads on-chain state via Stacks read-only contract calls.
 * 
 * Endpoints:
 *   GET /trades          — list open trades (with optional status filter)
 *   GET /trades/:id      — get trade details by listing ID
 *   GET /trades/stats    — summary stats (total, open, escrowed, done, cancelled)
 *   GET /health          — health check
 */

import { Hono } from 'hono';
import { serve } from '@hono/node-server';

// --- Config ---
const PORT = parseInt(process.env.PORT || '3100');
const STACKS_API = process.env.STACKS_API || 'https://api.hiro.so';
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || 'SP16H0KE0BPR4XNQ64115V5Y1V3XTPGMWG5YPC9TR';
const CONTRACT_NAME = process.env.CONTRACT_NAME || 'inscription-escrow';

// --- Stacks helpers ---

/**
 * Call a read-only function on the escrow contract
 */
async function callReadOnly(functionName, args = []) {
  const url = `${STACKS_API}/v2/contracts/call-read/${CONTRACT_ADDRESS}/${CONTRACT_NAME}/${functionName}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sender: CONTRACT_ADDRESS,
      arguments: args,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Stacks API ${res.status}: contract may not be deployed — ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  if (!data.okay && data.cause) {
    throw new Error(`Contract error: ${data.cause}`);
  }
  return data;
}

/**
 * Decode a Clarity value from hex to a JS object.
 * Simplified parser for the types we use.
 */
function decodeClarityHex(hex) {
  if (!hex || typeof hex !== 'string') return null;
  // Remove 0x prefix if present
  if (hex.startsWith('0x')) hex = hex.slice(2);
  if (!hex.length) return null;
  const buf = Buffer.from(hex, 'hex');
  return decodeClarityValue(buf, 0).value;
}

function decodeClarityValue(buf, offset) {
  const type = buf[offset];
  offset++;

  switch (type) {
    case 0x00: // int
      return { value: readInt128(buf, offset), size: 17 };
    case 0x01: // uint
      return { value: readUint128(buf, offset), size: 17 };
    case 0x02: // buffer
      {
        const len = buf.readUInt32BE(offset);
        offset += 4;
        const data = buf.slice(offset, offset + len);
        return { value: data.toString('hex'), size: 5 + len };
      }
    case 0x03: // true
      return { value: true, size: 1 };
    case 0x04: // false
      return { value: false, size: 1 };
    case 0x05: // standard principal
      {
        const version = buf[offset];
        const hash = buf.slice(offset + 1, offset + 21);
        // Simplified: return hex representation
        return { value: `principal:${version}:${hash.toString('hex')}`, size: 22 };
      }
    case 0x06: // contract principal
      {
        const version = buf[offset];
        const hash = buf.slice(offset + 1, offset + 21);
        const nameLen = buf[offset + 21];
        const name = buf.slice(offset + 22, offset + 22 + nameLen).toString('ascii');
        return { value: `${version}:${hash.toString('hex')}.${name}`, size: 23 + nameLen };
      }
    case 0x07: // ok
      {
        const inner = decodeClarityValue(buf, offset);
        return { value: { ok: inner.value }, size: 1 + inner.size };
      }
    case 0x08: // err
      {
        const inner = decodeClarityValue(buf, offset);
        return { value: { err: inner.value }, size: 1 + inner.size };
      }
    case 0x09: // none
      return { value: null, size: 1 };
    case 0x0a: // some
      {
        const inner = decodeClarityValue(buf, offset);
        return { value: inner.value, size: 1 + inner.size };
      }
    case 0x0b: // list
      {
        const len = buf.readUInt32BE(offset);
        offset += 4;
        const items = [];
        let totalSize = 5;
        for (let i = 0; i < len; i++) {
          const item = decodeClarityValue(buf, offset);
          items.push(item.value);
          offset += item.size;
          totalSize += item.size;
        }
        return { value: items, size: totalSize };
      }
    case 0x0c: // tuple
      {
        const len = buf.readUInt32BE(offset);
        offset += 4;
        const obj = {};
        let totalSize = 5;
        for (let i = 0; i < len; i++) {
          const nameLen = buf[offset];
          offset++;
          const name = buf.slice(offset, offset + nameLen).toString('ascii');
          offset += nameLen;
          const val = decodeClarityValue(buf, offset);
          obj[name] = val.value;
          offset += val.size;
          totalSize += 1 + nameLen + val.size;
        }
        return { value: obj, size: totalSize };
      }
    case 0x0d: // string-ascii
      {
        const len = buf.readUInt32BE(offset);
        offset += 4;
        const str = buf.slice(offset, offset + len).toString('ascii');
        return { value: str, size: 5 + len };
      }
    case 0x0e: // string-utf8
      {
        const len = buf.readUInt32BE(offset);
        offset += 4;
        const str = buf.slice(offset, offset + len).toString('utf8');
        return { value: str, size: 5 + len };
      }
    default:
      return { value: `unknown_type_${type}`, size: 1 };
  }
}

function readUint128(buf, offset) {
  // Read as BigInt, convert to number if safe
  const high = buf.readBigUInt64BE(offset);
  const low = buf.readBigUInt64BE(offset + 8);
  const val = (high << 64n) | low;
  return val <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(val) : val.toString();
}

function readInt128(buf, offset) {
  const high = buf.readBigInt64BE(offset);
  const low = buf.readBigUInt64BE(offset + 8);
  const val = (high << 64n) | low;
  return val <= BigInt(Number.MAX_SAFE_INTEGER) && val >= BigInt(Number.MIN_SAFE_INTEGER) 
    ? Number(val) : val.toString();
}

/**
 * Format a listing for API response
 */
function formatListing(id, raw) {
  return {
    id,
    inscriptionTxid: raw['inscription-txid'],
    inscriptionVout: raw['inscription-vout'],
    price: raw.price,
    premium: raw.premium,
    seller: raw.seller,
    buyer: raw.buyer,
    sellerBtc: raw['seller-btc'],
    buyerBtc: raw['buyer-btc'],
    blockHeight: raw.when,
    status: raw.status?.trim?.() || raw.status,
  };
}

/**
 * Encode a uint as Clarity hex (for read-only call args)
 */
function encodeUint(n) {
  const buf = Buffer.alloc(17);
  buf[0] = 0x01; // uint type
  buf.writeBigUInt64BE(0n, 1);
  buf.writeBigUInt64BE(BigInt(n), 9);
  return '0x' + buf.toString('hex');
}

// --- Hono App ---

const app = new Hono();

// Health check
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    contract: `${CONTRACT_ADDRESS}.${CONTRACT_NAME}`,
    api: STACKS_API,
    timestamp: new Date().toISOString(),
  });
});

// Get trade by ID
app.get('/trades/stats', async (c) => {
  try {
    const nextIdRes = await callReadOnly('get-next-id');
    const nextId = decodeClarityHex(nextIdRes.result);
    
    const stats = { total: nextId, open: 0, escrowed: 0, done: 0, cancelled: 0 };
    
    // Scan all listings (fine for small counts, paginate later)
    const promises = [];
    for (let i = 0; i < nextId && i < 100; i++) {
      promises.push(
        callReadOnly('get-listing', [encodeUint(i)])
          .then(res => {
            if (res.result && !res.result.includes('09')) { // not none
              const listing = decodeClarityHex(res.result);
              if (listing) {
                const status = (listing.status?.trim?.() || listing.status || '').toLowerCase();
                if (stats[status] !== undefined) stats[status]++;
              }
            }
          })
          .catch(() => {})
      );
    }
    await Promise.all(promises);
    
    return c.json(stats);
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// List trades (with optional status filter)
app.get('/trades', async (c) => {
  const statusFilter = c.req.query('status'); // open, escrowed, done, cancelled
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);
  const offset = parseInt(c.req.query('offset') || '0');

  try {
    // Get total count
    const nextIdRes = await callReadOnly('get-next-id');
    const nextId = decodeClarityHex(nextIdRes.result);

    if (nextId === 0) {
      return c.json({ trades: [], total: 0, hasMore: false });
    }

    // Fetch listings in parallel (batched)
    const trades = [];
    const batchSize = Math.min(nextId, 50);
    const promises = [];

    for (let i = 0; i < batchSize; i++) {
      promises.push(
        callReadOnly('get-listing', [encodeUint(i)])
          .then(res => ({ id: i, res }))
          .catch(err => ({ id: i, error: err.message }))
      );
    }

    const results = await Promise.all(promises);

    for (const { id, res, error } of results) {
      if (error || !res?.result) continue;
      try {
        const raw = decodeClarityHex(res.result);
        if (!raw || typeof raw !== 'object') continue;
        const listing = formatListing(id, raw);
        
        // Apply status filter
        if (statusFilter && listing.status !== statusFilter) continue;
        trades.push(listing);
      } catch {
        // Skip unparseable
      }
    }

    // Apply pagination
    const paginated = trades.slice(offset, offset + limit);

    return c.json({
      trades: paginated,
      total: trades.length,
      offset,
      limit,
      hasMore: offset + limit < trades.length,
    });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// Get trade by ID
app.get('/trades/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  
  if (isNaN(id) || id < 0) {
    return c.json({ error: 'Invalid trade ID' }, 400);
  }

  try {
    const res = await callReadOnly('get-listing', [encodeUint(id)]);
    
    if (!res.result) {
      return c.json({ error: 'Trade not found' }, 404);
    }

    const raw = decodeClarityHex(res.result);
    
    if (!raw || raw === null) {
      return c.json({ error: 'Trade not found' }, 404);
    }

    const trade = formatListing(id, raw);

    // Enrich with inscription data if possible
    let inscription = null;
    if (trade.inscriptionTxid) {
      try {
        const inscRes = await fetch(
          `https://api.hiro.so/ordinals/v1/inscriptions?output=${trade.inscriptionTxid}:${trade.inscriptionVout}`
        );
        if (inscRes.ok) {
          const inscData = await inscRes.json();
          if (inscData.results?.length > 0) {
            const insc = inscData.results[0];
            inscription = {
              id: insc.id,
              number: insc.number,
              contentType: insc.content_type,
              contentLength: insc.content_length,
            };
          }
        }
      } catch {
        // Inscription enrichment is optional
      }
    }

    return c.json({ trade, inscription });
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// --- Ledger validation endpoints (inscription-escrow#3) ---

import { validateInscription, getSellerReputation, preAcceptanceCheck } from './ledger-validator.mjs';

app.get('/validate/:inscriptionId', async (c) => {
  try {
    const result = await validateInscription(c.req.param('inscriptionId'));
    return c.json(result);
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

app.get('/reputation/:btcAddress', async (c) => {
  try {
    const rep = await getSellerReputation(c.req.param('btcAddress'));
    if (!rep) return c.json({ error: 'Could not fetch reputation' }, 502);
    return c.json(rep);
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

app.get('/pre-check/:inscriptionId/:sellerBtcAddress', async (c) => {
  try {
    const result = await preAcceptanceCheck(
      c.req.param('inscriptionId'),
      c.req.param('sellerBtcAddress')
    );
    return c.json(result);
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

// --- Start server ---
console.log(`Inscription Escrow API starting on port ${PORT}`);
console.log(`Contract: ${CONTRACT_ADDRESS}.${CONTRACT_NAME}`);
console.log(`Stacks API: ${STACKS_API}`);

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`Listening on http://localhost:${info.port}`);
});
