import { Link } from "react-router";
import { PermissionsPanel } from "../PermissionsPanel.js";
import { HotkeySettings } from "./HotkeySettings.js";
import { DictationSettings } from "./DictationSettings.js";
import { trpc } from "../../trpc.js";
import { InlineEditRow } from "../InlineEditRow.js";
import { useUndoToast } from "../UndoToast.js";
import { useConfigField } from "../../hooks/useConfigField.js";
import { useT } from "../../i18n/LanguageProvider.js";
import type { SettingsRestartTracker } from "../../hooks/useSettingsRestartTracker.js";

export interface VoiceInputSectionProps {
  tracker: SettingsRestartTracker;
}

export function VoiceInputSection({ tracker }: VoiceInputSectionProps) {
  const { data: cfg } = trpc.config.get.useQuery();
  const { data: daemons } = trpc.daemons.health.useQuery(undefined, { refetchInterval: 5_000 });
  const { commit, isBlocked } = useConfigField(tracker);
  const t = useT();
  const { showError } = useUndoToast();
  const previewSound = trpc.recording.previewSound.useMutation({
    onError: (error: unknown) => showError(t("settings.voice.previewFailed", {
      error: error instanceof Error ? error.message : String(error),
    })),
  });
  if (!cfg) return null;

  const dictation = cfg.transcription.dictation ?? {};
  const statusAgent = daemons?.find((daemon) => daemon.name === "com.yulu.statusagent");
  const agentRunning = statusAgent?.status === "running" || statusAgent?.status === "idle";
  const agentEnabled = cfg.status_agent.enabled ?? false;
  const agentHelp = !statusAgent
    ? t("settings.voice.statusAgent.checking")
    : agentEnabled && agentRunning
      ? t("settings.voice.statusAgent.running")
      : agentEnabled
        ? t("settings.voice.statusAgent.enabledStopped")
        : agentRunning
          ? t("settings.voice.statusAgent.disabledRunning")
          : t("settings.voice.statusAgent.stopped");

  return (
    <section id="voice-input" className="settings-section">
      <PermissionsPanel />
      <h2 className="settings-section-h">{t("settings.voice.heading")}</h2>
      <p className="settings-section-sub">{t("settings.voice.sub")}</p>

      <InlineEditRow
        label={t("settings.voice.enabled")}
        help={agentHelp}
        type="toggle"
        value={agentEnabled}
        onCommit={commit("status_agent.enabled")}
        disabled={isBlocked("status_agent.enabled")}
        status={tracker.statusFor("status_agent.enabled")}
      />

      {statusAgent && agentEnabled !== agentRunning && <Link className="settings-text-link" to="/settings/general#capabilities">{t("settings.voice.checkService")}</Link>}
      <InlineEditRow label={t("settings.voice.inputMode")} help={t("settings.voice.inputModeHelp")}
        type="select" value={cfg.status_agent.voice_input_mode ?? "toggle"}
        options={[{ value: "toggle", label: t("settings.voice.modeToggle") }, { value: "hold", label: t("settings.voice.modeHold") }]}
        onCommit={commit("status_agent.voice_input_mode") as (value: string) => void}
        disabled={isBlocked("status_agent.voice_input_mode")} status={tracker.statusFor("status_agent.voice_input_mode")} />
      <InlineEditRow label={t("settings.voice.askScope")} help={t("settings.voice.askScopeHelp")}
        type="select" value={dictation.voice_chat_scope ?? "general"}
        options={[{ value: "general", label: t("assistant.scopeGeneral") }, { value: "meetings", label: t("assistant.scopeMeetings") }]}
        onCommit={commit("transcription.dictation.voice_chat_scope") as (value: string) => void} />
      <div className="voice-feedback">
      <InlineEditRow
        label={t("settings.voice.feedbackSounds")}
        help={t("settings.voice.feedbackSoundsHelp")}
        type="toggle"
        value={cfg.status_agent.feedback_sounds ?? true}
        onCommit={commit("status_agent.feedback_sounds")}
        status={tracker.statusFor("status_agent.feedback_sounds")}
      />
          <button
            type="button"
            className="path-btn"
            disabled={!(cfg.status_agent.feedback_sounds ?? true) || !agentRunning || previewSound.isPending}
            onClick={() => previewSound.mutate()}
          >
            {t("settings.voice.preview")}
          </button>
      </div>

      <HotkeySettings hotkeys={cfg.status_agent.hotkeys}
        disabled={isBlocked("status_agent.hotkeys")}
        onCommit={(path, value) => commit(path)(value)} />

      <InlineEditRow
        label={t("settings.voice.targetLanguage")}
        type="text"
        value={dictation.target_language ?? "English"}
        onCommit={commit("transcription.dictation.target_language") as (v: string) => void}
      />

      <div className="row">
        <div className="row-label">{t("settings.voice.glossary")}</div>
        <div className="row-value"><Link to="/knowledge/glossary">{t("settings.voice.openGlossary")}</Link></div>
        <div className="row-status" />
      </div>
      <DictationSettings preferences={dictation}
        available={cfg.transcription.engine === "xai" && cfg.intelligence?.conversation?.provider === "xai"}
        onCommit={(path, value) => commit(path)(value)} />
    </section>
  );
}
