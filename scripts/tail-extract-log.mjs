/**
 * Print new lines from logs/extract.log.
 *
 * This is plain Node, so it works in Windows PowerShell and on a Mac.
 * It does not use the Unix `tail` command. It polls the file, because
 * fs.watch is unreliable on Windows.
 *
 * The dev server and this script are started together by `npm run dev:log`.
 */
import fs from "node:fs";
import path from "node:path";

const file = path.join(process.cwd(), "logs", "extract.log");
fs.mkdirSync(path.dirname(file), { recursive: true });
if (!fs.existsSync(file)) fs.writeFileSync(file, "");

process.stdout.write(
  "Watching logs/extract.log — extraction steps will appear here as you click Extract.\n",
);

// Start at the end so an old log is not reprinted. New clicks append after this.
let position = fs.statSync(file).size;

const timer = setInterval(() => {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return;
  }
  if (stat.size < position) position = 0;
  if (stat.size === position) return;

  const length = stat.size - position;
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, buffer, 0, length, position);
  } finally {
    fs.closeSync(fd);
  }
  position = stat.size;
  process.stdout.write(buffer);
}, 200);

function shutdown() {
  clearInterval(timer);
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
