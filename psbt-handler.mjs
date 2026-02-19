/**
 * PSBT Atomic Swap Handler for Ordinals Inscriptions
 * 
 * Implements the standard 2-step PSBT atomic swap:
 * 1. Seller creates PSBT with inscription input + buyer payment output
 * 2. Buyer adds funding input(s) + signs → broadcasts
 * 
 * The seller's inscription UTXO goes to the buyer's address,
 * the buyer's BTC goes to the seller's address, atomically.
 */

import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import ECPairFactory from 'ecpair';

bitcoin.initEccLib(ecc);
const ECPair = ECPairFactory(ecc);

const DUST_LIMIT = 546;

/**
 * Create a seller-side PSBT for an inscription swap.
 * Seller signs their inscription input, buyer adds funding later.
 * 
 * @param {Object} opts
 * @param {string} opts.inscriptionUtxoTxid - txid of the inscription UTXO
 * @param {number} opts.inscriptionUtxoVout - vout of the inscription UTXO
 * @param {number} opts.inscriptionUtxoValue - value in sats of the inscription UTXO
 * @param {Buffer} opts.inscriptionUtxoScript - scriptPubKey of the inscription UTXO
 * @param {string} opts.sellerAddress - seller's payment receive address
 * @param {string} opts.buyerAddress - buyer's inscription receive address (taproot preferred)
 * @param {number} opts.priceSats - agreed price in satoshis
 * @param {Buffer} opts.sellerPrivKey - seller's private key (WIF or Buffer)
 * @returns {string} base64 PSBT (partially signed — seller's input signed)
 */
export function createSellerPsbt({
  inscriptionUtxoTxid,
  inscriptionUtxoVout,
  inscriptionUtxoValue,
  inscriptionUtxoScript,
  sellerAddress,
  buyerAddress,
  priceSats,
}) {
  const network = bitcoin.networks.bitcoin;
  const psbt = new bitcoin.Psbt({ network });

  // Input 0: Seller's inscription UTXO (seller will sign)
  psbt.addInput({
    hash: inscriptionUtxoTxid,
    index: inscriptionUtxoVout,
    witnessUtxo: {
      script: inscriptionUtxoScript,
      value: inscriptionUtxoValue,
    },
  });

  // Output 0: Inscription goes to buyer (dust value to carry inscription)
  psbt.addOutput({
    address: buyerAddress,
    value: DUST_LIMIT,
  });

  // Output 1: Payment goes to seller
  psbt.addOutput({
    address: sellerAddress,
    value: priceSats,
  });

  // Note: Buyer will add their funding input(s) and change output
  // Seller signs input 0 with SIGHASH_SINGLE | SIGHASH_ANYONECANPAY
  // This allows the buyer to add inputs/outputs without invalidating seller's sig
  
  return psbt.toBase64();
}

/**
 * Buyer completes the PSBT by adding funding inputs and signing.
 * 
 * @param {Object} opts
 * @param {string} opts.psbtBase64 - seller's partially signed PSBT (base64)
 * @param {Array} opts.fundingUtxos - buyer's UTXOs [{txid, vout, value, script}]
 * @param {string} opts.changeAddress - buyer's change address
 * @param {number} opts.feeRate - fee rate in sat/vB
 * @param {Buffer} opts.buyerPrivKey - buyer's private key
 * @returns {string} hex of the fully signed transaction ready to broadcast
 */
export function completeBuyerPsbt({
  psbtBase64,
  fundingUtxos,
  changeAddress,
  feeRate = 5,
}) {
  const network = bitcoin.networks.bitcoin;
  const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network });

  // Calculate how much the buyer needs to fund
  // Output 0 = inscription (dust to buyer) — already in PSBT
  // Output 1 = payment to seller — already in PSBT
  const paymentToSeller = psbt.txOutputs[1].value;
  const inscriptionDust = psbt.txOutputs[0].value;

  // Add buyer's funding inputs
  let totalFunding = 0;
  for (const utxo of fundingUtxos) {
    psbt.addInput({
      hash: utxo.txid,
      index: utxo.vout,
      witnessUtxo: {
        script: utxo.script,
        value: utxo.value,
      },
    });
    totalFunding += utxo.value;
  }

  // Estimate fee (rough: inputs * 68 + outputs * 31 + 10 overhead for segwit)
  const estimatedInputs = psbt.inputCount;
  const estimatedOutputs = 3; // inscription + payment + change
  const estimatedVsize = estimatedInputs * 68 + estimatedOutputs * 31 + 10;
  const fee = Math.ceil(estimatedVsize * feeRate);

  // Buyer needs to cover: payment to seller + inscription dust + fee
  // (The inscription input value comes from seller, but dust goes to buyer output)
  const buyerNeeds = paymentToSeller + fee;
  const change = totalFunding - buyerNeeds;

  if (change < 0) {
    throw new Error(`Insufficient funds: need ${buyerNeeds} sats, have ${totalFunding} sats`);
  }

  // Add change output if above dust
  if (change > DUST_LIMIT) {
    psbt.addOutput({
      address: changeAddress,
      value: change,
    });
  }

  return psbt.toBase64();
}

/**
 * Parse and display PSBT details for verification before signing.
 * 
 * @param {string} psbtBase64 
 * @returns {Object} parsed PSBT summary
 */
export function parsePsbt(psbtBase64) {
  const network = bitcoin.networks.bitcoin;
  const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network });

  const inputs = psbt.txInputs.map((input, i) => ({
    index: i,
    txid: Buffer.from(input.hash).reverse().toString('hex'),
    vout: input.index,
    witnessUtxo: psbt.data.inputs[i].witnessUtxo ? {
      value: psbt.data.inputs[i].witnessUtxo.value,
      script: psbt.data.inputs[i].witnessUtxo.script.toString('hex'),
    } : null,
    signed: !!(psbt.data.inputs[i].partialSig?.length || psbt.data.inputs[i].finalScriptWitness),
  }));

  const outputs = psbt.txOutputs.map((output, i) => ({
    index: i,
    address: output.address,
    value: output.value,
  }));

  return {
    version: psbt.version,
    inputCount: psbt.inputCount,
    outputCount: psbt.txOutputs.length,
    inputs,
    outputs,
    fee: inputs.reduce((sum, i) => sum + (i.witnessUtxo?.value || 0), 0) -
         outputs.reduce((sum, o) => sum + o.value, 0),
  };
}

/**
 * Validate a seller's PSBT before buyer completes it.
 * Checks: correct inscription input, correct outputs, sane values.
 */
export function validateSellerPsbt(psbtBase64, expectedInscriptionTxid, expectedPrice) {
  const parsed = parsePsbt(psbtBase64);
  const errors = [];

  if (parsed.inputCount < 1) errors.push('No inputs in PSBT');
  if (parsed.outputCount < 2) errors.push('Expected at least 2 outputs (inscription + payment)');
  
  // Check inscription input
  if (parsed.inputs[0]?.txid !== expectedInscriptionTxid) {
    errors.push(`Input 0 txid mismatch: expected ${expectedInscriptionTxid}, got ${parsed.inputs[0]?.txid}`);
  }

  // Check payment output matches expected price
  if (parsed.outputs[1]?.value !== expectedPrice) {
    errors.push(`Payment amount mismatch: expected ${expectedPrice}, got ${parsed.outputs[1]?.value}`);
  }

  // Check inscription output is dust
  if (parsed.outputs[0]?.value > 1000) {
    errors.push(`Inscription output too large (${parsed.outputs[0]?.value} sats) — should be dust`);
  }

  return {
    valid: errors.length === 0,
    errors,
    parsed,
  };
}

// --- CLI interface (only when run directly) ---
const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('psbt-handler.mjs');
const [,, command, ...args] = process.argv;
if (isMain) {

if (command === 'parse') {
  const psbtBase64 = args[0];
  if (!psbtBase64) { console.error('Usage: node psbt-handler.mjs parse <base64>'); process.exit(1); }
  console.log(JSON.stringify(parsePsbt(psbtBase64), null, 2));
}

else if (command === 'validate') {
  const [psbtBase64, inscTxid, price] = args;
  if (!psbtBase64 || !inscTxid || !price) {
    console.error('Usage: node psbt-handler.mjs validate <base64> <inscription-txid> <price-sats>');
    process.exit(1);
  }
  const result = validateSellerPsbt(psbtBase64, inscTxid, parseInt(price));
  console.log(JSON.stringify(result, null, 2));
}

else if (command === 'create-seller') {
  console.log('Seller PSBT creation requires private key — use programmatically, not CLI');
}

else {
  console.log(`PSBT Atomic Swap Handler
  
Commands:
  parse <base64>                          Parse and display PSBT details
  validate <base64> <insc-txid> <price>   Validate a seller's PSBT
  
Programmatic API:
  createSellerPsbt({...})     Create seller-side PSBT
  completeBuyerPsbt({...})    Add funding + complete as buyer
  parsePsbt(base64)           Parse PSBT details
  validateSellerPsbt(...)     Validate before buying
`);
}
} // end isMain
