import type { AgentActivityEntry } from "../shared/agentAccess";
import type { AgentActivitySink } from "./backend";

/**
 * In-memory feed of what agents did, newest first. Powers the header
 * pill ("Claude Code is working…") and Settings → AI Agents → Recent
 * agent actions. Not persisted: it describes this app session only.
 */
export class AgentActivityLog implements AgentActivitySink {
  private entries: AgentActivityEntry[] = [];
  private seq = 0;

  constructor(
    private readonly onEntry: (entry: AgentActivityEntry) => void,
    private readonly limit = 100,
    private readonly now: () => number = Date.now,
  ) {}

  record(entry: Omit<AgentActivityEntry, "id" | "at">): void {
    const full: AgentActivityEntry = { ...entry, id: `agent-${++this.seq}`, at: this.now() };
    this.entries.unshift(full);
    if (this.entries.length > this.limit) this.entries.length = this.limit;
    try {
      this.onEntry(full);
    } catch {
      // A closing window must never fail the tool call that triggered it.
    }
  }

  list(): AgentActivityEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }
}
