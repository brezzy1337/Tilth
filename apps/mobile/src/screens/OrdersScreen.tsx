/**
 * OrdersScreen — buyer order history.
 *
 * Fetches trpc.orders.listMine (newest first).
 * FlatList: short order id, created date, total, status pill.
 * Tap → navigate to OrderDetail.
 * States: loading, error, empty ("No orders yet"), list.
 *
 * React Native only — no DOM elements.
 */

import React from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { OrderStatus } from "@homegrown/shared";
import { trpc } from "../api/trpc";
import type { AuthedStackParamList } from "../navigation/types";
import { formatCents } from "../utils/money";
import { capitalise } from "../utils/text";

type Props = NativeStackScreenProps<AuthedStackParamList, "Orders">;

// ---------------------------------------------------------------------------
// Status pill
// ---------------------------------------------------------------------------

function StatusPill({ status }: { status: OrderStatus }) {
  const config = STATUS_CONFIG[status] ?? { label: capitalise(status), bg: "#e5e7eb", text: "#374151" };
  return (
    <View style={[styles.pill, { backgroundColor: config.bg }]}>
      <Text style={[styles.pillText, { color: config.text }]}>{config.label}</Text>
    </View>
  );
}

const STATUS_CONFIG: Record<
  OrderStatus,
  { label: string; bg: string; text: string }
> = {
  pending_payment: { label: "Finalizing", bg: "#fff8e1", text: "#92400e" },
  paid:            { label: "Paid",       bg: "#e8f5e9", text: "#2d6a4f" },
  fulfilled:       { label: "Fulfilled",  bg: "#e0f2f1", text: "#00695c" },
  cancelled:       { label: "Cancelled",  bg: "#fce4ec", text: "#b71c1c" },
  refunded:        { label: "Refunded",   bg: "#f3e5f5", text: "#6a1b9a" },
  disputed:        { label: "Disputed",   bg: "#fff3e0", text: "#e65100" },
};

// ---------------------------------------------------------------------------
// OrdersScreen
// ---------------------------------------------------------------------------

export function OrdersScreen({ navigation }: Props) {
  const { data: orders, isLoading, error, refetch } = trpc.orders.listMine.useQuery();

  if (isLoading) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.centeredState}>
          <ActivityIndicator size="large" color="#2d6a4f" />
        </View>
      </SafeAreaView>
    );
  }

  if (error) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.centeredState}>
          <Text style={styles.stateText}>Could not load orders.</Text>
          <Text style={styles.stateSubText}>{error.message}</Text>
          <Pressable style={styles.retryButton} onPress={() => void refetch()}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  if (!orders || orders.length === 0) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.centeredState}>
          <Text style={styles.stateText}>No orders yet.</Text>
          <Text style={styles.stateSubText}>Browse nearby produce to place your first order.</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <FlatList
        data={orders}
        keyExtractor={(o) => o.id}
        contentContainerStyle={styles.listContent}
        renderItem={({ item }) => (
          <Pressable
            style={styles.orderCard}
            onPress={() => navigation.navigate("OrderDetail", { orderId: item.id })}
          >
            <View style={styles.orderRow}>
              <Text style={styles.orderId}>#{item.id.slice(0, 8).toUpperCase()}</Text>
              <StatusPill status={item.status} />
            </View>
            <View style={styles.orderRow}>
              <Text style={styles.orderDate}>
                {new Date(item.createdAt).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </Text>
              <Text style={styles.orderTotal}>${formatCents(item.totalCents)}</Text>
            </View>
          </Pressable>
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
    backgroundColor: "#f7f9f7",
  },
  centeredState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
    gap: 8,
  },
  stateText: {
    fontSize: 16,
    color: "#444",
    textAlign: "center",
    fontWeight: "600",
  },
  stateSubText: {
    fontSize: 13,
    color: "#888",
    textAlign: "center",
  },
  listContent: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 32,
    gap: 10,
  },
  orderCard: {
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 16,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 3,
    elevation: 1,
    gap: 8,
  },
  orderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  orderId: {
    fontSize: 14,
    fontWeight: "700",
    color: "#1a1a1a",
    fontVariant: ["tabular-nums"],
  },
  orderDate: {
    fontSize: 13,
    color: "#888",
  },
  orderTotal: {
    fontSize: 15,
    fontWeight: "700",
    color: "#2d6a4f",
  },
  pill: {
    paddingVertical: 3,
    paddingHorizontal: 10,
    borderRadius: 12,
  },
  pillText: {
    fontSize: 12,
    fontWeight: "600",
  },
  retryButton: {
    paddingVertical: 8,
    paddingHorizontal: 20,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#2d6a4f",
    marginTop: 8,
  },
  retryText: {
    color: "#2d6a4f",
    fontSize: 14,
    fontWeight: "600",
  },
});
