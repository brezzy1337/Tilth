/**
 * RestoreVerifyScreen — email-code confirmation for restoring a soft-deleted
 * account (F-054).
 *
 * Reached only when `auth.login` throws the `RESTORE_VERIFICATION_REQUIRED`
 * challenge (see LogInScreen's onError handler) — that same login attempt
 * already triggered the server to email a fresh code, so this screen must
 * NOT call `requestRestoreCode` on mount (it would immediately hit the
 * `RESTORE_CODE_RESEND_COOLDOWN_SECONDS` cooldown and error). The resend
 * countdown instead starts pre-elapsed, as if a send just happened.
 *
 * Success calls the SAME `auth.signIn` AuthContext currently uses everywhere
 * else (LogInScreen/SignUpScreen) — `auth.verifyRestore` returns the same
 * `AuthResponse` shape as `auth.login`. Once `AuthContext` flips to
 * "signedIn", App.tsx's RootNavigator swaps the entire pre-auth stack
 * (Hero/LogIn/SignUp/RestoreVerify) out for the authed stack, so this screen
 * unmounts on success without needing an explicit navigation.reset — the
 * same reliance every other pre-auth screen already has on that gate.
 *
 * No form library — plain useState + shared constants, same convention as
 * LogInScreen/SignUpScreen.
 * React Native only — no DOM elements.
 */

import React, { useEffect, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
} from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { RESTORE_CODE_LENGTH, RESTORE_CODE_RESEND_COOLDOWN_SECONDS } from "@homegrown/shared";
import { trpc } from "../api/trpc";
import { useAuth } from "../auth/AuthContext";
import { FormField } from "../components/FormField";
import { Card } from "../components/Card";
import { Button } from "../components/Button";
import type { PreAuthStackParamList } from "../navigation/types";
import { colors, spacing, type } from "../theme";

type Props = NativeStackScreenProps<PreAuthStackParamList, "RestoreVerify">;

export function RestoreVerifyScreen({ route }: Props) {
  const { usernameOrEmail, password } = route.params;
  const auth = useAuth();

  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | undefined>(undefined);
  const [serverError, setServerError] = useState<string | null>(null);
  const [resendNotice, setResendNotice] = useState<string | null>(null);

  // A code was already emailed by the login attempt that threw the
  // RESTORE_VERIFICATION_REQUIRED challenge — start the countdown as if a
  // send just happened rather than calling requestRestoreCode on mount.
  const [secondsRemaining, setSecondsRemaining] = useState(RESTORE_CODE_RESEND_COOLDOWN_SECONDS);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    intervalRef.current = setInterval(() => {
      setSecondsRemaining((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const verifyMutation = trpc.auth.verifyRestore.useMutation({
    onSuccess: async (data) => {
      await auth.signIn(data.token, data.user);
      // Navigation handled by AuthContext gate in App.tsx
    },
    onError: (err) => {
      if (err.data?.code === "UNAUTHORIZED") {
        setServerError("That code didn't work — check it or request a new one");
      } else if (err.data?.code === "TOO_MANY_REQUESTS") {
        setServerError("Please wait before requesting another code");
      } else {
        setServerError(err.message ?? "Something went wrong. Please try again.");
      }
    },
  });

  const resendMutation = trpc.auth.requestRestoreCode.useMutation({
    onSuccess: (data) => {
      setResendNotice(`Code sent to ${data.maskedEmail}`);
      setServerError(null);
      setCode("");
      setSecondsRemaining(RESTORE_CODE_RESEND_COOLDOWN_SECONDS);
    },
    onError: (err) => {
      setResendNotice(null);
      if (err.data?.code === "TOO_MANY_REQUESTS") {
        setServerError("Please wait before requesting another code");
      } else {
        setServerError(err.message ?? "Something went wrong. Please try again.");
      }
    },
  });

  function handleSubmit() {
    setCodeError(undefined);
    setServerError(null);

    if (code.length !== RESTORE_CODE_LENGTH) {
      setCodeError(`Enter the ${RESTORE_CODE_LENGTH}-digit code`);
      return;
    }

    verifyMutation.mutate({ usernameOrEmail, password, code });
  }

  function handleResend() {
    if (secondsRemaining > 0 || resendMutation.isPending) return;
    setServerError(null);
    setResendNotice(null);
    resendMutation.mutate({ usernameOrEmail, password });
  }

  const resendLabel = secondsRemaining > 0 ? `Resend code in ${secondsRemaining}s` : "Resend code";

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
          <Text style={styles.title}>{"\u{1F331}"} Welcome back!</Text>
          <Text style={styles.subtitle}>
            {`This account was scheduled for deletion. To restore it, enter the ${RESTORE_CODE_LENGTH}-digit code we emailed you.`}
          </Text>

          <Card style={styles.formCard}>
            <FormField
              label="Verification code"
              value={code}
              onChangeText={(text) =>
                setCode(text.replace(/[^0-9]/g, "").slice(0, RESTORE_CODE_LENGTH))
              }
              error={codeError}
              keyboardType="number-pad"
              maxLength={RESTORE_CODE_LENGTH}
              autoCorrect={false}
              textContentType="oneTimeCode"
              placeholder={"0".repeat(RESTORE_CODE_LENGTH)}
              style={styles.codeInput}
            />

            {resendNotice ? <Text style={styles.resendNotice}>{resendNotice}</Text> : null}
            {serverError ? <Text style={styles.serverError}>{serverError}</Text> : null}

            <Button
              title="Restore my account"
              onPress={handleSubmit}
              loading={verifyMutation.isPending}
            />
          </Card>

          <Button
            title={resendLabel}
            variant="ghost"
            fullWidth={false}
            disabled={secondsRemaining > 0 || resendMutation.isPending}
            loading={resendMutation.isPending}
            onPress={handleResend}
          />
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
    marginBottom: spacing.md,
  },
  subtitle: {
    fontSize: type.body.fontSize,
    color: colors.textMuted,
    marginBottom: spacing.xxl,
  },
  formCard: {
    marginBottom: spacing.md,
  },
  codeInput: {
    textAlign: "center",
    letterSpacing: 8,
    fontSize: type.title.fontSize,
    fontWeight: type.title.fontWeight,
  },
  resendNotice: {
    marginBottom: spacing.md,
    fontSize: type.caption.fontSize,
    color: colors.secondary,
    textAlign: "center",
  },
  serverError: {
    marginBottom: spacing.md,
    fontSize: type.caption.fontSize,
    color: colors.danger,
    textAlign: "center",
  },
});
