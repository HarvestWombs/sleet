// Prints the CHANGELOG.md section for a version, used as the GitHub
// release notes (and in latest.json, which installed copies read). Fails when the
// version has no section, so a release can't go out without notes.
//
//   node scripts/release-notes.mjs 0.1.2
import { readFileSync } from "node:fs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+/.test(version ?? "")) throw new Error("usage: release-notes.mjs <version>");

const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const lines = changelog.split("\n");
const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
if (start === -1) {
  console.error(`CHANGELOG.md has no "## [${version}]" section. Add one before releasing.`);
  process.exit(1);
}
// The section runs to the next release heading (or the link list at the end).
const end = lines.findIndex((line, index) => index > start && (line.startsWith("## ") || /^\[[^\]]+\]: /.test(line)));
const notes = lines.slice(start + 1, end === -1 ? undefined : end).join("\n").trim();
if (!notes) {
  console.error(`The CHANGELOG.md section for ${version} is empty.`);
  process.exit(1);
}
process.stdout.write(`${notes}\n`);
