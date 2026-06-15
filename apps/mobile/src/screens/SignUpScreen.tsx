/**
 * SignUpScreen (AddUser) — real registration form.
 *
 * Validates with registerInput.safeParse (from @homegrown/shared) before
 * submitting. Calls trpc.auth.register.useMutation(); on success calls
 * auth.signIn() which pushes token to SecureStore and navigates to Home via
 * the AuthContext gate in App.tsx.
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
import { registerInput } from "@homegrown/shared";
import { trpc } from "../api/trpc";
import { useAuth } from "../auth/AuthContext";
import type { PreAuthStackParamList } from "../navigation/types";

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
          <Text style={styles.title}>Create Account</Text>

          {/* Email */}
          <View style={styles.fieldGroup}>
            <Text style={styles.label}>Email</Text>
            <TextInput
              style={[styles.input, fieldErrors.email ? styles.inputError : null]}
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              textContentType="emailAddress"
              placeholder="you@example.com"
              placeholderTextColor="#aaa"
            />
            {fieldErrors.email ? (
              <Text style={styles.fieldError}>{fieldErrors.email}</Text>
            ) : null}
          </View>

          {/* Username */}
          <View style={styles.fieldGroup}>
            <Text style={styles.label}>Username</Text>
            <TextInput
              style={[styles.input, fieldErrors.username ? styles.inputError : null]}
              value={username}
              onChangeText={setUsername}
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="username"
              placeholder="letters, digits, underscores"
              placeholderTextColor="#aaa"
            />
            {fieldErrors.username ? (
              <Text style={styles.fieldError}>{fieldErrors.username}</Text>
            ) : null}
          </View>

          {/* Password */}
          <View style={styles.fieldGroup}>
            <Text style={styles.label}>Password</Text>
            <TextInput
              style={[styles.input, fieldErrors.password ? styles.inputError : null]}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="newPassword"
              placeholder="At least 8 characters"
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
              <Text style={styles.buttonText}>Sign Up</Text>
            )}
          </Pressable>

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
