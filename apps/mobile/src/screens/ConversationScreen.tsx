/**
 * ConversationScreen — a single 1:1 buyer<->store chat thread (F-037).
 *
 * Route params: { conversationId } is guaranteed; the counterpart fields
 * (storeId/storeName/storeUserId/buyerId/buyerName) are passed by the inbox.
 * When any are absent (push-notification deep link, or the StoreProfile
 * "Message" button — chat.start returns only the conversationId) they're
 * resolved from the chat.list cache/query, whose summary carries the same
 * fields.
 *
 * Data:
 *   trpc.chat.messages.useInfiniteQuery — newest-first keyset pages rendered
 *     in an inverted FlatList (index 0 = newest at the bottom; scrolling up
 *     pages older messages in via nextCursor). While the screen is focused
 *     the query polls every 10 s (OrderDetailScreen's refetchInterval
 *     pattern) so incoming messages appear without renavigation.
 *   trpc.chat.send — optimistic UX: the draft is cleared and a dimmed pending
 *     bubble shows immediately; on success the server message is prepended
 *     into the first cached page (no refetch; a later poll replacing the
 *     pages with server truth is harmless — the ack is already in both). On
 *     error the pending bubble is removed and the draft restored. A FORBIDDEN
 *     response (either side blocked the other — the server deliberately
 *     doesn't say which) surfaces as a neutral "You can't message this
 *     person."; TOO_MANY_REQUESTS (server rate limit, >30 sends/min) as a
 *     friendly slow-down note.
 *   trpc.chat.markRead — fired on focus and after each successful send, then
 *     chat.list is invalidated so inbox unread badges stay honest.
 *
 * Moderation (App Store Guideline 1.2):
 *   Header overflow (…) → Block user (confirm → chat.blockUser → goBack).
 *     The counterpart's userId comes straight from the conversation summary
 *     (viewer is buyer → storeUserId, viewer is seller → buyerId), so
 *     blocking works even before the counterpart has sent anything.
 *   Long-press a counterpart message → Report (reason modal →
 *     chat.reportMessage → transient confirmation banner).
 *
 * Header title shows the counterpart's name; when the viewer is the buyer it
 * taps through to the store's profile.
 *
 * React Native only — no DOM elements.
 */

import React, { useCallback, useLayoutEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useFocusEffect, useIsFocused } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import type { ChatMessage } from "@homegrown/shared";
import { trpc } from "../api/trpc";
import { useAuth } from "../auth/AuthContext";
import { useInfiniteScrollEnd } from "../hooks/useInfiniteScrollEnd";
import type { AuthedStackParamList } from "../navigation/types";
import { formatMessageTimestamp } from "../utils/time";
import { colors, radii, shadows, spacing, type } from "../theme";

const PAGE_LIMIT = 30;
const MAX_BODY_CHARS = 2000;
/** Gap between consecutive messages that triggers a timestamp divider. */
const TIMESTAMP_GAP_MS = 15 * 60 * 1000;
const BLOCKED_SEND_MESSAGE = "You can't message this person.";
const RATE_LIMITED_SEND_MESSAGE = "You're sending messages too quickly — give it a moment.";
/** Poll cadence for new incoming messages while the thread is focused. */
const THREAD_REFRESH_MS = 10_000;
/**
 * Native-stack header bar height on iOS (pt), excluding the status-bar inset.
 * Combined with useSafeAreaInsets().top for KeyboardAvoidingView's offset.
 * @react-navigation/elements' useHeaderHeight() would be the canonical
 * source, but elements isn't a direct dependency and strict pnpm makes it
 * unresolvable from app code.
 */
const IOS_NAV_BAR_HEIGHT = 44;

type Props = NativeStackScreenProps<AuthedStackParamList, "Conversation">;

/** A locally-pending (optimistic) outgoing message awaiting server ack. */
interface PendingMessage {
  key: string;
  body: string;
  createdAt: string;
}

type ThreadRow =
  | { kind: "message"; message: ChatMessage }
  | { kind: "pending"; pending: PendingMessage };

function rowKey(row: ThreadRow): string {
  return row.kind === "message" ? row.message.id : row.pending.key;
}

function rowCreatedAt(row: ThreadRow): string {
  return row.kind === "message" ? row.message.createdAt : row.pending.createdAt;
}

export function ConversationScreen({ route, navigation }: Props) {
  const { conversationId } = route.params;
  const { user } = useAuth();
  const myId = user?.id ?? "";
  const utils = trpc.useUtils();
  const insets = useSafeAreaInsets();
  // Measured composer height — anchors the report toast just above it.
  const [composerHeight, setComposerHeight] = useState(0);

  // -------------------------------------------------------------------------
  // Counterpart resolution — params first, chat.list fallback for deep links
  // -------------------------------------------------------------------------

  // Field-by-field: params win, the chat.list summary fills the gaps. The
  // inbox passes everything; StoreProfile's "Message" button passes the names
  // but not storeUserId (chat.start returns only the conversationId); push
  // deep links pass nothing beyond the conversationId.
  const paramsComplete =
    route.params.storeId !== undefined &&
    route.params.storeName !== undefined &&
    route.params.storeUserId !== undefined &&
    route.params.buyerId !== undefined &&
    route.params.buyerName !== undefined;

  const { data: inbox } = trpc.chat.list.useQuery({ limit: 100 }, { enabled: !paramsComplete });

  const summary = paramsComplete ? undefined : inbox?.items.find((c) => c.id === conversationId);

  const storeId = route.params.storeId ?? summary?.storeId;
  const storeName = route.params.storeName ?? summary?.storeName;
  const storeUserId = route.params.storeUserId ?? summary?.storeUserId;
  const buyerId = route.params.buyerId ?? summary?.buyerId;
  const buyerName = route.params.buyerName ?? summary?.buyerName;

  const isViewerBuyer = buyerId !== undefined ? buyerId === myId : undefined;
  const counterpartName =
    isViewerBuyer === undefined ? "Conversation" : isViewerBuyer ? storeName : buyerName;

  // -------------------------------------------------------------------------
  // Messages — newest-first infinite query, inverted list
  // -------------------------------------------------------------------------

  const isFocused = useIsFocused();
  const messagesInput = { conversationId, limit: PAGE_LIMIT };
  const { data, isLoading, error, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } =
    trpc.chat.messages.useInfiniteQuery(messagesInput, {
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
      // Poll for incoming messages while the thread is on screen (same
      // focused-polling idea as OrderDetailScreen's webhook wait). The refetch
      // replaces cached pages with server truth, which composes fine with the
      // optimistic send prepend — by then the ack is in both.
      refetchInterval: isFocused ? THREAD_REFRESH_MS : false,
    });

  const serverMessages: ChatMessage[] = data?.pages.flatMap((page) => page.items) ?? [];

  const [pendingMessages, setPendingMessages] = useState<PendingMessage[]>([]);
  const pendingSeq = useRef(0);

  // Pending (newest) rows first — index 0 renders at the bottom when inverted.
  const rows: ThreadRow[] = [
    ...[...pendingMessages].reverse().map((p): ThreadRow => ({ kind: "pending", pending: p })),
    ...serverMessages.map((m): ThreadRow => ({ kind: "message", message: m })),
  ];

  /**
   * The counterpart's userId — needed for blockUser. Both sides are on the
   * conversation summary (storeUserId is symmetric with buyerId), so this is
   * known before any message exists; it's only null while a deep link is
   * still resolving the summary from chat.list.
   */
  const counterpartUserId =
    isViewerBuyer === undefined ? null : isViewerBuyer ? (storeUserId ?? null) : (buyerId ?? null);

  // -------------------------------------------------------------------------
  // markRead — on focus and after sends; keep the inbox badges in sync
  // -------------------------------------------------------------------------

  const markRead = trpc.chat.markRead.useMutation({
    onSuccess: () => void utils.chat.list.invalidate(),
  });
  const markReadRef = useRef(markRead);
  markReadRef.current = markRead;

  useFocusEffect(
    useCallback(() => {
      markReadRef.current.mutate({ conversationId });
    }, [conversationId]),
  );

  // -------------------------------------------------------------------------
  // send — optimistic pending bubble, prepend on ack
  // -------------------------------------------------------------------------

  const [draft, setDraft] = useState("");

  const send = trpc.chat.send.useMutation();

  const handleSend = useCallback(() => {
    const body = draft.trim();
    if (body.length === 0 || body.length > MAX_BODY_CHARS) return;

    const key = `pending-${Date.now()}-${pendingSeq.current++}`;
    setPendingMessages((prev) => [...prev, { key, body, createdAt: new Date().toISOString() }]);
    setDraft("");

    send.mutate(
      { conversationId, body },
      {
        onSuccess: (message) => {
          setPendingMessages((prev) => prev.filter((p) => p.key !== key));
          // Prepend the acked message into the newest cached page — no refetch.
          utils.chat.messages.setInfiniteData(messagesInput, (existing) => {
            if (!existing) return existing;
            const [first, ...rest] = existing.pages;
            if (!first) return existing;
            return {
              ...existing,
              pages: [{ ...first, items: [message, ...first.items] }, ...rest],
            };
          });
          markReadRef.current.mutate({ conversationId });
        },
        onError: (err) => {
          setPendingMessages((prev) => prev.filter((p) => p.key !== key));
          setDraft(body); // Give the text back so nothing is lost.
          if (err.data?.code === "FORBIDDEN") {
            Alert.alert(BLOCKED_SEND_MESSAGE);
          } else if (err.data?.code === "TOO_MANY_REQUESTS") {
            Alert.alert(RATE_LIMITED_SEND_MESSAGE);
          } else {
            Alert.alert("Message not sent", err.message);
          }
        },
      },
    );
  }, [draft, conversationId, send, utils, messagesInput]);

  // -------------------------------------------------------------------------
  // Block user (header overflow)
  // -------------------------------------------------------------------------

  const blockUser = trpc.chat.blockUser.useMutation({
    onSuccess: () => {
      void utils.chat.list.invalidate();
      navigation.goBack();
    },
    onError: (err) => Alert.alert("Could not block", err.message),
  });

  const handleBlockPressed = useCallback(() => {
    // Only transiently null while a deep link resolves the summary.
    if (!counterpartUserId) return;
    Alert.alert(
      `Block ${counterpartName ?? "this person"}?`,
      "You won't be able to send or receive messages from each other.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Block",
          style: "destructive",
          onPress: () => blockUser.mutate({ userId: counterpartUserId }),
        },
      ],
    );
  }, [counterpartUserId, counterpartName, blockUser]);

  const openOverflowMenu = useCallback(() => {
    Alert.alert(counterpartName ?? "Conversation", undefined, [
      { text: "Block user", style: "destructive", onPress: handleBlockPressed },
      { text: "Cancel", style: "cancel" },
    ]);
  }, [counterpartName, handleBlockPressed]);

  // -------------------------------------------------------------------------
  // Report message (long-press) — reason modal + transient confirmation
  // -------------------------------------------------------------------------

  const [reportTarget, setReportTarget] = useState<ChatMessage | null>(null);
  const [reportReason, setReportReason] = useState("");
  const [showReportConfirmation, setShowReportConfirmation] = useState(false);

  const reportMessage = trpc.chat.reportMessage.useMutation({
    onSuccess: () => {
      setReportTarget(null);
      setReportReason("");
      setShowReportConfirmation(true);
      setTimeout(() => setShowReportConfirmation(false), 2500);
    },
    onError: (err) => Alert.alert("Could not send report", err.message),
  });

  const handleLongPressMessage = useCallback(
    (message: ChatMessage) => {
      if (message.senderUserId === myId) return; // Only counterpart messages are reportable.
      Alert.alert("Report message", "Report this message to the Tilth team?", [
        { text: "Cancel", style: "cancel" },
        { text: "Report", style: "destructive", onPress: () => setReportTarget(message) },
      ]);
    },
    [myId],
  );

  const submitReport = useCallback(() => {
    const reason = reportReason.trim();
    if (!reportTarget || reason.length === 0) return;
    reportMessage.mutate({ messageId: reportTarget.id, reason });
  }, [reportTarget, reportReason, reportMessage]);

  // -------------------------------------------------------------------------
  // Header — counterpart name (taps to StoreProfile for buyers) + overflow
  // -------------------------------------------------------------------------

  useLayoutEffect(() => {
    const canOpenStore = isViewerBuyer === true && storeId !== undefined;
    navigation.setOptions({
      headerTitle: () => (
        <Pressable
          disabled={!canOpenStore}
          onPress={() => {
            if (isViewerBuyer === true && storeId !== undefined) {
              navigation.navigate("StoreProfile", { storeId, storeName });
            }
          }}
          style={styles.headerTitleButton}
          accessibilityRole={canOpenStore ? "button" : "text"}
          accessibilityLabel={canOpenStore ? `View ${counterpartName}'s stand` : counterpartName}
        >
          <Text style={styles.headerTitleText} numberOfLines={1}>
            {counterpartName ?? "Conversation"}
          </Text>
          {canOpenStore ? (
            <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
          ) : null}
        </Pressable>
      ),
      headerRight: () => (
        <Pressable
          onPress={openOverflowMenu}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Conversation options"
        >
          <Ionicons name="ellipsis-horizontal" size={22} color={colors.primary} />
        </Pressable>
      ),
    });
  }, [navigation, counterpartName, isViewerBuyer, storeId, storeName, openOverflowMenu]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const handleEndReached = useInfiniteScrollEnd({
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  });

  const renderRow = ({ item, index }: { item: ThreadRow; index: number }) => {
    const isMine = item.kind === "pending" || item.message.senderUserId === myId;
    // The chronologically-previous (older) row sits at index + 1 (newest-first
    // data). Show a timestamp divider at gaps > 15 minutes and before the
    // oldest loaded message.
    const older = rows[index + 1];
    const showTimestamp =
      !older ||
      new Date(rowCreatedAt(item)).getTime() - new Date(rowCreatedAt(older)).getTime() >
        TIMESTAMP_GAP_MS;

    return (
      <View>
        {showTimestamp ? (
          <View style={styles.timestampPill}>
            <Text style={styles.timestampText}>{formatMessageTimestamp(rowCreatedAt(item))}</Text>
          </View>
        ) : null}
        <Pressable
          onLongPress={
            item.kind === "message" ? () => handleLongPressMessage(item.message) : undefined
          }
          style={[styles.bubbleRow, isMine ? styles.bubbleRowMine : styles.bubbleRowTheirs]}
        >
          <View
            style={[
              styles.bubble,
              isMine ? styles.bubbleMine : styles.bubbleTheirs,
              item.kind === "pending" ? styles.bubblePending : null,
            ]}
          >
            <Text style={isMine ? styles.bubbleTextMine : styles.bubbleTextTheirs}>
              {item.kind === "message" ? item.message.body : item.pending.body}
            </Text>
          </View>
        </Pressable>
      </View>
    );
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? insets.top + IOS_NAV_BAR_HEIGHT : 0}
    >
      {isLoading ? (
        <View style={styles.centeredState}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : error ? (
        <View style={styles.centeredState}>
          <Text style={styles.stateText}>Could not load messages: {error.message}</Text>
          <Pressable style={styles.retryButton} onPress={() => void refetch()}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={rowKey}
          inverted
          contentContainerStyle={styles.listContent}
          onEndReached={handleEndReached}
          onEndReachedThreshold={0.5}
          keyboardShouldPersistTaps="handled"
          ListFooterComponent={
            isFetchingNextPage ? (
              <ActivityIndicator size="small" color={colors.primary} style={styles.footerLoader} />
            ) : null
          }
          ListEmptyComponent={
            <View style={styles.emptyThread}>
              <Text style={styles.emptyThreadText}>
                {"\u{1F33B}"} Say hello — ask about what's fresh this week.
              </Text>
            </View>
          }
          renderItem={renderRow}
        />
      )}

      {/* Composer — bottom-padded by the safe-area inset so Android's
          edge-to-edge gesture/nav bar can't cover the input. */}
      <View
        style={[styles.composer, { paddingBottom: spacing.sm + insets.bottom }]}
        onLayout={(e) => setComposerHeight(e.nativeEvent.layout.height)}
      >
        <TextInput
          style={styles.composerInput}
          value={draft}
          onChangeText={setDraft}
          placeholder="Write a message…"
          placeholderTextColor={colors.textMuted}
          multiline
          maxLength={MAX_BODY_CHARS}
          editable={!isLoading}
        />
        <Pressable
          style={[styles.sendButton, draft.trim().length === 0 ? styles.sendButtonDisabled : null]}
          onPress={handleSend}
          disabled={draft.trim().length === 0}
          hitSlop={4}
          accessibilityRole="button"
          accessibilityLabel="Send message"
        >
          <Ionicons name="arrow-up" size={20} color={colors.onPrimary} />
        </Pressable>
      </View>

      {/* Report confirmation "toast" — anchored just above the composer so
          it never hides under the native header. */}
      {showReportConfirmation ? (
        <View style={[styles.reportToast, shadows.raised, { bottom: composerHeight + spacing.md }]}>
          <Text style={styles.reportToastText}>{"\u{1F331}"} Report received — thank you.</Text>
        </View>
      ) : null}

      {/* Report reason modal */}
      <Modal
        visible={reportTarget !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setReportTarget(null)}
      >
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalCard, shadows.raised]}>
            <Text style={styles.modalTitle}>Report message</Text>
            <Text style={styles.modalSubtitle}>
              Tell us what's wrong with this message and our team will review it.
            </Text>
            <TextInput
              style={styles.modalInput}
              value={reportReason}
              onChangeText={setReportReason}
              placeholder="Reason (required)"
              placeholderTextColor={colors.textMuted}
              multiline
              maxLength={500}
              autoFocus
            />
            <View style={styles.modalActions}>
              <Pressable
                style={styles.modalCancelButton}
                onPress={() => {
                  setReportTarget(null);
                  setReportReason("");
                }}
              >
                <Text style={styles.modalCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[
                  styles.modalSubmitButton,
                  reportReason.trim().length === 0 || reportMessage.isPending
                    ? styles.sendButtonDisabled
                    : null,
                ]}
                onPress={submitReport}
                disabled={reportReason.trim().length === 0 || reportMessage.isPending}
              >
                {reportMessage.isPending ? (
                  <ActivityIndicator size="small" color={colors.onPrimary} />
                ) : (
                  <Text style={styles.modalSubmitText}>Report</Text>
                )}
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  listContent: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: spacing.xs,
  },
  headerTitleButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    maxWidth: 240,
  },
  headerTitleText: {
    fontSize: type.section.fontSize,
    fontWeight: type.section.fontWeight,
    color: colors.text,
  },
  timestampPill: {
    alignSelf: "center",
    backgroundColor: colors.surfaceAlt,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    marginVertical: spacing.sm,
  },
  timestampText: {
    fontSize: type.caption.fontSize - 1,
    color: colors.textMuted,
  },
  bubbleRow: {
    flexDirection: "row",
  },
  bubbleRowMine: {
    justifyContent: "flex-end",
  },
  bubbleRowTheirs: {
    justifyContent: "flex-start",
  },
  bubble: {
    maxWidth: "80%",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.md,
  },
  bubbleMine: {
    backgroundColor: colors.primary,
    borderBottomRightRadius: radii.sm,
  },
  bubbleTheirs: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderBottomLeftRadius: radii.sm,
  },
  bubblePending: {
    // Dim only the fill (primary at ~70% via hex-alpha suffix) — the label
    // stays fully opaque so white-on-green never drops below comfortable
    // contrast while the ack is in flight.
    backgroundColor: `${colors.primary}B3`,
  },
  bubbleTextMine: {
    fontSize: type.body.fontSize,
    color: colors.onPrimary,
    lineHeight: 20,
  },
  bubbleTextTheirs: {
    fontSize: type.body.fontSize,
    color: colors.text,
    lineHeight: 20,
  },
  emptyThread: {
    // NO counter-flip here: on this RN version (0.85 / new architecture)
    // the inverted FlatList renders ListEmptyComponent upright already —
    // the classic manual scaleY:-1 counter-flip displayed it upside down
    // on-device (verified by Devin, 2026-07-08).
    alignItems: "center",
    paddingVertical: spacing.xxxl,
    paddingHorizontal: spacing.xxl,
  },
  emptyThreadText: {
    fontSize: type.body.fontSize,
    color: colors.textMuted,
    textAlign: "center",
  },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  composerInput: {
    flex: 1,
    maxHeight: 120,
    fontSize: type.body.fontSize,
    color: colors.text,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radii.lg,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm + 2,
    paddingBottom: spacing.sm + 2,
  },
  // 40x40 matches the app's circular primary actions (HomeScreen); with
  // hitSlop={4} the effective touch target clears the 44pt floor.
  sendButton: {
    width: 40,
    height: 40,
    borderRadius: radii.pill,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  sendButtonDisabled: {
    opacity: 0.45,
  },
  centeredState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.xxxl,
    gap: spacing.md,
  },
  stateText: {
    fontSize: type.body.fontSize + 1,
    color: colors.text,
    textAlign: "center",
    fontWeight: "600",
  },
  retryButton: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xl,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.primary,
  },
  retryText: {
    color: colors.primary,
    fontSize: type.caption.fontSize + 1,
    fontWeight: "600",
  },
  footerLoader: {
    marginVertical: spacing.lg,
  },
  reportToast: {
    position: "absolute",
    // `bottom` is set inline from the measured composer height.
    alignSelf: "center",
    backgroundColor: colors.secondary,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm,
  },
  reportToastText: {
    color: colors.onPrimary,
    fontSize: type.label.fontSize,
    fontWeight: type.label.fontWeight,
  },
  modalBackdrop: {
    flex: 1,
    // Dim scrim: the text token at ~45% opacity (hex-alpha suffix, same
    // technique as StoreProfileScreen's trust-badge tints).
    backgroundColor: `${colors.text}73`,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.xxl,
  },
  modalCard: {
    width: "100%",
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    padding: spacing.xl,
    gap: spacing.md,
  },
  modalTitle: {
    fontSize: type.section.fontSize,
    fontWeight: type.section.fontWeight,
    color: colors.text,
  },
  modalSubtitle: {
    fontSize: type.caption.fontSize + 1,
    color: colors.textMuted,
    lineHeight: 18,
  },
  modalInput: {
    minHeight: 80,
    maxHeight: 160,
    fontSize: type.body.fontSize,
    color: colors.text,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
    textAlignVertical: "top",
  },
  modalActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: spacing.md,
  },
  modalCancelButton: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.md,
  },
  modalCancelText: {
    color: colors.primary,
    fontSize: type.body.fontSize,
    fontWeight: "600",
  },
  modalSubmitButton: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xl,
    borderRadius: radii.md,
    backgroundColor: colors.danger,
    alignItems: "center",
    justifyContent: "center",
  },
  modalSubmitText: {
    color: colors.onPrimary,
    fontSize: type.body.fontSize,
    fontWeight: "700",
  },
});
