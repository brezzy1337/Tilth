/**
 * useReportFlow — shared "report this thing" state machine, extracted from
 * the identical copies in ConversationScreen (report message) and
 * GardenCommentsSheet (report comment): a target-to-report, its typed reason
 * draft, and a transient post-submit confirmation toast.
 *
 * The report mutation itself (and its error handling, which differs per call
 * site — e.g. GardenCommentsSheet's TOO_MANY_REQUESTS copy) stays owned by
 * the caller; this hook only owns the target/reason/confirmation state and
 * the open/cancel/submitted transitions, wired up like:
 *
 *   const report = useReportFlow<ChatMessage>();
 *   const reportMessage = trpc.chat.reportMessage.useMutation({
 *     onSuccess: () => report.onSubmitted(),
 *     onError: (err) => Alert.alert("Could not send report", err.message),
 *   });
 *   const submit = () => {
 *     const reason = report.reason.trim();
 *     if (!report.target || reason.length === 0) return;
 *     reportMessage.mutate({ messageId: report.target.id, reason });
 *   };
 */

import { useCallback, useState } from "react";

/** How long the "Report received" confirmation toast stays visible. */
const CONFIRMATION_DURATION_MS = 2500;

export interface UseReportFlowResult<T> {
  /** The item currently targeted for a report, or null when the modal is closed. */
  target: T | null;
  /** The in-progress reason draft. */
  reason: string;
  setReason: (reason: string) => void;
  /** True for CONFIRMATION_DURATION_MS after a successful submit. */
  showConfirmation: boolean;
  /** Opens the reason modal for `target`. */
  open: (target: T) => void;
  /** Closes the modal without submitting (Cancel / backdrop dismiss). */
  cancel: () => void;
  /**
   * Call from the report mutation's `onSuccess`: clears the target/reason and
   * shows the transient confirmation toast.
   */
  onSubmitted: () => void;
}

export function useReportFlow<T>(): UseReportFlowResult<T> {
  const [target, setTarget] = useState<T | null>(null);
  const [reason, setReason] = useState("");
  const [showConfirmation, setShowConfirmation] = useState(false);

  const open = useCallback((next: T) => setTarget(next), []);

  const cancel = useCallback(() => {
    setTarget(null);
    setReason("");
  }, []);

  const onSubmitted = useCallback(() => {
    setTarget(null);
    setReason("");
    setShowConfirmation(true);
    setTimeout(() => setShowConfirmation(false), CONFIRMATION_DURATION_MS);
  }, []);

  return { target, reason, setReason, showConfirmation, open, cancel, onSubmitted };
}
