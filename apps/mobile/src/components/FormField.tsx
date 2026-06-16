/**
 * FormField — reusable label + TextInput + inline error component.
 *
 * Used by M3 forms (YourStandScreen) to avoid duplicating field markup.
 * Keeps the same visual style as M2 auth screens (#2d6a4f-on-white).
 *
 * React Native only — no DOM elements.
 */

import React from "react";
import { StyleSheet, Text, TextInput, View, type TextInputProps } from "react-native";

interface FormFieldProps extends TextInputProps {
  label: string;
  error?: string;
}

export function FormField({ label, error, style, ...inputProps }: FormFieldProps) {
  return (
    <View style={styles.fieldGroup}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        style={[styles.input, error ? styles.inputError : null, style]}
        placeholderTextColor="#aaa"
        {...inputProps}
      />
      {error ? <Text style={styles.fieldError}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fieldGroup: {
    marginBottom: 16,
  },
  label: {
    fontSize: 13,
    fontWeight: "600",
    color: "#444",
    marginBottom: 6,
  },
  input: {
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 14,
    fontSize: 15,
    color: "#222",
    backgroundColor: "#fafafa",
  },
  inputError: {
    borderColor: "#c0392b",
  },
  fieldError: {
    marginTop: 4,
    fontSize: 12,
    color: "#c0392b",
  },
});
