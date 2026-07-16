/**
 * ReportReasonModal — the reason-TextInput-in-a-transparent-Modal shared by
 * ConversationScreen (report message) and GardenCommentsSheet (report
 * comment). Extracted verbatim from the two identical copies — title,
 * subtitle, and submit copy stay per-call-site props so this renders
 * token-identically to both originals.
 *
 * Pair with `useReportFlow` for the target/reason/confirmation state; this
 * component only renders the modal itself.
 *
 * React Native only — no DOM elements.
 */

import React from "react";
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { colors, radii, shadows, spacing, type } from "../theme";
import { Button } from "./Button";

type Props = {
  visible: boolean;
  title: string;
  subtitle: string;
  reason: string;
  onChangeReason: (reason: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
  submitting: boolean;
};

export function ReportReasonModal({
  visible,
  title,
  subtitle,
  reason,
  onChangeReason,
  onCancel,
  onSubmit,
  submitting,
}: Props) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.modalBackdrop}>
        <View style={[styles.modalCard, shadows.raised]}>
          <Text style={styles.modalTitle}>{title}</Text>
          <Text style={styles.modalSubtitle}>{subtitle}</Text>
          <TextInput
            style={styles.modalInput}
            value={reason}
            onChangeText={onChangeReason}
            placeholder="Reason (required)"
            placeholderTextColor={colors.textMuted}
            multiline
            maxLength={500}
            autoFocus
          />
          <View style={styles.modalActions}>
            <Pressable style={styles.modalCancelButton} onPress={onCancel}>
              <Text style={styles.modalCancelText}>Cancel</Text>
            </Pressable>
            <Button
              title="Report"
              variant="danger"
              fullWidth={false}
              onPress={onSubmit}
              loading={submitting}
              disabled={reason.trim().length === 0}
              style={styles.modalSubmitButton}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
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
  // Sizing-only override — deliberately no backgroundColor here (Button's
  // `danger` variant supplies it) so the pressed-state color swap still
  // applies; a color set in this style prop would paint over it every
  // render, same bug the delete-account button had before it moved to
  // `variant="danger"` too.
  modalSubmitButton: {
    paddingVertical: spacing.sm,
    borderRadius: radii.md,
  },
});
