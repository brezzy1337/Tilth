/**
 * DeleteAccountScreen — Settings > Danger zone > Delete account (F-051).
 *
 * Soft-delete with a 30-day grace period (server: `auth.deleteAccount`) —
 * logging back in within the grace window self-restores the account
 * (`auth.login`'s doc comment). Copy here explains that explicitly so a
 * deletion doesn't read as instant/irreversible when it isn't (yet).
 *
 * No extra confirmation Alert on top of the form: the password field is
 * itself the deliberate-action gate, and the submit button's copy ("Delete
 * my account") is unambiguous — matches the product-scope note that a typed
 * password alone is an acceptable confirm step here.
 *
 * On success, the account is already deleted server-side — this screen only
 * needs to clear LOCAL session state, so it reuses the exact same path
 * `useAuth().signOut()` takes (clear token, clear user, clear query cache),
 * landing the user back on Hero/login. It does NOT call signOut() as an API
 * action — deleteAccount already did the server-side work.
 *
 * React Native only — no DOM elements.
 */

import React, { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
} from "react-native";
import { trpc } from "../api/trpc";
import { useAuth } from "../auth/AuthContext";
import { Card } from "../components/Card";
import { Button } from "../components/Button";
import { FormField } from "../components/FormField";
import { colors, radii, spacing, type } from "../theme";

export function DeleteAccountScreen() {
  const { signOut } = useAuth();

  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const mutation = trpc.auth.deleteAccount.useMutation({
    onSuccess: async () => {
      // Deletion already happened server-side — clear LOCAL session state
      // the same way sign-out does, no further API call needed.
      await signOut();
    },
    onError: (err) => {
      if (err.data?.code === "UNAUTHORIZED") {
        setError("Incorrect password.");
      } else {
        // BAD_REQUEST (orders in flight) and anything else — surface the
        // server's own message, it's already written for the user.
        setError(err.message ?? "Something went wrong. Please try again.");
      }
    },
  });

  function handleSubmit() {
    setError(null);
    mutation.mutate({ password });
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
          <Card style={styles.warningCard} variant="tint">
            <Text style={styles.warningTitle}>{"⚠️"} This deactivates your account</Text>
            <Text style={styles.warningBody}>
              Your profile, stand, and listings will be hidden right away, and you won't be able to
              receive new messages or sourcing requests.{"\n\n"}
              Your account and data are kept for 30 days. If you sign back in during that window,
              your account is automatically restored — nothing is lost. After 30 days, deletion is
              permanent.
            </Text>
          </Card>

          <Card style={styles.formCard}>
            <FormField
              label="Confirm your password"
              value={password}
              onChangeText={setPassword}
              error={error ?? undefined}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="password"
              placeholder="Your current password"
            />

            <Button
              title="Delete my account"
              onPress={handleSubmit}
              loading={mutation.isPending}
              disabled={password.length === 0}
              style={styles.deleteButton}
            />
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
  warningCard: {
    marginBottom: spacing.lg,
    borderWidth: 1,
    borderColor: colors.popSoft,
  },
  warningTitle: {
    fontSize: type.section.fontSize,
    fontWeight: type.section.fontWeight,
    color: colors.text,
    marginBottom: spacing.sm,
  },
  warningBody: {
    fontSize: type.body.fontSize,
    color: colors.textMuted,
    lineHeight: 21,
  },
  formCard: {
    marginBottom: spacing.md,
  },
  deleteButton: {
    backgroundColor: colors.danger,
    borderRadius: radii.md,
  },
});
