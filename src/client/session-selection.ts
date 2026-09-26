import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'

/** The current conversation is the Session retained by the main view. */
export function selectedSessionId(sessions: Pick<SessionListState, 'byId'>) {
  return Object.values(sessions.byId).find((session) => (session.retainedBy.mainView ?? 0) > 0)?.id
}
