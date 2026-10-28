export type FlagSeverity = "watch" | "concern";

export type ClauseFlag = {
  id: string;
  label: string;
  why: string;
  severity: FlagSeverity;
};

export type ReviewStatus = "unreviewed" | "ok" | "question" | "concern";

export type Clause = {
  id: string;
  heading: string;
  body: string;
  flags: ClauseFlag[];
};

export type ParsedContract = {
  fileName: string;
  pageCount: number | null;
  clauses: Clause[];
};

export type ClauseNote = {
  status: ReviewStatus;
  text: string;
};
