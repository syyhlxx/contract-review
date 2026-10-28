import type { Clause } from "./types";
import { flagClause } from "./flagClauses";

const HEADING =
  /^(?:ARTICLE|Article|SECTION|Section|CLAUSE|Clause)\s+[\dIVXLCDM]+(?:\s*[:.)-]\s*|\s+)/;
const NUMBERED = /^(?:\d+(?:\.\d+)*|[A-Z])[.)]\s+\S/;

function firstLine(block: string): string {
  return block.split("\n")[0]?.trim() ?? "";
}

function headingFrom(block: string): string {
  const line = firstLine(block);
  if (HEADING.test(line) || NUMBERED.test(line)) {
    return line.length > 90 ? `${line.slice(0, 87)}…` : line;
  }
  return line.length > 72 ? `${line.slice(0, 69)}…` : line || "Untitled clause";
}

function splitByHeadings(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: string[] = [];
  let current: string[] = [];

  const flush = () => {
    const block = current.join("\n").trim();
    if (block) blocks.push(block);
    current = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && (HEADING.test(trimmed) || NUMBERED.test(trimmed)) && current.length > 0) {
      flush();
    }
    current.push(line);
  }
  flush();
  return blocks;
}

function splitByBlankLines(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block.length > 40);
}

function mergeTiny(blocks: string[]): string[] {
  const merged: string[] = [];
  for (const block of blocks) {
    if (merged.length > 0 && block.length < 80) {
      merged[merged.length - 1] += `\n\n${block}`;
    } else {
      merged.push(block);
    }
  }
  return merged;
}

export function splitClauses(text: string): Clause[] {
  const cleaned = text.replace(/\u0000/g, "").trim();
  if (!cleaned) return [];

  let blocks = mergeTiny(splitByHeadings(cleaned));
  if (blocks.length < 4) {
    blocks = mergeTiny(splitByBlankLines(cleaned));
  }
  if (blocks.length === 0) {
    blocks = [cleaned];
  }

  return blocks.map((block, index) => {
    const heading = headingFrom(block);
    const body = block.trim();
    return {
      id: `clause-${index + 1}`,
      heading,
      body,
      flags: flagClause(body),
    };
  });
}
