/**
 * CartScreen — buyer cart with PaymentSheet checkout.
 *
 * Lists line items with quantity stepper (−/+), line totals, and remove.
 * Shows store name and running subtotal.
 * "Pay" button runs the full PaymentSheet flow:
 *   1. orders.create → (order, clientSecret)
 *   2. initPaymentSheet
 *   3. presentPaymentSheet
 *   On Canceled: abort quietly.
 *   On any other presentErr: show error and stop.
 *   On success: clearCart → navigate to OrderDetail immediately.
 *   OrderDetailScreen is the single confirmer (it polls orders.get while
 *   status === "pending_payment" via refetchInterval).
 *
 * Unmount-safe: mountedRef guards every setState that runs after an await.
 *
 * React Native only — no DOM elements.
 * Money: integer cents throughout; formatCents for display.
 */

import React, { useEffect, useRef, useState } from "react";
import {
  FlatList,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useStripe } from "@stripe/stripe-react-native";
import type { FulfillmentMethod } from "@homegrown/shared";
import { trpc } from "../api/trpc";
import { useCart } from "../cart/CartContext";
import type { AuthedStackParamList } from "../navigation/types";
import { formatCents } from "../utils/money";
import { Card } from "../components/Card";
import { Button } from "../components/Button";
import { colors, radii, spacing, type } from "../theme";

type Props = NativeStackScreenProps<AuthedStackParamList, "Cart">;

// ---------------------------------------------------------------------------
// CartScreen
// ---------------------------------------------------------------------------

export function CartScreen({ navigation }: Props) {
  const { items, storeName, itemCount, subtotalCents, setQuantity, removeItem, clearCart } =
    useCart();
  const { initPaymentSheet, presentPaymentSheet } = useStripe();

  const createOrder = trpc.orders.create.useMutation();

  const [fulfillmentMethod, setFulfillmentMethod] = useState<FulfillmentMethod>("pickup");
  const [deliveryAddress, setDeliveryAddress] = useState("");
  const [showTip, setShowTip] = useState(false);
  const [tipText, setTipText] = useState("");

  const [checkoutStatus, setCheckoutStatus] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [isCheckingOut, setIsCheckingOut] = useState(false);

  // Tip: parse tipText to integer cents; clamp to [0, 100_000]
  // (lower bound guards a stray negative entry from showing a total below subtotal).
  const tipCents = Math.max(0, Math.min(Math.round((parseFloat(tipText) || 0) * 100), 100000));
  const totalCents = subtotalCents + tipCents;

  // Unmount guard — prevents setState calls on an unmounted component.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  async function handleCheckout() {
    if (items.length === 0) return;

    setIsCheckingOut(true);
    setCheckoutError(null);
    setCheckoutStatus("Creating order…");

    try {
      // Step 1: create order
      const orderItems = items.map((i) => ({ listingId: i.listingId, quantity: i.quantity }));
      let orderResult: Awaited<ReturnType<typeof createOrder.mutateAsync>>;
      try {
        orderResult = await createOrder.mutateAsync({
          items: orderItems,
          fulfillmentMethod,
          deliveryAddress: fulfillmentMethod === "delivery" ? deliveryAddress.trim() : undefined,
          ...(tipCents > 0 ? { tipCents } : {}),
        });
      } catch (err) {
        if (!mountedRef.current) return;
        const msg = err instanceof Error ? err.message : "Could not create order. Try again.";
        setCheckoutError(msg);
        setCheckoutStatus(null);
        setIsCheckingOut(false);
        return;
      }

      const { order, clientSecret } = orderResult;

      // Step 2: init PaymentSheet
      if (!mountedRef.current) return;
      setCheckoutStatus("Initialising payment…");
      const { error: initErr } = await initPaymentSheet({
        merchantDisplayName: "Tilth",
        paymentIntentClientSecret: clientSecret,
        returnURL: "homegrown://stripe-redirect",
      });
      if (initErr) {
        if (!mountedRef.current) return;
        setCheckoutError(initErr.message ?? "Could not initialise payment.");
        setCheckoutStatus(null);
        setIsCheckingOut(false);
        return;
      }

      // Step 3: present PaymentSheet
      if (!mountedRef.current) return;
      setCheckoutStatus("Waiting for payment…");
      const { error: presentErr } = await presentPaymentSheet();
      if (presentErr) {
        if (presentErr.code === "Canceled") {
          // Buyer dismissed — quiet abort
          if (!mountedRef.current) return;
          setCheckoutStatus(null);
          setIsCheckingOut(false);
          return;
        }
        if (!mountedRef.current) return;
        setCheckoutError(presentErr.message ?? "Payment failed. Please try again.");
        setCheckoutStatus(null);
        setIsCheckingOut(false);
        return;
      }

      // Payment sheet completed without error.
      // Navigate immediately — OrderDetailScreen is the single confirmer
      // (it polls orders.get via refetchInterval while status === "pending_payment").
      clearCart();
      navigation.replace("OrderDetail", { orderId: order.id });
    } finally {
      if (mountedRef.current) {
        setIsCheckingOut(false);
        setCheckoutStatus(null);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Empty state
  // ---------------------------------------------------------------------------

  if (itemCount === 0) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.centeredState}>
          <Text style={styles.emptyEmoji}>{"\u{1F9FA}"}</Text>
          <Text style={styles.stateText}>Your cart is empty.</Text>
          <Text style={styles.stateSubText}>Browse nearby produce to add items.</Text>
        </View>
      </SafeAreaView>
    );
  }

  // ---------------------------------------------------------------------------
  // Cart with items
  // ---------------------------------------------------------------------------

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.container}>
        {storeName ? <Text style={styles.storeLabel}>From: {storeName}</Text> : null}

        <FlatList
          data={items}
          keyExtractor={(item) => item.listingId}
          scrollEnabled={false}
          renderItem={({ item }) => (
            <Card style={styles.lineCard}>
              <View style={styles.lineHeader}>
                <Text style={styles.lineName}>{item.name}</Text>
                <Pressable onPress={() => removeItem(item.listingId)} style={styles.removeButton}>
                  <Text style={styles.removeText}>Remove</Text>
                </Pressable>
              </View>
              <Text style={styles.linePrice}>
                ${formatCents(item.priceCents)} / {item.unit}
              </Text>
              <View style={styles.stepperRow}>
                <Pressable
                  style={styles.stepperButton}
                  onPress={() => setQuantity(item.listingId, item.quantity - 1)}
                  disabled={item.quantity <= 1}
                >
                  <Text style={styles.stepperText}>−</Text>
                </Pressable>
                <Text style={styles.stepperQty}>{item.quantity}</Text>
                <Pressable
                  style={styles.stepperButton}
                  onPress={() => setQuantity(item.listingId, item.quantity + 1)}
                  disabled={item.quantity >= Math.min(item.available, 1000)}
                >
                  <Text style={styles.stepperText}>+</Text>
                </Pressable>
                <Text style={styles.lineTotal}>
                  = ${formatCents(item.priceCents * item.quantity)}
                </Text>
              </View>
            </Card>
          )}
        />

        {/* Order summary: subtotal + optional tip */}
        <View style={styles.tipSection}>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Subtotal</Text>
            <Text style={styles.summaryValue}>${formatCents(subtotalCents)}</Text>
          </View>
          {!showTip ? (
            <Pressable onPress={() => setShowTip(true)} style={styles.tipLink}>
              <Text style={styles.tipLinkText}>Add a tip for your grower (optional)</Text>
            </Pressable>
          ) : (
            <TextInput
              style={styles.tipInput}
              placeholder="0.00"
              placeholderTextColor={colors.textMuted}
              keyboardType="decimal-pad"
              value={tipText}
              onChangeText={setTipText}
              returnKeyType="done"
            />
          )}
          {tipCents > 0 ? (
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Tip</Text>
              <Text style={styles.summaryValue}>${formatCents(tipCents)}</Text>
            </View>
          ) : null}
        </View>

        {/* Fulfillment selector */}
        <View style={styles.fulfillmentRow}>
          <Pressable
            style={[
              styles.fulfillmentChip,
              fulfillmentMethod === "pickup" && styles.fulfillmentChipActive,
            ]}
            onPress={() => setFulfillmentMethod("pickup")}
          >
            <Text
              style={[
                styles.fulfillmentChipText,
                fulfillmentMethod === "pickup" && styles.fulfillmentChipTextActive,
              ]}
            >
              Pickup
            </Text>
          </Pressable>
          <Pressable
            style={[
              styles.fulfillmentChip,
              fulfillmentMethod === "delivery" && styles.fulfillmentChipActive,
            ]}
            onPress={() => setFulfillmentMethod("delivery")}
          >
            <Text
              style={[
                styles.fulfillmentChipText,
                fulfillmentMethod === "delivery" && styles.fulfillmentChipTextActive,
              ]}
            >
              Delivery
            </Text>
          </Pressable>
        </View>

        {/* Delivery address input — shown only when Delivery is selected */}
        {fulfillmentMethod === "delivery" ? (
          <TextInput
            style={styles.addressInput}
            placeholder="Delivery address"
            placeholderTextColor={colors.textMuted}
            value={deliveryAddress}
            onChangeText={setDeliveryAddress}
            autoCorrect={false}
            returnKeyType="done"
          />
        ) : null}

        {/* Delivery address hint when empty */}
        {fulfillmentMethod === "delivery" && deliveryAddress.trim().length === 0 ? (
          <Text style={styles.addressHint}>Enter a delivery address to continue.</Text>
        ) : null}

        {/* Checkout status / error */}
        {checkoutStatus ? (
          <Text style={styles.statusText}>{checkoutStatus}</Text>
        ) : null}
        {checkoutError ? (
          <Text style={styles.errorText}>{checkoutError}</Text>
        ) : null}

        {/* Pay button */}
        {(() => {
          const deliveryBlocked =
            fulfillmentMethod === "delivery" && deliveryAddress.trim().length === 0;
          return (
            <Button
              title={`Pay $${formatCents(totalCents)}`}
              onPress={() => void handleCheckout()}
              loading={isCheckingOut}
              disabled={deliveryBlocked}
            />
          );
        })()}
      </ScrollView>
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
  container: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xl,
    paddingBottom: spacing.xxxl * 1.5,
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
    fontSize: type.caption.fontSize,
    color: colors.textMuted,
    textAlign: "center",
  },
  storeLabel: {
    fontSize: type.body.fontSize,
    color: colors.primary,
    fontWeight: "600",
    marginBottom: spacing.lg,
  },
  lineCard: {
    marginBottom: spacing.md,
  },
  lineHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: spacing.xs,
  },
  lineName: {
    fontSize: type.body.fontSize,
    fontWeight: "600",
    color: colors.text,
    flex: 1,
  },
  removeButton: {
    paddingVertical: 2,
    paddingHorizontal: spacing.sm,
  },
  removeText: {
    fontSize: 12,
    color: colors.danger,
    fontWeight: "600",
  },
  linePrice: {
    fontSize: type.caption.fontSize,
    color: colors.textMuted,
    marginBottom: spacing.sm,
  },
  stepperRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  stepperButton: {
    width: 32,
    height: 32,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  stepperText: {
    fontSize: 18,
    color: colors.primary,
    fontWeight: "600",
    lineHeight: 22,
  },
  stepperQty: {
    fontSize: type.body.fontSize + 1,
    fontWeight: "600",
    color: colors.text,
    minWidth: 24,
    textAlign: "center",
  },
  lineTotal: {
    fontSize: type.caption.fontSize + 1,
    color: colors.primary,
    fontWeight: "700",
    marginLeft: "auto",
  },
  tipSection: {
    marginTop: spacing.sm,
    marginBottom: spacing.lg,
    paddingHorizontal: spacing.xs,
  },
  summaryRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: spacing.xs,
  },
  tipLink: {
    paddingVertical: spacing.xs,
    alignSelf: "flex-start",
  },
  tipLinkText: {
    fontSize: 12,
    color: colors.textMuted,
    textDecorationLine: "underline",
  },
  tipInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    paddingVertical: spacing.xs + 2,
    paddingHorizontal: spacing.md,
    fontSize: type.caption.fontSize + 1,
    color: colors.text,
    backgroundColor: colors.surface,
    marginTop: spacing.xs + 2,
    marginBottom: spacing.xs,
    alignSelf: "flex-start",
    minWidth: 100,
  },
  summaryLabel: {
    fontSize: type.body.fontSize + 1,
    fontWeight: "600",
    color: colors.text,
  },
  summaryValue: {
    fontSize: type.section.fontSize - 1,
    fontWeight: "700",
    color: colors.primary,
  },
  statusText: {
    fontSize: type.caption.fontSize,
    color: colors.textMuted,
    textAlign: "center",
    marginBottom: spacing.md,
  },
  errorText: {
    fontSize: type.caption.fontSize,
    color: colors.danger,
    textAlign: "center",
    marginBottom: spacing.md,
  },
  fulfillmentRow: {
    flexDirection: "row",
    gap: spacing.sm + 2,
    marginBottom: spacing.md,
  },
  fulfillmentChip: {
    flex: 1,
    paddingVertical: spacing.sm + 2,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.primary,
    alignItems: "center",
  },
  fulfillmentChipActive: {
    backgroundColor: colors.primary,
  },
  fulfillmentChipText: {
    fontSize: type.caption.fontSize + 1,
    fontWeight: "600",
    color: colors.primary,
  },
  fulfillmentChipTextActive: {
    color: colors.onPrimary,
  },
  addressInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.md,
    fontSize: type.caption.fontSize + 1,
    color: colors.text,
    backgroundColor: colors.surface,
    marginBottom: spacing.sm,
  },
  addressHint: {
    fontSize: 12,
    color: colors.textMuted,
    marginBottom: spacing.sm,
  },
});
