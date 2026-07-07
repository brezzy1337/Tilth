/**
 * FormField — reusable label + TextInput + inline error component.
 *
 * Used by M3 forms (YourStandScreen) to avoid duplicating field markup.
 * Restyled to "Harvest Warm" tokens (F-044) — warm borders, radius md, focus
 * border terracotta. Props API is unchanged so every other screen that
 * already uses FormField inherits the warmer look for free.
 *
 * React Native only — no DOM elements.
 */

import React, { useState } from "react";
import { StyleSheet, Text, TextInput, View, type TextInputProps } from "react-native";
import { colors, radii, spacing, type } from "../theme";

interface FormFieldProps extends TextInputProps {
  label: string;
  error?: string;
}

export function FormField({ label, error, style, onFocus, onBlur, ...inputProps }: FormFieldProps) {
  const [isFocused, setIsFocused] = useState(false);

  return (
    <View style={styles.fieldGroup}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        style={[
          styles.input,
          isFocused ? styles.inputFocused : null,
          error ? styles.inputError : null,
          style,
        ]}
        placeholderTextColor={colors.textMuted}
        onFocus={(e) => {
          setIsFocused(true);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          setIsFocused(false);
          onBlur?.(e);
        }}
        {...inputProps}
      />
      {error ? <Text style={styles.fieldError}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fieldGroup: {
    marginBottom: spacing.lg,
  },
  label: {
    fontSize: type.label.fontSize,
    fontWeight: type.label.fontWeight,
    color: colors.text,
    marginBottom: spacing.sm,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    fontSize: type.body.fontSize,
    color: colors.text,
    backgroundColor: colors.surface,
  },
  inputFocused: {
    borderColor: colors.primary,
  },
  inputError: {
    borderColor: colors.danger,
  },
  fieldError: {
    marginTop: spacing.xs,
    fontSize: 12,
    color: colors.danger,
  },
});
