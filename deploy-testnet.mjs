import {
  makeContractDeploy,
  broadcastTransaction,
  AnchorMode,
  PostConditionMode,
} from "/tmp/erc-8004-test/node_modules/@stacks/transactions/dist/index.js";
import { readFileSync } from "fs";

const DEPLOYER_KEY = "a4e2de75fc910865e339f22478fa3307c7c81cc635a2970ae413507b68ce899f01";
const DEPLOYER = "ST3D88581D35Z0ZAM7QFVWTDRM14N1TBEYWCGE4Z3";
const NETWORK_URL = "https://api.testnet.hiro.so";
const FEE = 100000;

async function deploy(contractName, sourceCode, nonce) {
  console.log(`Deploying ${contractName} (nonce=${nonce})...`);
  const tx = await makeContractDeploy({
    contractName,
    codeBody: sourceCode,
    senderKey: DEPLOYER_KEY,
    network: "testnet",
    anchorMode: AnchorMode.Any,
    postConditionMode: PostConditionMode.Allow,
    fee: FEE,
    nonce,
    clarityVersion: 3,
  });
  const result = await broadcastTransaction({ transaction: tx, network: "testnet" });
  console.log(`  txid: 0x${result.txid || result}`);
  if (result.error) console.log(`  error: ${result.error} - ${result.reason}`);
  return result;
}

// Mock sbtc-token for testnet
const sbtcSource = readFileSync("/tmp/inscription-escrow/contracts/sbtc-token.clar", "utf8");

// Minimal stubs for clarity-bitcoin-lib-v5 and clarity-bitcoin-helper
// These are just stubs so the escrow contract can deploy; actual BTC proof verification won't work
const bitcoinLibStub = `
;; Stub: clarity-bitcoin-lib-v5
;; Minimal stubs for inscription-escrow deployment
(define-read-only (was-tx-mined-compact
    (height uint)
    (tx (buff 4096))
    (header (buff 80))
    (proof { tx-index: uint, hashes: (list 14 (buff 32)), tree-depth: uint }))
  (ok tx)
)

(define-read-only (was-segwit-tx-mined-compact
    (height uint)
    (tx (buff 4096))
    (header (buff 80))
    (tx-index uint)
    (tree-depth uint)
    (wproof (list 14 (buff 32)))
    (witness-merkle-root (buff 32))
    (witness-reserved-value (buff 32))
    (ctx (buff 1024))
    (cproof (list 14 (buff 32))))
  (ok tx)
)
`;

const bitcoinHelperStub = `
;; Stub: clarity-bitcoin-helper
(define-read-only (concat-tx
    (tx {
      version: (buff 4),
      ins: (list 8 {
        outpoint: { hash: (buff 32), index: (buff 4) },
        scriptSig: (buff 256),
        sequence: (buff 4),
      }),
      outs: (list 8 { value: (buff 8), scriptPubKey: (buff 128) }),
      locktime: (buff 4),
    }))
  0x
)
`;

// Create the testnet version of inscription-escrow with our deployer's contract refs
let escrowSource = readFileSync("/tmp/inscription-escrow/contracts/inscription-escrow.clar", "utf8");
escrowSource = escrowSource.replace(
  /'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4\.sbtc-token/g,
  `'${DEPLOYER}.sbtc-token`
);
escrowSource = escrowSource.replace(
  /'SP2PABAF9FTAJYNFZH93XENAJ8FVY99RRM50D2JG9\.clarity-bitcoin-helper/g,
  `'${DEPLOYER}.clarity-bitcoin-helper`
);
escrowSource = escrowSource.replace(
  /'SP2PABAF9FTAJYNFZH93XENAJ8FVY99RRM50D2JG9\.clarity-bitcoin-lib-v5/g,
  `'${DEPLOYER}.clarity-bitcoin-lib-v5`
);

async function main() {
  let nonce = 3; // next available nonce

  // Deploy dependencies first
  await deploy("sbtc-token", sbtcSource, nonce++);
  await deploy("clarity-bitcoin-lib-v5", bitcoinLibStub, nonce++);
  await deploy("clarity-bitcoin-helper", bitcoinHelperStub, nonce++);
  // Deploy the escrow contract
  await deploy("inscription-escrow", escrowSource, nonce++);

  console.log("\nAll deployments submitted. Check status at:");
  console.log(`https://explorer.hiro.so/address/${DEPLOYER}?chain=testnet`);
}

main().catch(console.error);
