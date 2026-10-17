import { sessionPermissions, type McpAgentSession } from "../../shared/agentAccess";
import {
  removalChoice,
  type RemovalAction,
  type RemovalChoice,
  type RemovalItem,
  type RemovalRequest,
} from "../../shared/agentRemovals";

export interface ReviewRow {
  item: RemovalItem;
  request: RemovalRequest;
  choice: RemovalChoice;
  /** Ticked now: the user's tick, else how the item opens. */
  ticked: boolean;
  action: RemovalAction;
}

export interface ReviewGroup {
  request: RemovalRequest;
  session: McpAgentSession | null;
  rows: ReviewRow[];
}

/**
 * The review sheet's rows, one group per request, from the list, the
 * sessions as they are now, and what the user ticked or switched.
 * Linear in the items: sessions are looked up once per request.
 */
export function reviewGroups(
  requests: readonly RemovalRequest[],
  sessions: readonly McpAgentSession[],
  ticks: ReadonlyMap<string, boolean>,
  actions: ReadonlyMap<string, RemovalAction>,
  platform: string,
): ReviewGroup[] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  return requests.map((request) => {
    const session = byId.get(request.sessionId) ?? null;
    const granted = session && session.revokedAt === null ? sessionPermissions(session) : null;
    const rows = request.items.map((item): ReviewRow => {
      const choice = removalChoice(item, granted, request.sessionName, platform);
      const picked = actions.get(item.id);
      const action = picked && choice[picked] ? picked : choice.action;
      const ticked = item.status === "waiting" && !choice.locked && (ticks.get(item.id) ?? choice.ticked);
      return { item, request, choice, ticked, action };
    });
    return { request, session, rows };
  });
}
