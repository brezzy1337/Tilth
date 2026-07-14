/**
 * GardenCommentsSheet — bottom-sheet comment thread for a single garden post
 * (F-053). A single instance lives at `GardenFeedScreen` (not one per cell);
 * the feed's action rail opens it via `ref.current?.present()` with a target
 * `postId`/`storeName`, matching @gorhom/bottom-sheet's on-demand-modal idiom
 * (HomeScreen's docked `BottomSheet` is a different, always-mounted use of
 * the same library — this is the "opens on tap, dismisses on swipe-down /
 * backdrop-tap" counterpart, `BottomSheetModal`).
 *
 * Data: trpc.garden.listComments.useInfiniteQuery({postId, limit}) — public,
 * newest-first keyset pages (same cursor convention as chat.messages). NOT
 * inverted: this is a comment list, not a chat thread, so the newest comment
 * renders at the top and older ones page in via onEndReached as you scroll
 * down.
 *
 * Composer: pinned via `footerComponent`/`BottomSheetFooter` — gorhom's own
 * keyboard-safe footer slot for a BottomSheetModal — rather than
 * KeyboardAvoidingView. ConversationScreen's KeyboardAvoidingView (F-037)
 * solves this for a plain screen; inside a bottom sheet gorhom's
 * `keyboardBehavior="interactive"` + `BottomSheetFooter` is the documented
 * mechanism, and stacking a manual KeyboardAvoidingView on top of it would
 * double-compensate for the keyboard.
 *
 * createComment — optimistic append: a locally-pending row appears at the
 * top of the (newest-first, non-inverted) list immediately, replaced by the
 * server row on ack. Mirrors ConversationScreen's chat.send pattern exactly
 * (pending bubble -> prepend the acked row into the first cached page), just
 * without the invert. Also patches `garden.feed`'s cached `commentCount` for
 * this post (+1, rolled back on error) via the same
 * feedQueryInput-scoped `setInfiniteData` GardenActionRail uses for likes —
 * one consistent "patch the cache directly" strategy for both counters, no
 * invalidate/refetch.
 *
 * deleteComment (own comment, soft-delete) — optimistic
 * `{deleted: true, body: ""}` patch + `commentCount - 1` on the feed cache,
 * both rolled back on error. Same optimistic-then-rollback shape as
 * GardenActionRail's `toggleLike`.
 *
 * reportComment (others' comments) — reuses ConversationScreen's
 * report-modal pattern: a reason TextInput in a transparent Modal, a
 * transient "Report received" toast on success.
 *
 * TOO_MANY_REQUESTS / FORBIDDEN map to friendly inline copy (Alert), same
 * idiom as ConversationScreen's chat.send error handling.
 *
 * React Native only — no DOM elements.
 */

import React, {
  forwardRef,
  useCallback,
  useMemo,
  useState,
  type ForwardedRef,
} from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  BottomSheetBackdrop,
  BottomSheetFlatList,
  BottomSheetFooter,
  BottomSheetModal,
  BottomSheetTextInput,
  type BottomSheetBackdropProps,
  type BottomSheetFooterProps,
} from "@gorhom/bottom-sheet";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import type { GardenComment, GardenFeedInput, GardenFeedOutput } from "@homegrown/shared";
import { trpc } from "../api/trpc";
import { useAuth } from "../auth/AuthContext";
import { useInfiniteScrollEnd } from "../hooks/useInfiniteScrollEnd";
import { formatRelativeTime } from "../utils/time";
import { colors, radii, shadows, spacing, type } from "../theme";
import { Button } from "./Button";

const PAGE_LIMIT = 30;
const MAX_COMMENT_CHARS = 500;
/** Only show the "N/500" counter once the draft is getting close to the cap. */
const CHAR_WARNING_THRESHOLD = 400;
const RATE_LIMIT_MESSAGE = "You're commenting too quickly — give it a moment.";
const BLOCKED_MESSAGE = "You can't comment on this post.";
const REPORT_RATE_LIMIT_MESSAGE = "Too many reports — please try again later.";

// `pageParams` typed to match each query's cursor exactly (`string | null`)
// — see GardenActionRail's identical note for why a widened `unknown[]`
// doesn't satisfy react-query's InfiniteData<T, TPageParam> here.
type InfiniteFeedData = { pages: GardenFeedOutput[]; pageParams: (string | null)[] };
type InfiniteCommentsData = {
  pages: { comments: GardenComment[]; nextCursor: string | null }[];
  pageParams: (string | null)[];
};

export type GardenCommentsSheetTarget = { postId: string; storeName: string } | null;

type Props = {
  target: GardenCommentsSheetTarget;
  feedQueryInput: GardenFeedInput;
  onDismiss: () => void;
};

/** A locally-pending (optimistic) outgoing comment awaiting server ack. */
interface PendingComment {
  key: string;
  body: string;
  createdAt: string;
}

type CommentRow =
  | { kind: "comment"; comment: GardenComment }
  | { kind: "pending"; pending: PendingComment };

function rowKey(row: CommentRow): string {
  return row.kind === "comment" ? row.comment.id : row.pending.key;
}

/** Patch a single feed item's counts across every cached `garden.feed` page. */
function patchFeedItem(
  data: InfiniteFeedData | undefined,
  postId: string,
  patch: (commentCount: number) => number,
): InfiniteFeedData | undefined {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      items: page.items.map((item) =>
        item.id === postId ? { ...item, commentCount: patch(item.commentCount) } : item,
      ),
    })),
  };
}

/** Patch a single comment (e.g. soft-delete) across every cached `listComments` page. */
function patchComment(
  data: InfiniteCommentsData | undefined,
  commentId: string,
  patch: (comment: GardenComment) => GardenComment,
): InfiniteCommentsData | undefined {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      comments: page.comments.map((c) => (c.id === commentId ? patch(c) : c)),
    })),
  };
}

function GardenCommentsSheetImpl(
  { target, feedQueryInput, onDismiss }: Props,
  ref: ForwardedRef<BottomSheetModal>,
) {
  const insets = useSafeAreaInsets();
  const utils = trpc.useUtils();
  const { user } = useAuth();
  const myId = user?.id ?? "";

  const postId = target?.postId ?? null;
  const commentsInput = { postId: postId ?? "", limit: PAGE_LIMIT };

  const snapPoints = useMemo(() => ["65%", "92%"], []);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} pressBehavior="close" />
    ),
    [],
  );

  // -------------------------------------------------------------------------
  // Comments — newest-first infinite query
  // -------------------------------------------------------------------------

  const { data, isLoading, error, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } =
    trpc.garden.listComments.useInfiniteQuery(commentsInput, {
      enabled: postId !== null,
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    });

  const serverComments: GardenComment[] = data?.pages.flatMap((page) => page.comments) ?? [];

  const [pendingComments, setPendingComments] = useState<PendingComment[]>([]);
  const pendingSeqRef = React.useRef(0);

  // Pending (newest) rows first — this list is newest-first and NOT inverted.
  const rows: CommentRow[] = [
    ...[...pendingComments].reverse().map((p): CommentRow => ({ kind: "pending", pending: p })),
    ...serverComments.map((c): CommentRow => ({ kind: "comment", comment: c })),
  ];

  const handleEndReached = useInfiniteScrollEnd({ hasNextPage, isFetchingNextPage, fetchNextPage });

  // -------------------------------------------------------------------------
  // createComment — optimistic append + feed commentCount patch
  // -------------------------------------------------------------------------

  const [draft, setDraft] = useState("");

  const createComment = trpc.garden.createComment.useMutation();

  const handleSend = useCallback(() => {
    if (!postId) return;
    const body = draft.trim();
    if (body.length === 0 || body.length > MAX_COMMENT_CHARS) return;

    const key = `pending-${Date.now()}-${pendingSeqRef.current++}`;
    setPendingComments((prev) => [...prev, { key, body, createdAt: new Date().toISOString() }]);
    setDraft("");

    createComment.mutate(
      { postId, body },
      {
        onSuccess: (comment) => {
          setPendingComments((prev) => prev.filter((p) => p.key !== key));
          utils.garden.listComments.setInfiniteData(commentsInput, (existing) => {
            if (!existing) return existing;
            const [first, ...rest] = existing.pages;
            if (!first) return existing;
            return {
              ...existing,
              pages: [{ ...first, comments: [comment, ...first.comments] }, ...rest],
            };
          });
          utils.garden.feed.setInfiniteData(feedQueryInput, (old) =>
            patchFeedItem(old, postId, (count) => count + 1),
          );
        },
        onError: (err) => {
          setPendingComments((prev) => prev.filter((p) => p.key !== key));
          setDraft(body); // Give the text back so nothing is lost.
          if (err.data?.code === "FORBIDDEN") {
            Alert.alert(BLOCKED_MESSAGE);
          } else if (err.data?.code === "TOO_MANY_REQUESTS") {
            Alert.alert(RATE_LIMIT_MESSAGE);
          } else {
            Alert.alert("Comment not sent", err.message);
          }
        },
      },
    );
  }, [draft, postId, createComment, utils, feedQueryInput]);

  // -------------------------------------------------------------------------
  // deleteComment — optimistic soft-delete + feed commentCount patch,
  // rollback on error (same shape as GardenActionRail's toggleLike).
  // -------------------------------------------------------------------------

  const deleteComment = trpc.garden.deleteComment.useMutation({
    onMutate: async ({ commentId }) => {
      if (!postId) return {};
      await utils.garden.listComments.cancel(commentsInput);
      const previousComments = utils.garden.listComments.getInfiniteData(commentsInput);
      utils.garden.listComments.setInfiniteData(commentsInput, (old) =>
        patchComment(old, commentId, (c) => ({ ...c, deleted: true, body: "" })),
      );

      await utils.garden.feed.cancel(feedQueryInput);
      const previousFeed = utils.garden.feed.getInfiniteData(feedQueryInput);
      utils.garden.feed.setInfiniteData(feedQueryInput, (old) =>
        patchFeedItem(old, postId, (count) => Math.max(0, count - 1)),
      );

      return { previousComments, previousFeed };
    },
    onError: (err, _vars, context) => {
      if (context?.previousComments) {
        utils.garden.listComments.setInfiniteData(commentsInput, () => context.previousComments);
      }
      if (context?.previousFeed) {
        utils.garden.feed.setInfiniteData(feedQueryInput, () => context.previousFeed);
      }
      Alert.alert("Could not delete comment", err.message);
    },
  });

  // -------------------------------------------------------------------------
  // reportComment — reason modal + transient confirmation (ConversationScreen pattern)
  // -------------------------------------------------------------------------

  const [reportTarget, setReportTarget] = useState<GardenComment | null>(null);
  const [reportReason, setReportReason] = useState("");
  const [showReportConfirmation, setShowReportConfirmation] = useState(false);

  const reportComment = trpc.garden.reportComment.useMutation({
    onSuccess: () => {
      setReportTarget(null);
      setReportReason("");
      setShowReportConfirmation(true);
      setTimeout(() => setShowReportConfirmation(false), 2500);
    },
    onError: (err) => {
      if (err.data?.code === "TOO_MANY_REQUESTS") {
        Alert.alert(REPORT_RATE_LIMIT_MESSAGE);
      } else {
        Alert.alert("Could not send report", err.message);
      }
    },
  });

  const submitReport = useCallback(() => {
    const reason = reportReason.trim();
    if (!reportTarget || reason.length === 0) return;
    reportComment.mutate({ commentId: reportTarget.id, reason });
  }, [reportTarget, reportReason, reportComment]);

  // -------------------------------------------------------------------------
  // long-press affordance — own comment: Delete; others': Report
  // -------------------------------------------------------------------------

  const handleLongPress = useCallback(
    (comment: GardenComment) => {
      if (comment.deleted) return;
      if (comment.userId === myId) {
        Alert.alert("Delete comment", "Remove this comment?", [
          { text: "Cancel", style: "cancel" },
          {
            text: "Delete",
            style: "destructive",
            onPress: () => deleteComment.mutate({ commentId: comment.id }),
          },
        ]);
      } else {
        Alert.alert("Report comment", "Report this comment to the Tilth team?", [
          { text: "Cancel", style: "cancel" },
          { text: "Report", style: "destructive", onPress: () => setReportTarget(comment) },
        ]);
      }
    },
    [myId, deleteComment],
  );

  // -------------------------------------------------------------------------
  // Composer footer
  // -------------------------------------------------------------------------

  const renderFooter = useCallback(
    (footerProps: BottomSheetFooterProps) => (
      <BottomSheetFooter {...footerProps} bottomInset={insets.bottom} style={styles.footer}>
        {draft.length >= CHAR_WARNING_THRESHOLD ? (
          <Text style={styles.charCount}>
            {draft.length}/{MAX_COMMENT_CHARS}
          </Text>
        ) : null}
        <View style={styles.composer}>
          <BottomSheetTextInput
            style={styles.composerInput}
            value={draft}
            onChangeText={setDraft}
            placeholder="Add a comment…"
            placeholderTextColor={colors.textMuted}
            multiline
            maxLength={MAX_COMMENT_CHARS}
          />
          <Pressable
            style={[
              styles.sendButton,
              draft.trim().length === 0 ? styles.sendButtonDisabled : null,
            ]}
            onPress={handleSend}
            disabled={draft.trim().length === 0}
            hitSlop={4}
            accessibilityRole="button"
            accessibilityLabel="Post comment"
          >
            <Ionicons name="arrow-up" size={18} color={colors.onPrimary} />
          </Pressable>
        </View>
      </BottomSheetFooter>
    ),
    [draft, handleSend, insets.bottom],
  );

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const renderRow = ({ item }: { item: CommentRow }) => {
    if (item.kind === "pending") {
      return (
        <View style={[styles.row, styles.rowPending]}>
          <View style={styles.rowHeader}>
            <Text style={styles.username}>You</Text>
            <Text style={styles.time}>{formatRelativeTime(item.pending.createdAt)}</Text>
          </View>
          <Text style={styles.body}>{item.pending.body}</Text>
        </View>
      );
    }

    const comment = item.comment;
    return (
      <Pressable style={styles.row} onLongPress={() => handleLongPress(comment)}>
        <View style={styles.rowHeader}>
          <Text style={styles.username}>{comment.username}</Text>
          <Text style={styles.time}>{formatRelativeTime(comment.createdAt)}</Text>
        </View>
        {comment.deleted ? (
          <Text style={styles.bodyDeleted}>Comment removed</Text>
        ) : (
          <Text style={styles.body}>{comment.body}</Text>
        )}
      </Pressable>
    );
  };

  return (
    <BottomSheetModal
      ref={ref}
      snapPoints={snapPoints}
      enableDynamicSizing={false}
      enablePanDownToClose
      backdropComponent={renderBackdrop}
      footerComponent={renderFooter}
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      android_keyboardInputMode="adjustResize"
      handleIndicatorStyle={styles.handleIndicator}
      backgroundStyle={styles.sheetBackground}
      onDismiss={onDismiss}
    >
      <View style={styles.header}>
        <Text style={styles.headerTitle} numberOfLines={1}>
          Comments{target ? ` · ${target.storeName}` : ""}
        </Text>
      </View>

      {postId === null || isLoading ? (
        <View style={styles.centeredState}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : error ? (
        <View style={styles.centeredState}>
          <Text style={styles.stateText}>Could not load comments: {error.message}</Text>
          <Pressable style={styles.retryButton} onPress={() => void refetch()}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <BottomSheetFlatList
          data={rows}
          keyExtractor={rowKey}
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
            <View style={styles.emptyState}>
              <Text style={styles.emptyStateText}>
                {"\u{1F331}"} Say something nice — be the first to comment.
              </Text>
            </View>
          }
          renderItem={renderRow}
        />
      )}

      {showReportConfirmation ? (
        <View style={[styles.reportToast, shadows.raised]}>
          <Text style={styles.reportToastText}>{"\u{1F331}"} Report received — thank you.</Text>
        </View>
      ) : null}

      <Modal
        visible={reportTarget !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setReportTarget(null)}
      >
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalCard, shadows.raised]}>
            <Text style={styles.modalTitle}>Report comment</Text>
            <Text style={styles.modalSubtitle}>
              Tell us what's wrong with this comment and our team will review it.
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
              <Button
                title="Report"
                variant="danger"
                fullWidth={false}
                onPress={submitReport}
                loading={reportComment.isPending}
                disabled={reportReason.trim().length === 0}
                style={styles.modalSubmitButton}
              />
            </View>
          </View>
        </View>
      </Modal>
    </BottomSheetModal>
  );
}

export const GardenCommentsSheet = forwardRef(GardenCommentsSheetImpl);

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  sheetBackground: {
    backgroundColor: colors.surface,
  },
  handleIndicator: {
    backgroundColor: colors.border,
  },
  header: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerTitle: {
    fontSize: type.section.fontSize,
    fontWeight: type.section.fontWeight,
    color: colors.text,
    textAlign: "center",
  },
  listContent: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xxxl * 2,
  },
  row: {
    paddingVertical: spacing.sm,
    gap: 2,
  },
  rowPending: {
    opacity: 0.6,
  },
  rowHeader: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  username: {
    fontSize: type.label.fontSize,
    fontWeight: "700",
    color: colors.text,
  },
  time: {
    fontSize: type.caption.fontSize - 1,
    color: colors.textMuted,
  },
  body: {
    fontSize: type.body.fontSize,
    color: colors.text,
    lineHeight: 20,
  },
  bodyDeleted: {
    fontSize: type.body.fontSize,
    color: colors.textMuted,
    fontStyle: "italic",
  },
  centeredState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.xxxl,
    paddingVertical: spacing.xxxl,
    gap: spacing.md,
  },
  stateText: {
    fontSize: type.body.fontSize,
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
  emptyState: {
    alignItems: "center",
    paddingVertical: spacing.xxxl,
    paddingHorizontal: spacing.xxl,
  },
  emptyStateText: {
    fontSize: type.body.fontSize,
    color: colors.textMuted,
    textAlign: "center",
  },
  footerLoader: {
    marginVertical: spacing.lg,
  },
  footer: {
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
  charCount: {
    alignSelf: "flex-end",
    fontSize: type.caption.fontSize - 1,
    color: colors.pop,
    fontWeight: "600",
    marginBottom: 2,
  },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: spacing.sm,
    paddingBottom: spacing.sm,
  },
  composerInput: {
    flex: 1,
    maxHeight: 100,
    fontSize: type.body.fontSize,
    color: colors.text,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radii.lg,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm + 2,
    paddingBottom: spacing.sm + 2,
  },
  sendButton: {
    width: 36,
    height: 36,
    borderRadius: radii.pill,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  sendButtonDisabled: {
    opacity: 0.45,
  },
  reportToast: {
    position: "absolute",
    top: spacing.md,
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
    borderRadius: radii.md,
  },
});
