mas3
airdrop-sweeper-pro
Universal airdrop/retrodrop claimer orchestrator using ethers v6. Supports ABI registry per contract, rate-limit, retries, and CSV reporting.
#!/usr/bin/env node
/**
 * airdrop-sweeper-pro
 * Install: npm i ethers fastq csv-parse csv-stringify p-retry p-limit
 * Usage:
 *  node airdrop-sweeper-pro.js --rpc $RPC --pk $PRIV  *    --list contracts.csv --report report.csv --concurrency 3
 * contracts.csv columns:
 *   chain,contract,address,method,args_json,abi_json
 */
import { readFile } from "fs/promises";
import { createReadStream, createWriteStream } from "fs";
import { parse } from "csv-parse";
import { stringify } from "csv-stringify";
import { ethers } from "ethers";
import pRetry from "p-retry";
import pLimit from "p-limit";

const argv = require("yargs/yargs")(process.argv.slice(2))
  .option("rpc", { type: "string", demandOption: true })
  .option("pk", { type: "string", demandOption: true })
  .option("list", { type: "string", demandOption: true })
  .option("report", { type: "string", default: "report.csv" })
  .option("concurrency", { type: "number", default: 2 })
  .argv;

const provider = new ethers.JsonRpcProvider(argv.rpc);
const wallet = new ethers.Wallet(argv.pk, provider);
const limit = pLimit(argv.concurrency);

function readCsv(path) {
  return new Promise((resolve, reject) => {
    const rows = [];
    createReadStream(path)
      .pipe(parse({ columns: true, trim: true }))
      .on("data", (r) => rows.push(r))
      .on("end", () => resolve(rows))
      .on("error", reject);
  });
}

async function callOne(row) {
  const abi = JSON.parse(row.abi_json);
  const args = row.args_json ? JSON.parse(row.args_json) : [];
  const c = new ethers.Contract(row.contract, abi, wallet);
  const method = row.method;
  const gas = await c[method].estimateGas(...args).catch(() => undefined);
  const tx = await c[method](...args, gas ? { gasLimit: gas } : {});
  const rc = await tx.wait();
  return { hash: tx.hash, status: rc?.status ?? 0 };
}

(async () => {
  const rows = await readCsv(argv.list);
  const out = createWriteStream(argv.report);
  const csv = stringify({ header: true, columns: ["contract","method","hash","status"] });
  csv.pipe(out);
  const tasks = rows.map((row) => limit(() =>
    pRetry(() => callOne(row), { retries: 3, factor: 1.8 })
      .then((r) => { csv.write([row.contract, row.method, r.hash, r.status]); return r; })
      .catch((e) => { csv.write([row.contract, row.method, "ERR:"+e.message, 0]); })
  ));
  await Promise.all(tasks);
  csv.end();
  console.log("Report saved to", argv.report);
})().catch((e) => { console.error(e); process.exit(1); });
