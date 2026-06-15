/**
 * LogInScreen — real log-in form.
 *
 * Validates with loginInput.safeParse (from @homegrown/shared) before
 * submitting. Calls trpc.auth.login.useMutation(); on success calls
 * auth.signIn() which persists the token and navigates to Home via the
 * AuthContext gate in App.tsx.
 *
 * No form library — plain useState + shared zod schema.
 * React Native only — no DOM elements.
 */

import React, { useState } from "react";
import {
  ActivityIndicator,
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
import { loginInput } from "@homegrown/shared";
import { trpc } from "../api/trpc";
import { useAuth } from "../auth/AuthContext";
import type { PreAuthStackParamList } from "../navigation/types";

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
          <Text style={styles.title}>Log In</Text>

          {/* Username or Email */}
          <View style={styles.fieldGroup}>
            <Text style={styles.label}>Username or Email</Text>
            <TextInput
              style={[
                styles.input,
                fieldErrors.usernameOrEmail ? styles.inputError : null,
              ]}
              value={usernameOrEmail}
              onChangeText={setUsernameOrEmail}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              textContentType="username"
              placeholder="Username or email"
              placeholderTextColor="#aaa"
            />
            {fieldErrors.usernameOrEmail ? (
              <Text style={styles.fieldError}>{fieldErrors.usernameOrEmail}</Text>
            ) : null}
          </View>

          {/* Password */}
          <View style={styles.fieldGroup}>
            <Text style={styles.label}>Password</Text>
            <TextInput
              style={[
                styles.input,
                fieldErrors.password ? styles.inputError : null,
              ]}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="password"
              placeholder="Password"
              placeholderTextColor="#aaa"
            />
            {fieldErrors.password ? (
              <Text style={styles.fieldError}>{fieldErrors.password}</Text>
            ) : null}
          </View>

          {/* Server error */}
          {serverError ? (
            <Text style={styles.serverError}>{serverError}</Text>
          ) : null}

          {/* Submit */}
          <Pressable
            style={[styles.button, mutation.isPending ? styles.buttonDisabled : null]}
            onPress={handleSubmit}
            disabled={mutation.isPending}
          >
            {mutation.isPending ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text style={styles.buttonText}>Log In</Text>
            )}
          </Pressable>

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
    backgroundColor: "#fff",
  },
  container: {
    flexGrow: 1,
    paddingHorizontal: 24,
    paddingTop: 32,
    paddingBottom: 40,
  },
  title: {
    fontSize: 28,
    fontWeight: "bold",
    color: "#2d6a4f",
    marginBottom: 28,
  },
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
  serverError: {
    marginBottom: 12,
    fontSize: 13,
    color: "#c0392b",
    textAlign: "center",
  },
  button: {
    backgroundColor: "#2d6a4f",
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: "center",
    marginTop: 8,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  linkRow: {
    marginTop: 20,
    alignItems: "center",
  },
  linkText: {
    fontSize: 14,
    color: "#555",
  },
  link: {
    color: "#2d6a4f",
    fontWeight: "600",
  },
});
