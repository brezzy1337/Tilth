/**
 * MessagesScreen — conversation inbox (F-037), the Messages tab.
 *
 * Data: trpc.chat.list.useInfiniteQuery — the caller's conversations (as
 * buyer OR store owner), most-recent-activity first, keyset cursor-paginated
 * via nextCursor (same convention as GardenFeedScreen / StoreOrdersScreen).
 *
 * Each row shows the counterpart's name (store name when the viewer is the
 * buyer, buyer username when the viewer is the store owner), a preview of the
 * last message (dimmed placeholder when the thread has none yet), a compact
 * relative timestamp, and an unread-count badge. Tapping a row pushes the
 * Conversation screen with the full summary so its header renders instantly.
 *
 * The inbox is invalidated on focus so unread badges refresh after reading a
 * thread and returning here.
 *
 * React Native only — no DOM elements.
 */

import React, { useCallback } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { BottomTabScreenProps } from "@react-navigation/bottom-tabs";
import { useFocusEffect } from "@react-navigation/native";
import type { ConversationSummary } from "@homegrown/shared";
import { trpc } from "../api/trpc";
import { useAuth } from "../auth/AuthContext";
import { useInfiniteScrollEnd } from "../hooks/useInfiniteScrollEnd";
import type { MessagesTabNavigationProp, TabParamList } from "../navigation/types";
import { formatRelativeTime } from "../utils/time";
import { colors, radii, spacing, type } from "../theme";

const PAGE_LIMIT = 30;

type Props = Omit<BottomTabScreenProps<TabParamList, "Messages">, "navigation"> & {
  navigation: MessagesTabNavigationProp;
};

// ---------------------------------------------------------------------------
// ConversationRow
// ---------------------------------------------------------------------------

type RowProps = {
  item: ConversationSummary;
  viewerId: string;
  onPress: () => void;
};

function ConversationRow({ item, viewerId, onPress }: RowProps) {
  const isViewerBuyer = item.buyerId === viewerId;
  const counterpartName = isViewerBuyer ? item.storeName : item.buyerName;
  const hasMessages = item.lastMessageBody !== null;
  const isUnread = item.unreadCount > 0;

  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed ? styles.rowPressed : null]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Conversation with ${counterpartName}${
        item.unreadCount > 0 ? `, ${item.unreadCount} unread` : ""
      }`}
    >
      <View style={styles.rowBody}>
        <View style={styles.rowTopLine}>
          <Text style={[styles.rowName, isUnread ? styles.rowNameUnread : null]} numberOfLines={1}>
            {counterpartName}
          </Text>
          {item.lastMessageAt ? (
            <Text style={styles.rowTime}>{formatRelativeTime(item.lastMessageAt)}</Text>
          ) : null}
        </View>
        <View style={styles.rowBottomLine}>
          <Text
            style={[
              styles.rowPreview,
              isUnread ? styles.rowPreviewUnread : null,
              !hasMessages ? styles.rowPreviewEmpty : null,
            ]}
            numberOfLines={1}
          >
            {item.lastMessageBody ?? "No messages yet"}
          </Text>
          {item.unreadCount > 0 ? (
            <View style={styles.unreadBadge}>
              <Text style={styles.unreadBadgeText}>
                {item.unreadCount > 99 ? "99+" : item.unreadCount}
              </Text>
            </View>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// MessagesScreen
// ---------------------------------------------------------------------------

export function MessagesScreen({ navigation }: Props) {
  const { user } = useAuth();
  const utils = trpc.useUtils();

  const {
    data,
    isLoading,
    isRefetching,
    error,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = trpc.chat.list.useInfiniteQuery(
    { limit: PAGE_LIMIT },
    { getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined },
  );

  // Refresh unread counts whenever the tab regains focus (e.g. after reading
  // a thread and coming back).
  useFocusEffect(
    useCallback(() => {
      void utils.chat.list.invalidate();
    }, [utils]),
  );

  const handleEndReached = useInfiniteScrollEnd({
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  });

  const items: ConversationSummary[] = data?.pages.flatMap((page) => page.items) ?? [];

  if (isLoading) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.centeredState}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  if (error) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.centeredState}>
          <Text style={styles.stateText}>Could not load messages: {error.message}</Text>
          <Pressable style={styles.retryButton} onPress={() => void refetch()}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        contentContainerStyle={items.length === 0 ? styles.emptyListContent : styles.listContent}
        onEndReached={handleEndReached}
        onEndReachedThreshold={0.5}
        refreshControl={
          <RefreshControl
            refreshing={isRefetching}
            onRefresh={() => void refetch()}
            tintColor={colors.primary}
          />
        }
        ListEmptyComponent={
          <View style={styles.centeredState}>
            <Text style={styles.emptyEmoji}>{"\u{1F331}"}</Text>
            <Text style={styles.stateText}>No conversations yet</Text>
            <Text style={styles.stateSubText}>
              Message a grower from their stand and it will show up here.
            </Text>
          </View>
        }
        ListFooterComponent={
          isFetchingNextPage ? (
            <ActivityIndicator size="small" color={colors.primary} style={styles.footerLoader} />
          ) : null
        }
        renderItem={({ item }) => (
          <ConversationRow
            item={item}
            viewerId={user?.id ?? ""}
            onPress={() =>
              navigation.navigate("Conversation", {
                conversationId: item.id,
                storeId: item.storeId,
                storeName: item.storeName,
                storeUserId: item.storeUserId,
                buyerId: item.buyerId,
                buyerName: item.buyerName,
              })
            }
          />
        )}
      />
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  listContent: {
    paddingVertical: spacing.sm,
  },
  emptyListContent: {
    flexGrow: 1,
  },
  row: {
    backgroundColor: colors.surface,
    marginHorizontal: spacing.lg,
    marginVertical: spacing.xs,
    borderRadius: radii.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  rowPressed: {
    backgroundColor: colors.surfaceAlt,
  },
  rowBody: {
    gap: spacing.xs,
  },
  rowTopLine: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  rowName: {
    flex: 1,
    fontSize: type.section.fontSize,
    fontWeight: "600",
    color: colors.text,
  },
  // Unread rows carry extra visual weight so they pull the eye in a mixed
  // list: full-bold name + near-bold, full-contrast preview.
  rowNameUnread: {
    fontWeight: type.section.fontWeight,
  },
  rowTime: {
    fontSize: type.caption.fontSize,
    color: colors.textMuted,
  },
  rowBottomLine: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  rowPreview: {
    flex: 1,
    fontSize: type.body.fontSize,
    color: colors.textMuted,
  },
  rowPreviewUnread: {
    color: colors.text,
    fontWeight: "600",
  },
  rowPreviewEmpty: {
    fontStyle: "italic",
    opacity: 0.7,
  },
  unreadBadge: {
    minWidth: 22,
    height: 22,
    borderRadius: radii.pill,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.xs + 2,
  },
  unreadBadgeText: {
    fontSize: type.caption.fontSize - 1,
    fontWeight: "700",
    color: colors.text,
  },
  centeredState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.xxxl,
    gap: spacing.sm,
  },
  emptyEmoji: {
    fontSize: 40,
    marginBottom: spacing.xs,
  },
  stateText: {
    fontSize: type.body.fontSize + 1,
    color: colors.text,
    textAlign: "center",
    fontWeight: "600",
  },
  stateSubText: {
    fontSize: type.caption.fontSize + 1,
    color: colors.textMuted,
    textAlign: "center",
  },
  retryButton: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xl,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.primary,
    marginTop: spacing.sm,
  },
  retryText: {
    color: colors.primary,
    fontSize: type.caption.fontSize + 1,
    fontWeight: "600",
  },
  footerLoader: {
    marginVertical: spacing.lg,
  },
});
