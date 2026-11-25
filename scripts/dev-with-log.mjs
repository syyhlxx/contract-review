/**
 * Start `next dev` and the extract-log tail in one terminal.
 *
 * The concurrently package is called from JavaScript, not from a shell
 * string, so the quoting is the same in Windows PowerShell and on a Mac.
 * If either process exits, the other is stopped.
 */
import { concurrently } from "concurrently";

const { result } = concurrently(
  [
    { command: "next dev", name: "dev", prefixColor: "cyan" },
    { command: "node scripts/tail-extract-log.mjs", name: "log", prefixColor: "yellow" },
  ],
  {
    killOthersOn: ["failure", "success"],
    prefix: "name",
  },
);

result.then(
  () => process.exit(0),
  () => process.exit(1),
);
