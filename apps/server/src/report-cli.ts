// pnpm report [events.jsonl ...] [--exclude-source dev,me | --keep-dev] [--exclude <anon,...>] [--tz 3] [--json]
// Prints the playtest report. With no file, reads data/events.jsonl.
// Players whose link had src=dev are left out unless --keep-dev is given.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildReport, formatReport, parseEvents } from "./report.ts";

const args = process.argv.slice(2);
const files: string[] = [];
let excludeSources = ["dev"];
let excludeAnons: string[] = [];
let tzHours = 0;
let json = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  const next = (): string => {
    const v = args[++i];
    if (v === undefined) throw new Error(`${a} needs a value`);
    return v;
  };
  if (a === "--exclude-source") excludeSources = next().split(",").filter((s) => s !== "");
  else if (a === "--exclude") excludeAnons = next().split(",").filter((s) => s !== "");
  else if (a === "--tz") tzHours = Number(next());
  else if (a === "--keep-dev") excludeSources = [];
  else if (a === "--json") json = true;
  else files.push(a);
}
if (files.length === 0) files.push(fileURLToPath(new URL("../../../data/events.jsonl", import.meta.url)));

let bad = 0;
const events = files.flatMap((f) => {
  const r = parseEvents(readFileSync(f, "utf8"));
  bad += r.bad;
  return r.events;
});
const report = buildReport(events, { excludeSources, excludeAnons, tzHours });
if (json) console.log(JSON.stringify(report, null, 2));
else {
  console.log(formatReport(report));
  if (bad > 0) console.log(`\n${bad} unreadable line(s) skipped.`);
}
