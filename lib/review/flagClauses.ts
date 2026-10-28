import type { ClauseFlag } from "./types";

type FlagRule = Omit<ClauseFlag, never> & {
  pattern: RegExp;
};

const RULES: FlagRule[] = [
  {
    id: "auto-renew",
    label: "Automatic renewal",
    why: "May roll the lease into a new term unless notice is given on a short deadline.",
    severity: "concern",
    pattern: /\bauto(?:matic(?:ally)?)?[\s-]?renew/i,
  },
  {
    id: "as-is",
    label: "As-is condition",
    why: "Can shift repair and habitability risk onto the tenant.",
    severity: "concern",
    pattern: /\bas[-\s]?is\b/i,
  },
  {
    id: "waiver",
    label: "Waiver of rights",
    why: "Look for waived notices, jury trial, or claims against the landlord.",
    severity: "concern",
    pattern: /\bwaiv(?:e|es|er|ing)\b/i,
  },
  {
    id: "indemnify",
    label: "Indemnity",
    why: "May require the tenant to cover the landlord’s losses or legal fees.",
    severity: "concern",
    pattern: /\bindemnif/i,
  },
  {
    id: "attorney-fees",
    label: "Attorney’s fees",
    why: "Check whether only one party recovers fees if there is a dispute.",
    severity: "watch",
    pattern: /\battorneys?['’]?s?\s+fees\b/i,
  },
  {
    id: "late-fee",
    label: "Late fee",
    why: "Confirm the grace period, amount, and whether it compounds.",
    severity: "watch",
    pattern: /\blate\s+(?:fee|charge|penalty|rent)\b/i,
  },
  {
    id: "deposit",
    label: "Security deposit",
    why: "Check cap, allowed deductions, and return timing.",
    severity: "watch",
    pattern: /\bsecurity\s+deposit\b/i,
  },
  {
    id: "entry",
    label: "Landlord entry",
    why: "Notice and hours for entry can be one-sided.",
    severity: "watch",
    pattern: /\b(?:enter|entry|inspect(?:ion)?)\b.{0,40}\b(?:premises|unit|dwelling)\b|\blandlord\s+may\s+enter\b/i,
  },
  {
    id: "no-notice",
    label: "Without notice",
    why: "Actions that can happen without notice deserve a closer read.",
    severity: "concern",
    pattern: /\bwithout\s+(?:prior\s+)?notice\b/i,
  },
  {
    id: "joint-several",
    label: "Joint and several",
    why: "Each roommate can be on the hook for the full rent and damages.",
    severity: "watch",
    pattern: /\bjoint(?:ly)?\s+and\s+several(?:ly)?\b/i,
  },
  {
    id: "early-termination",
    label: "Early termination",
    why: "Break-lease fees and notice windows are easy to miss.",
    severity: "watch",
    pattern: /\bearly\s+terminat|\bbreak(?:ing)?\s+(?:the\s+)?lease\b/i,
  },
  {
    id: "holdover",
    label: "Holdover rent",
    why: "Staying past the term can trigger a steep daily or monthly rate.",
    severity: "watch",
    pattern: /\bholdover\b/i,
  },
  {
    id: "sole-expense",
    label: "Sole expense",
    why: "Costs pushed solely onto the tenant can add up.",
    severity: "watch",
    pattern: /\b(?:tenant['’]?s?|lessee['’]?s?)\s+sole\s+expense\b/i,
  },
];

export function flagClause(text: string): ClauseFlag[] {
  return RULES.filter((rule) => rule.pattern.test(text)).map(
    ({ pattern: _pattern, ...flag }) => flag,
  );
}
