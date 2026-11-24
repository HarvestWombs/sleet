// Release builds only: points Sleet's updater at this GitHub repository's
// latest release and adds the update signing public key. Run by
// .github/workflows/release.yml; the committed tauri.conf.json leaves updates off.
//
//   TAURI_UPDATER_PUBKEY=<contents of sleet.key.pub> node scripts/configure-updater.mjs owner/repo
import { readFileSync, writeFileSync } from "node:fs";

const repository = process.argv[2];
const pubkey = (process.env.TAURI_UPDATER_PUBKEY ?? "").trim();
if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? "")) throw new Error("usage: configure-updater.mjs owner/repo");
if (!pubkey) throw new Error("TAURI_UPDATER_PUBKEY is empty");

const path = new URL("../src-tauri/tauri.conf.json", import.meta.url);
const config = JSON.parse(readFileSync(path, "utf8"));
config.bundle.createUpdaterArtifacts = true;
config.plugins ??= {};
config.plugins.updater = {
  ...config.plugins.updater,
  pubkey,
  endpoints: [`https://github.com/${repository}/releases/latest/download/latest.json`],
};
writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
console.log(`Updates enabled from github.com/${repository}`);
