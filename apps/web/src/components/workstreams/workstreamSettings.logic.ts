import {
  EnvironmentId,
  WORKSTREAM_MEMORY_MAX_BUDGET_CHARS,
  WORKSTREAM_MEMORY_MIN_BUDGET_CHARS,
  WorkstreamId,
} from "@t3tools/contracts";

export function validateWorkstreamSettingsSearch(raw: Record<string, unknown>) {
  return {
    ...(typeof raw.environmentId === "string" && raw.environmentId.trim()
      ? { environmentId: EnvironmentId.make(raw.environmentId) }
      : {}),
    ...(typeof raw.workstream === "string" && raw.workstream.trim()
      ? { workstream: WorkstreamId.make(raw.workstream.trim()) }
      : {}),
  };
}

/** A typed gate threshold as a probability, or null when it is not a number from 0 to 1. */
export function parseGateThreshold(text: string): number | null {
  const value = Number(text.trim().replace(",", "."));
  if (text.trim() === "" || !Number.isFinite(value) || value < 0 || value > 1) return null;
  return Math.round(value * 100) / 100;
}

/** A typed size budget, pulled into the range the server accepts. Null when it is not a number. */
export function parseMemoryBudget(text: string): number | null {
  const value = Number(text.trim());
  if (text.trim() === "" || !Number.isFinite(value)) return null;
  return Math.min(
    WORKSTREAM_MEMORY_MAX_BUDGET_CHARS,
    Math.max(WORKSTREAM_MEMORY_MIN_BUDGET_CHARS, Math.round(value)),
  );
}
