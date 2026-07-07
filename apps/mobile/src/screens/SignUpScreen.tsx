/**
 * SignUpScreen (AddUser) — real registration form.
 *
 * Validates with registerInput.safeParse (from @homegrown/shared) before
 * submitting. Calls trpc.auth.register.useMutation(); on success calls
 * auth.signIn() which pushes token to SecureStore and navigates to Home via
 * the AuthContext gate in App.tsx.
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
import { registerInput } from "@homegrown/shared";
import { trpc } from "../api/trpc";
import { useAuth } from "../auth/AuthContext";
import { FormField } from "../components/FormField";
import { Card } from "../components/Card";
import { Button } from "../components/Button";
import type { PreAuthStackParamList } from "../navigation/types";
import { colors, spacing, type } from "../theme";

type Props = NativeStackScreenProps<PreAuthStackParamList, "SignUp">;

export function SignUpScreen({ navigation }: Props) {
  const auth = useAuth();

  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  // Per-field inline errors (from zod or server)
  const [fieldErrors, setFieldErrors] = useState<{
    email?: string;
    username?: string;
    password?: string;
  }>({});
  const [serverError, setServerError] = useState<string | null>(null);

  const mutation = trpc.auth.register.useMutation({
    onSuccess: async (data) => {
      await auth.signIn(data.token, data.user);
      // Navigation handled by AuthContext gate in App.tsx
    },
    onError: (err) => {
      if (err.data?.code === "CONFLICT") {
        setServerError("That email or username is already taken.");
      } else {
        setServerError(err.message ?? "Something went wrong. Please try again.");
      }
    },
  });

  function handleSubmit() {
    setFieldErrors({});
    setServerError(null);

    const result = registerInput.safeParse({ email, username, password });
    if (!result.success) {
      const flat = result.error.flatten().fieldErrors;
      setFieldErrors({
        email: flat.email?.[0],
        username: flat.username?.[0],
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
          <Text style={styles.title}>{"\u{1F33F}"} Create Account</Text>

          <Card style={styles.formCard}>
            <FormField
              label="Email"
              value={email}
              onChangeText={setEmail}
              error={fieldErrors.email}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              textContentType="emailAddress"
              placeholder="you@example.com"
            />

            <FormField
              label="Username"
              value={username}
              onChangeText={setUsername}
              error={fieldErrors.username}
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="username"
              placeholder="letters, digits, underscores"
            />

            <FormField
              label="Password"
              value={password}
              onChangeText={setPassword}
              error={fieldErrors.password}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="newPassword"
              placeholder="At least 8 characters"
            />

            {/* Server error */}
            {serverError ? (
              <Text style={styles.serverError}>{serverError}</Text>
            ) : null}

            {/* Submit */}
            <Button title="Sign Up" onPress={handleSubmit} loading={mutation.isPending} />
          </Card>

          {/* Link to Log In */}
          <Pressable
            style={styles.linkRow}
            onPress={() => navigation.navigate("LogIn")}
          >
            <Text style={styles.linkText}>
              Already have an account?{" "}
              <Text style={styles.link}>Log In</Text>
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
