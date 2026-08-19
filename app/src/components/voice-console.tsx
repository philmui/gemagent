"use client";

import { useRef, useState, type KeyboardEvent } from "react";

import { tabForKey, type SideTab } from "@/lib/tab-navigation";
import { PROVIDERS } from "@/lib/types";
import { useVoiceSession } from "@/lib/use-voice-session";
import { ChatIcon, MuteIcon, SettingsIcon, SparkIcon, VolumeIcon } from "./icons";
import { ConversationPanel } from "./conversation-panel";
import { SettingsPanel } from "./settings-panel";
import { StatusPill } from "./status-pill";
import { ThemeToggle } from "./theme-toggle";
import { VoiceOrb } from "./voice-orb";

export function VoiceConsole() {
  const session = useVoiceSession();
  const [tab, setTab] = useState<SideTab>("conversation");
  const conversationTabRef = useRef<HTMLButtonElement>(null);
  const settingsTabRef = useRef<HTMLButtonElement>(null);
  const selected = PROVIDERS[session.selectedProvider];
  const activeProvider = session.active ? PROVIDERS[session.active.provider] : null;

  const focusTab = (nextTab: SideTab) => {
    setTab(nextTab);
    (nextTab === "conversation" ? conversationTabRef : settingsTabRef).current?.focus();
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const nextTab = tabForKey(tab, event.key);
    if (!nextTab) return;
    event.preventDefault();
    focusTab(nextTab);
  };

  return (
    <div className={`app-shell provider-${session.selectedProvider}`}>
      <div className="ambient ambient-one" aria-hidden="true" />
      <div className="ambient ambient-two" aria-hidden="true" />

      <header className="app-header">
        <a className="brand" href="#main" aria-label="Voice Lab home">
          <span className="brand-mark"><SparkIcon /></span>
          <span><strong>Voice Lab</strong><small>Realtime conversations</small></span>
        </a>
        <div className="header-status">
          <ThemeToggle />
          <StatusPill phase={session.phase} />
          <div className="model-badge" aria-label={session.active ? `Active model ${session.active.model}` : `Selected model ${session.health.providers[session.selectedProvider].model}`}>
            <span>{session.active ? "Active model" : "Selected model"}</span>
            <code>{session.active?.model ?? session.health.providers[session.selectedProvider].model}</code>
          </div>
        </div>
      </header>

      <main className="workspace" id="main">
        <section className="console-card" aria-label="Voice session controls">
          <VoiceOrb
            phase={session.phase}
            provider={session.selectedProvider}
            level={session.level}
            outputLevel={session.outputLevel}
            telemetryEvents={session.telemetryEvents}
            sessionEpoch={session.monitorEpoch}
            engaged={session.engaged}
            onStart={() => void session.start()}
            onStop={() => void session.stop()}
          />

          {session.error ? (
            <div className="error-banner" role="alert">
              <strong>Could not continue</strong>
              <span>{session.error}</span>
            </div>
          ) : null}

          <div className="session-controls">
            <button
              type="button"
              onClick={session.toggleMute}
              disabled={!session.engaged}
              aria-pressed={session.muted}
              className={session.muted ? "is-active" : ""}
            >
              {session.muted ? <MuteIcon /> : <VolumeIcon />}
              <span>{session.muted ? "Unmute" : "Mute"}</span>
            </button>
            <div className="route-summary">
              <span className={`route-dot${session.active ? " is-active" : ""}`} />
              <span>
                <small>{session.active ? "Connected with" : "Ready with"}</small>
                <strong>{session.active ? activeProvider?.label : selected.label}</strong>
              </span>
            </div>
          </div>
        </section>

        <aside className="side-card">
          <div className="side-tabs" role="tablist" aria-label="Voice Lab panels" aria-orientation="horizontal">
            <button
              ref={conversationTabRef}
              id="conversation-tab"
              type="button"
              role="tab"
              aria-controls="conversation-panel"
              aria-selected={tab === "conversation"}
              tabIndex={tab === "conversation" ? 0 : -1}
              className={tab === "conversation" ? "is-active" : ""}
              onClick={() => setTab("conversation")}
              onKeyDown={handleTabKeyDown}
            >
              <ChatIcon />
              Conversation
            </button>
            <button
              ref={settingsTabRef}
              id="settings-tab"
              type="button"
              role="tab"
              aria-controls="settings-panel"
              aria-selected={tab === "settings"}
              tabIndex={tab === "settings" ? 0 : -1}
              className={tab === "settings" ? "is-active" : ""}
              onClick={() => setTab("settings")}
              onKeyDown={handleTabKeyDown}
            >
              <SettingsIcon />
              Settings
            </button>
          </div>
          <div className="side-content">
            <div
              className="tab-panel"
              id="conversation-panel"
              role="tabpanel"
              aria-labelledby="conversation-tab"
              hidden={tab !== "conversation"}
            >
              <ConversationPanel
                items={session.transcript}
                active={tab === "conversation"}
                onClear={session.clearTranscript}
              />
            </div>
            <div
              className="tab-panel"
              id="settings-panel"
              role="tabpanel"
              aria-labelledby="settings-tab"
              hidden={tab !== "settings"}
            >
              <SettingsPanel
                selectedProvider={session.selectedProvider}
                selectedVoice={session.selectedVoice}
                advancedSettings={session.advancedSettings}
                active={session.active}
                health={session.health}
                engaged={session.engaged}
                onProviderChange={session.selectProvider}
                onVoiceChange={session.selectVoice}
                onAdvancedSettingsChange={session.updateAdvancedSettings}
              />
            </div>
          </div>
        </aside>
      </main>

      <footer className="app-footer">
        <span><SparkIcon /> Built for low-latency speech</span>
        <span>Long-lived provider credentials stay on the backend · Provider-isolated agent runtimes · No automatic provider fallback</span>
      </footer>
    </div>
  );
}
