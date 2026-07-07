/**
 * LogInScreen — real log-in form.
 *
 * Validates with loginInput.safeParse (from @homegrown/shared) before
 * submitting. Calls trpc.auth.login.useMutation(); on success calls
 * auth.signIn() which persists the token and navigates to Home via the
 * AuthContext gate in App.tsx.
 *
 * No form library — plain useState + shared zod schema.
 * Restyled to "Garden Fresh" tokens (F-044) — warm bg, Card-wrapped form,
 * Button primitive, FormField already warm.
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
} from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { loginInput } from "@homegrown/shared";
import { trpc } from "../api/trpc";
import { useAuth } from "../auth/AuthContext";
import { FormField } from "../components/FormField";
import { Card } from "../components/Card";
import { Button } from "../components/Button";
import type { PreAuthStackParamList } from "../navigation/types";
import { colors, spacing, type } from "../theme";

type Props = NativeStackScreenProps<PreAuthStackParamList, "LogIn">;

export function LogInScreen({ navigation }: Props) {
  const auth = useAuth();

  const [usernameOrEmail, setUsernameOrEmail] = useState("");
  const [password, setPassword] = useState("");

  const [fieldErrors, setFieldErrors] = useState<{
    usernameOrEmail?: string;
    password?: string;
  }>({});
  const [serverError, setServerError] = useState<string | null>(null);

  const mutation = trpc.auth.login.useMutation({
    onSuccess: async (data) => {
      await auth.signIn(data.token, data.user);
      // Navigation handled by AuthContext gate in App.tsx
    },
    onError: (err) => {
      if (err.data?.code === "UNAUTHORIZED") {
        setServerError("Invalid credentials.");
      } else {
        setServerError(err.message ?? "Something went wrong. Please try again.");
      }
    },
  });

  function handleSubmit() {
    setFieldErrors({});
    setServerError(null);

    const result = loginInput.safeParse({ usernameOrEmail, password });
    if (!result.success) {
      const flat = result.error.flatten().fieldErrors;
      setFieldErrors({
        usernameOrEmail: flat.usernameOrEmail?.[0],
        password: flat.password?.[0],
      });
      return;
    }

    mutation.mutate(result.data);
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.container}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.title}>{"\u{1F44B}"} Log In</Text>

          <Card style={styles.formCard}>
            <FormField
              label="Username or Email"
              value={usernameOrEmail}
              onChangeText={setUsernameOrEmail}
              error={fieldErrors.usernameOrEmail}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              textContentType="username"
              placeholder="Username or email"
            />

            <FormField
              label="Password"
              value={password}
              onChangeText={setPassword}
              error={fieldErrors.password}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="password"
              placeholder="Password"
            />

            {/* Server error */}
            {serverError ? (
              <Text style={styles.serverError}>{serverError}</Text>
            ) : null}

            {/* Submit */}
            <Button title="Log In" onPress={handleSubmit} loading={mutation.isPending} />
          </Card>

          {/* Link to Sign Up */}
          <Pressable
            style={styles.linkRow}
            onPress={() => navigation.navigate("SignUp")}
          >
            <Text style={styles.linkText}>
              Don&apos;t have an account?{" "}
              <Text style={styles.link}>Sign Up</Text>
            </Text>
          </Pressable>
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
    paddingTop: spacing.xxxl,
    paddingBottom: spacing.xxxl,
  },
  title: {
    fontSize: type.title.fontSize,
    fontWeight: type.title.fontWeight,
    color: colors.primary,
    marginBottom: spacing.xxl,
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
  linkRow: {
    marginTop: spacing.lg,
    alignItems: "center",
  },
  linkText: {
    fontSize: type.body.fontSize,
    color: colors.textMuted,
  },
  link: {
    color: colors.primary,
    fontWeight: "600",
  },
});
