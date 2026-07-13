/**
 * ChangePasswordScreen — Settings > Account > Change password (F-051).
 *
 * Client-side validates the new password with `passwordSchema` (min 8 chars,
 * same rule as registration) and that the confirmation matches, before
 * calling `auth.changePassword`. The server's UNAUTHORIZED on a wrong
 * `currentPassword` is intentionally generic (mirrors `auth.login`'s
 * posture) — surfaced here as an inline error on the Current password field.
 *
 * No form library — useState + shared zod schema, same convention as
 * SignUpScreen/YourStandScreen's forms.
 * React Native only — no DOM elements.
 */

import React, { useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
} from "react-native";
import { useNavigation } from "@react-navigation/native";
import { passwordSchema } from "@homegrown/shared";
import { trpc } from "../api/trpc";
import { Card } from "../components/Card";
import { Button } from "../components/Button";
import { FormField } from "../components/FormField";
import { colors, spacing, type } from "../theme";

export function ChangePasswordScreen() {
  const navigation = useNavigation();

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const [fieldErrors, setFieldErrors] = useState<{
    currentPassword?: string;
    newPassword?: string;
    confirmPassword?: string;
  }>({});
  const [serverError, setServerError] = useState<string | null>(null);

  const mutation = trpc.auth.changePassword.useMutation({
    onSuccess: () => {
      Alert.alert("Password changed", "Your password has been updated.", [
        { text: "OK", onPress: () => navigation.goBack() },
      ]);
    },
    onError: (err) => {
      if (err.data?.code === "UNAUTHORIZED") {
        setFieldErrors({ currentPassword: "Current password is incorrect" });
      } else {
        setServerError(err.message ?? "Something went wrong. Please try again.");
      }
    },
  });

  function handleSubmit() {
    setFieldErrors({});
    setServerError(null);

    const nextErrors: typeof fieldErrors = {};

    const currentResult = passwordSchema.safeParse(currentPassword);
    if (!currentResult.success) {
      nextErrors.currentPassword = "Enter your current password";
    }

    const newResult = passwordSchema.safeParse(newPassword);
    if (!newResult.success) {
      nextErrors.newPassword =
        newResult.error.flatten().formErrors[0] ?? "Must be at least 8 characters";
    } else if (newPassword !== confirmPassword) {
      nextErrors.confirmPassword = "Passwords don't match";
    }

    if (Object.keys(nextErrors).length > 0) {
      setFieldErrors(nextErrors);
      return;
    }

    mutation.mutate({ currentPassword, newPassword });
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
          <Card style={styles.formCard}>
            <FormField
              label="Current password"
              value={currentPassword}
              onChangeText={setCurrentPassword}
              error={fieldErrors.currentPassword}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="password"
              placeholder="Your current password"
            />
            <FormField
              label="New password"
              value={newPassword}
              onChangeText={setNewPassword}
              error={fieldErrors.newPassword}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="newPassword"
              placeholder="At least 8 characters"
            />
            <FormField
              label="Confirm new password"
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              error={fieldErrors.confirmPassword}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="newPassword"
              placeholder="Re-enter your new password"
            />

            {serverError ? <Text style={styles.serverError}>{serverError}</Text> : null}

            <Button title="Update password" onPress={handleSubmit} loading={mutation.isPending} />
          </Card>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  container: {
    flexGrow: 1,
    paddingHorizontal: spacing.xxl,
    paddingTop: spacing.xxl,
    paddingBottom: spacing.xxxl,
  },
  formCard: {
    marginBottom: spacing.md,
  },
  serverError: {
    marginBottom: spacing.md,
    fontSize: type.caption.fontSize,
    color: colors.danger,
    textAlign: "center",
  },
});
