import type { ThreadMessageEditResolution } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from "react-native";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";

type ProviderForkMode = "turn-granular" | "full-copy" | "none";

const RESOLUTIONS = [
  {
    kind: "fork" as const,
    title: "Fork",
    detail: "Start a separate thread and worktree from this point.",
  },
  {
    kind: "rewind" as const,
    title: "Rewind here",
    detail: "Archive the later work, restore this point, then send the edit.",
  },
  {
    kind: "continue" as const,
    title: "Continue here",
    detail: "Keep the current files and visible history, then send the edit.",
  },
];

export function EditMessageModal(props: {
  readonly visible: boolean;
  readonly initialText: string;
  readonly providerForkMode: ProviderForkMode;
  readonly threadBusy: boolean;
  readonly submitting: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: (input: {
    readonly text: string;
    readonly resolution: ThreadMessageEditResolution;
  }) => void;
}) {
  const [text, setText] = useState(props.initialText);
  const [kind, setKind] = useState<"fork" | "rewind" | "continue">("fork");
  const [contextMode, setContextMode] = useState<"reset" | "correction">(
    props.providerForkMode === "turn-granular" ? "reset" : "correction",
  );

  useEffect(() => {
    if (!props.visible) return;
    setText(props.initialText);
    setKind(props.providerForkMode === "none" ? "continue" : "fork");
    setContextMode(props.providerForkMode === "turn-granular" ? "reset" : "correction");
  }, [props.initialText, props.providerForkMode, props.visible]);

  const resolutionDisabled = (candidate: "fork" | "rewind" | "continue") =>
    (candidate === "fork" && props.providerForkMode === "none") ||
    (candidate === "rewind" && (props.threadBusy || props.providerForkMode !== "turn-granular")) ||
    (candidate === "continue" && props.threadBusy);

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || resolutionDisabled(kind)) return;
    props.onSubmit({
      text: trimmed,
      resolution: kind === "continue" ? { kind, contextMode } : { kind },
    });
  };

  return (
    <Modal
      visible={props.visible}
      transparent
      animationType="fade"
      presentationStyle="overFullScreen"
      onRequestClose={props.onCancel}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        className="flex-1 justify-end bg-black/45"
      >
        <Pressable className="absolute inset-0" onPress={props.onCancel} />
        <View className="max-h-[88%] rounded-t-[28px] bg-screen px-5 pb-8 pt-5">
          <View className="mb-4">
            <Text className="text-xl font-t3-bold text-foreground">Edit message</Text>
            <Text className="mt-1 text-sm text-foreground-muted">
              The edited text is sent automatically after the selected resolution is ready.
            </Text>
          </View>

          <ScrollView keyboardShouldPersistTaps="handled">
            <TextInput
              multiline
              autoFocus
              value={text}
              onChangeText={setText}
              editable={!props.submitting}
              accessibilityLabel="Edited message"
              className="min-h-28 rounded-2xl border border-border bg-subtle px-4 py-3 text-base text-foreground"
              placeholderTextColor="#888"
              textAlignVertical="top"
            />

            <View className="mt-4 gap-2">
              {RESOLUTIONS.map((option) => {
                const disabled = resolutionDisabled(option.kind);
                const selected = kind === option.kind;
                return (
                  <Pressable
                    key={option.kind}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: selected, disabled }}
                    disabled={disabled || props.submitting}
                    onPress={() => setKind(option.kind)}
                    className={cn(
                      "rounded-2xl border px-4 py-3",
                      selected ? "border-blue-500 bg-blue-500/10" : "border-border bg-subtle",
                      disabled && "opacity-40",
                    )}
                  >
                    <Text className="font-t3-semibold text-foreground">{option.title}</Text>
                    <Text className="mt-0.5 text-sm text-foreground-muted">{option.detail}</Text>
                  </Pressable>
                );
              })}
            </View>

            {kind === "continue" ? (
              <View className="mt-3 flex-row gap-2">
                {(["reset", "correction"] as const).map((mode) => {
                  const disabled = mode === "reset" && props.providerForkMode !== "turn-granular";
                  return (
                    <Pressable
                      key={mode}
                      disabled={disabled || props.submitting}
                      onPress={() => setContextMode(mode)}
                      className={cn(
                        "flex-1 rounded-xl border px-3 py-2.5",
                        contextMode === mode ? "border-blue-500 bg-blue-500/10" : "border-border",
                        disabled && "opacity-40",
                      )}
                    >
                      <Text className="text-center text-sm font-t3-medium text-foreground">
                        {mode === "reset" ? "Reset context" : "Send correction"}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            ) : null}
          </ScrollView>

          <View className="mt-5 flex-row justify-end gap-3">
            <Pressable
              disabled={props.submitting}
              onPress={props.onCancel}
              className="rounded-xl px-4 py-3"
            >
              <Text className="font-t3-medium text-foreground-muted">Cancel</Text>
            </Pressable>
            <Pressable
              disabled={props.submitting || text.trim().length === 0 || resolutionDisabled(kind)}
              onPress={submit}
              className="rounded-xl bg-blue-600 px-5 py-3 disabled:opacity-40"
            >
              <Text className="font-t3-semibold text-white">
                {props.submitting ? "Editing…" : "Edit and send"}
              </Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
