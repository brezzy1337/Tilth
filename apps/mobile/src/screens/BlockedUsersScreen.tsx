/**
 * BlockedUsersScreen — Settings > Privacy > Blocked users (F-051).
 *
 * Data: `chat.listBlocked` (newest-block-first, capped at 200 — see
 * chat.ts). Each row shows the blocked username + a relative "blocked ago"
 * timestamp (`formatRelativeTime`, same util MessagesScreen uses for
 * `blockedAt`'s ISO 8601 datetime) and an "Unblock" button that calls
 * `chat.unblockUser` (idempotent server-side) and invalidates the list.
 *
 * Empty-state emoji: MessagesScreen uses 🌱 (garden growth), Cart/stalls use
 * 🧺 (produce baskets) — this list is about moderation, so it gets its own,
 * distinct-but-adjacent mark: 🕊️ (nothing to block — peace).
 *
 * React Native only — no DOM elements.
 */

import React from "react";
import {
  ActivityIndicator,
  FlatList,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { BlockedUser } from "@homegrown/shared";
import { trpc } from "../api/trpc";
import { Button } from "../components/Button";
import { formatRelativeTime } from "../utils/time";
import { colors, radii, spacing, type } from "../theme";

function BlockedUserRow({ item }: { item: BlockedUser }) {
  const utils = trpc.useUtils();

  const unblockMutation = trpc.chat.unblockUser.useMutation({
    onSuccess: () => {
      void utils.chat.listBlocked.invalidate();
    },
  });

  return (
    <View style={styles.row}>
      <View style={styles.rowBody}>
        <Text style={styles.rowName}>{item.username}</Text>
        <Text style={styles.rowSubtext}>Blocked {formatRelativeTime(item.blockedAt)}</Text>
      </View>
      <Button
        title="Unblock"
        variant="secondary"
        fullWidth={false}
        onPress={() => unblockMutation.mutate({ userId: item.userId })}
        loading={unblockMutation.isPending}
      />
    </View>
  );
}

export function BlockedUsersScreen() {
  const { data, isLoading, error, refetch } = trpc.chat.listBlocked.useQuery();

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
          <Text style={styles.stateText}>Could not load blocked users: {error.message}</Text>
          <Button title="Retry" variant="ghost" fullWidth={false} onPress={() => void refetch()} />
        </View>
      </SafeAreaView>
    );
  }

  const items = data ?? [];

  return (
    <SafeAreaView style={styles.safeArea}>
      <FlatList
        data={items}
        keyExtractor={(item) => item.userId}
        contentContainerStyle={items.length === 0 ? styles.emptyListContent : styles.listContent}
        renderItem={({ item }) => <BlockedUserRow item={item} />}
        ListEmptyComponent={
          <View style={styles.centeredState}>
            <Text style={styles.emptyEmoji}>{"\u{1F54A}\u{FE0F}"}</Text>
            <Text style={styles.stateText}>No blocked users</Text>
            <Text style={styles.stateSubText}>
              Anyone you block from a conversation will show up here.
            </Text>
          </View>
        }
      />
    </SafeAreaView>
  );
}

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
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: colors.surface,
    marginHorizontal: spacing.lg,
    marginVertical: spacing.xs,
    borderRadius: radii.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.md,
  },
  rowBody: {
    flex: 1,
    gap: 2,
  },
  rowName: {
    fontSize: type.section.fontSize,
    fontWeight: "600",
    color: colors.text,
  },
  rowSubtext: {
    fontSize: type.caption.fontSize,
    color: colors.textMuted,
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
});
