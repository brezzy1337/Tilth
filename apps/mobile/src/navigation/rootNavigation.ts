/**
 * rootNavigation — module-level navigation ref for navigating from outside
 * the React tree (push-notification deep links, F-037).
 *
 * `navigateToConversation` is failure-tolerant by design: if the container
 * isn't ready yet (cold start from a notification tap) the target is stashed
 * and flushed from NavigationContainer's `onReady` callback. Navigation
 * errors are swallowed — a broken deep link must never crash app start.
 */

import { createNavigationContainerRef } from "@react-navigation/native";
import type { AuthedStackParamList } from "./types";

export const navigationRef = createNavigationContainerRef<AuthedStackParamList>();

let pendingConversationId: string | null = null;

/** Navigate to a chat thread by id, or stash it until the container is ready. */
export function navigateToConversation(conversationId: string): void {
  if (!navigationRef.isReady()) {
    pendingConversationId = conversationId;
    return;
  }
  try {
    navigationRef.navigate("Conversation", { conversationId });
  } catch {
    // Never let a deep-link failure propagate (e.g. signed out mid-tap).
  }
}

/** Called from NavigationContainer onReady — flushes a stashed deep link. */
export function flushPendingConversationNavigation(): void {
  if (pendingConversationId === null) return;
  const target = pendingConversationId;
  pendingConversationId = null;
  navigateToConversation(target);
}
