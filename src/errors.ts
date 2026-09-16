/** Machine-readable codes shared by every Automation error. */
export type AutomationErrorCode =
  | 'task_not_found'
  | 'invalid_state'
  | 'run_in_progress'
  | 'schedule_exhausted'
  | 'target_resume_failed'
  | 'target_workspace_mismatch'
  | 'target_session_unavailable'
  | 'target_session_not_found'
  | 'target_session_busy'

/**
 * Base class for every error Automation raises on purpose.
 *
 * `code` is the stable machine-readable identifier; `message` is the
 * human-readable detail. Consumers (API, tools, scheduler) can branch on
 * `code` instead of string-matching message prefixes.
 */
export class AutomationError extends Error {
  constructor(
    readonly code: AutomationErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'AutomationError'
  }
}
