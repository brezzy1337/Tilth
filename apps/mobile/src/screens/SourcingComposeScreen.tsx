/**
 * SourcingComposeScreen — shared compose form for both sourcing directions
 * (F-049): a place buyer requesting produce from a grower ("request" mode,
 * pushed from SourcingScreen's grower row), or a grower offering to supply a
 * place ("offer" mode, pushed from PlaceInfoCard's "Offer to supply"
 * button). Header copy and the mutation called are the only things that
 * differ between the two modes — the fields are identical.
 *
 * Fields: produce (required, <=120), quantity (required free text, <=80),
 * needed-by (optional YYYY-MM-DD — two quick chips ["This week" / "Next
 * week"] plus a plain text field for a custom date; no date-picker
 * dependency), note (optional multiline, <=500).
 *
 * On submit: sourcing.createRequest or sourcing.createOffer, then invalidate
 * chat.list (new conversation may appear in the inbox) + sourcing.listMine,
 * and replace this screen with Conversation for the returned conversationId
 * (only conversationId is passed — ConversationScreen already resolves the
 * rest from chat.list when params are incomplete, same as a push-notification
 * deep link).
 *
 * TOO_MANY_REQUESTS and BAD_REQUEST surface as friendly inline copy rather
 * than raw server error text (mirrors ConversationScreen's send-error
 * handling).
 *
 * No form library — useState + shared zod safeParse, same convention as
 * YourStandScreen/GardenComposerScreen.
 *
 * React Native only — no DOM elements.
 */

import React, { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { createSourcingRequestInput, createSourcingOfferInput } from "@homegrown/shared";
import { trpc } from "../api/trpc";
import type { AuthedStackParamList } from "../navigation/types";
import { Card } from "../components/Card";
import { Button } from "../components/Button";
import { FormField } from "../components/FormField";
import { colors, radii, spacing, type } from "../theme";
import { toIsoDate } from "../utils/time";

type Props = NativeStackScreenProps<AuthedStackParamList, "SourcingCompose">;

const RATE_LIMITED_MESSAGE = "You're sending messages too quickly — give it a moment.";
const BLOCKED_MESSAGE = "You can't send this right now.";

function quickChipDate(daysFromNow: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return toIsoDate(d);
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function describeError(err: { data?: { code?: string } | null; message?: string }): string {
  if (err.data?.code === "TOO_MANY_REQUESTS") return RATE_LIMITED_MESSAGE;
  if (err.data?.code === "FORBIDDEN") return BLOCKED_MESSAGE;
  if (err.data?.code === "NOT_FOUND") {
    return "That store or place couldn't be found — it may no longer be available.";
  }
  return err.message ?? "Something went wrong. Please try again.";
}

export function SourcingComposeScreen({ route, navigation }: Props) {
  const { mode } = route.params;
  const utils = trpc.useUtils();

  const [produce, setProduce] = useState("");
  const [quantity, setQuantity] = useState("");
  const [neededBy, setNeededBy] = useState("");
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<{
    produce?: string;
    quantity?: string;
    neededBy?: string;
    note?: string;
  }>({});
  const [serverError, setServerError] = useState<string | null>(null);

  const createRequest = trpc.sourcing.createRequest.useMutation();
  const createOffer = trpc.sourcing.createOffer.useMutation();
  const isPending = createRequest.isPending || createOffer.isPending;

  function handleSuccess(conversationId: string) {
    void utils.chat.list.invalidate();
    void utils.sourcing.listMine.invalidate();
    navigation.replace("Conversation", { conversationId });
  }

  function handleError(err: { data?: { code?: string } | null; message?: string }) {
    setServerError(describeError(err));
  }

  function handleSubmit() {
    setErrors({});
    setServerError(null);

    const base = {
      produce,
      quantity,
      neededBy: neededBy.trim() !== "" ? neededBy.trim() : undefined,
      note: note.trim() !== "" ? note.trim() : undefined,
    };

    if (mode === "request") {
      const result = createSourcingRequestInput.safeParse({ ...base, storeId: route.params.storeId });
      if (!result.success) {
        const flat = result.error.flatten().fieldErrors;
        setErrors({
          produce: flat.produce?.[0],
          quantity: flat.quantity?.[0],
          neededBy: flat.neededBy?.[0],
          note: flat.note?.[0],
        });
        return;
      }
      createRequest.mutate(result.data, {
        onSuccess: (data) => handleSuccess(data.conversationId),
        onError: handleError,
      });
    } else {
      const result = createSourcingOfferInput.safeParse({ ...base, placeId: route.params.placeId });
      if (!result.success) {
        const flat = result.error.flatten().fieldErrors;
        setErrors({
          produce: flat.produce?.[0],
          quantity: flat.quantity?.[0],
          neededBy: flat.neededBy?.[0],
          note: flat.note?.[0],
        });
        return;
      }
      createOffer.mutate(result.data, {
        onSuccess: (data) => handleSuccess(data.conversationId),
        onError: handleError,
      });
    }
  }

  const isRequest = mode === "request";
  const targetName = isRequest ? route.params.storeName : route.params.placeName;
  const pageTitle = isRequest ? "🧺 Request produce" : "🧺 Offer to supply";
  const neededByLabel = isRequest ? "Needed by (optional)" : "Available by (optional)";

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
          <Text style={styles.pageTitle}>{pageTitle}</Text>
          <Text style={styles.pageSubtitle}>
            {isRequest ? `Ask ${targetName} to supply produce.` : `Offer to supply ${targetName}.`}
          </Text>

          <Card style={styles.formCard}>
            <FormField
              label="Produce"
              value={produce}
              onChangeText={setProduce}
              error={errors.produce}
              placeholder="e.g. heirloom tomatoes"
              autoCapitalize="none"
              maxLength={120}
            />

            <FormField
              label="Quantity"
              value={quantity}
              onChangeText={setQuantity}
              error={errors.quantity}
              placeholder="e.g. 20 lb"
              autoCapitalize="none"
              maxLength={80}
            />

            <View style={styles.fieldGroup}>
              <Text style={styles.label}>{neededByLabel}</Text>
              <View style={styles.chipRow}>
                <Pressable
                  style={[styles.chip, neededBy === quickChipDate(7) ? styles.chipActive : null]}
                  onPress={() => setNeededBy(quickChipDate(7))}
                >
                  <Text
                    style={[styles.chipText, neededBy === quickChipDate(7) ? styles.chipTextActive : null]}
                  >
                    This week
                  </Text>
                </Pressable>
                <Pressable
                  style={[styles.chip, neededBy === quickChipDate(14) ? styles.chipActive : null]}
                  onPress={() => setNeededBy(quickChipDate(14))}
                >
                  <Text
                    style={[styles.chipText, neededBy === quickChipDate(14) ? styles.chipTextActive : null]}
                  >
                    Next week
                  </Text>
                </Pressable>
                {neededBy !== "" ? (
                  <Pressable style={styles.chip} onPress={() => setNeededBy("")}>
                    <Text style={styles.chipText}>Clear</Text>
                  </Pressable>
                ) : null}
              </View>
              <TextInput
                style={[styles.dateInput, errors.neededBy ? styles.dateInputError : null]}
                value={neededBy}
                onChangeText={setNeededBy}
                placeholder="Or type a date: YYYY-MM-DD"
                placeholderTextColor={colors.textMuted}
                autoCapitalize="none"
                maxLength={10}
              />
              {errors.neededBy ? (
                <Text style={styles.fieldError}>{errors.neededBy}</Text>
              ) : neededBy !== "" && !ISO_DATE_RE.test(neededBy) ? (
                <Text style={styles.fieldHint}>Use the YYYY-MM-DD format, e.g. 2026-08-01.</Text>
              ) : null}
            </View>

            <FormField
              label="Note (optional)"
              value={note}
              onChangeText={setNote}
              error={errors.note}
              placeholder="Anything else the other side should know…"
              multiline
              numberOfLines={3}
              maxLength={500}
              style={styles.multilineInput}
            />

            {serverError ? <Text style={styles.serverError}>{serverError}</Text> : null}

            <Button
              title={isRequest ? "Send request" : "Send offer"}
              onPress={handleSubmit}
              loading={isPending}
              disabled={isPending}
            />
          </Card>

          <Pressable style={styles.cancelButton} onPress={() => navigation.goBack()} disabled={isPending}>
            <Text style={styles.cancelButtonText}>Cancel</Text>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  flex: { flex: 1 },
  safeArea: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  container: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xxxl * 1.5,
  },
  pageTitle: {
    fontSize: type.title.fontSize,
    fontWeight: type.title.fontWeight,
    color: colors.text,
    marginBottom: spacing.xs,
  },
  pageSubtitle: {
    fontSize: type.caption.fontSize,
    color: colors.textMuted,
    marginBottom: spacing.xl,
  },
  formCard: {
    marginBottom: spacing.lg,
  },
  fieldGroup: {
    marginBottom: spacing.lg,
  },
  label: {
    fontSize: type.label.fontSize,
    fontWeight: type.label.fontWeight,
    color: colors.text,
    marginBottom: spacing.sm,
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  chip: {
    paddingVertical: spacing.sm - 2,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  chipText: {
    fontSize: type.caption.fontSize,
    color: colors.text,
  },
  chipTextActive: {
    color: colors.onPrimary,
    fontWeight: "700",
  },
  dateInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    fontSize: type.body.fontSize,
    color: colors.text,
    backgroundColor: colors.surface,
  },
  dateInputError: {
    borderColor: colors.danger,
  },
  fieldHint: {
    marginTop: spacing.xs,
    fontSize: 12,
    color: colors.textMuted,
  },
  fieldError: {
    marginTop: spacing.xs,
    fontSize: 12,
    color: colors.danger,
  },
  multilineInput: {
    minHeight: 80,
    textAlignVertical: "top",
  },
  serverError: {
    marginBottom: spacing.md,
    fontSize: type.caption.fontSize,
    color: colors.danger,
    textAlign: "center",
  },
  cancelButton: {
    paddingVertical: spacing.md,
    alignItems: "center",
    marginTop: spacing.md,
  },
  cancelButtonText: {
    color: colors.textMuted,
    fontSize: type.caption.fontSize + 1,
  },
});
