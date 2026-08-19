import {
  PROVIDERS,
  VOICES,
  type BackendHealth,
  type AdvancedVoiceSettings,
  type Provider,
  type VerifiedSessionInfo,
} from "@/lib/types";
import { CheckIcon, OrbitIcon, SparkIcon } from "./icons";

interface SettingsPanelProps {
  selectedProvider: Provider;
  selectedVoice: string;
  active: (VerifiedSessionInfo & { epoch: number }) | null;
  health: BackendHealth;
  engaged: boolean;
  advancedSettings: AdvancedVoiceSettings;
  onProviderChange: (provider: Provider) => void;
  onVoiceChange: (voice: string) => void;
  onAdvancedSettingsChange: (settings: Partial<AdvancedVoiceSettings>) => void;
}

function ProviderGlyph({ provider }: { provider: Provider }) {
  return provider === "gemini" ? <SparkIcon /> : <OrbitIcon />;
}

export function SettingsPanel({
  selectedProvider,
  selectedVoice,
  active,
  health,
  engaged,
  advancedSettings,
  onProviderChange,
  onVoiceChange,
  onAdvancedSettingsChange,
}: SettingsPanelProps) {
  return (
    <section className="settings-section" aria-label="Voice settings">
      <div className="settings-heading">
        <p className="panel-kicker">Voice engine</p>
        <h2>Choose who powers the conversation</h2>
        <p>
          {engaged
            ? "Selecting another provider switches now and starts a fresh session."
            : "Your choice will be used the next time you start."}
        </p>
      </div>

      <details className="advanced-settings">
        <summary>
          <span>
            <p className="panel-kicker">Fine tune</p>
            <strong>Advanced voice controls</strong>
            <small>{engaged ? "Changes restart this conversation" : "Applied when you start a conversation"}</small>
          </span>
          <span className="advanced-summary-value">{advancedSettings.tone} · {advancedSettings.stability}%</span>
        </summary>
        <div className="advanced-settings-body">
          <label className="range-setting">
            <span><strong>Voice stability</strong><output>{advancedSettings.stability}%</output></span>
            <input type="range" min="0" max="100" step="5" value={advancedSettings.stability} onChange={(event) => onAdvancedSettingsChange({ stability: Number(event.target.value) })} />
            <small>Lower is more expressive; higher keeps delivery more consistent.</small>
          </label>

          <fieldset className="advanced-fieldset">
            <legend>Conversation tone</legend>
            <div className="segmented-options">
              {(["warm", "balanced", "bright"] as const).map((tone) => <label key={tone}><input type="radio" name="voice-tone" checked={advancedSettings.tone === tone} onChange={() => onAdvancedSettingsChange({ tone })} /><span>{tone}</span></label>)}
            </div>
          </fieldset>

          <div className="advanced-select-grid">
            <label>Speaking pace<select value={advancedSettings.pace} onChange={(event) => onAdvancedSettingsChange({ pace: event.target.value as AdvancedVoiceSettings["pace"] })}><option value="relaxed">Relaxed</option><option value="natural">Natural</option><option value="brisk">Brisk</option></select></label>
            <label>Background sound<select value={advancedSettings.backgroundSound} onChange={(event) => onAdvancedSettingsChange({ backgroundSound: event.target.value as AdvancedVoiceSettings["backgroundSound"] })}><option value="none">None</option><option value="rain">Gentle rain</option><option value="ocean">Ocean waves</option><option value="fireplace">Fireplace</option></select></label>
          </div>

          <label className="toggle-setting"><input type="checkbox" checked={advancedSettings.noiseSuppression} onChange={(event) => onAdvancedSettingsChange({ noiseSuppression: event.target.checked })} /><span><strong>Background noise reduction</strong><small>Reduce room noise picked up by your microphone.</small></span></label>
          <label className="toggle-setting"><input type="checkbox" checked={advancedSettings.echoCancellation} onChange={(event) => onAdvancedSettingsChange({ echoCancellation: event.target.checked })} /><span><strong>Echo cancellation</strong><small>Reduce speaker feedback picked up by your microphone.</small></span></label>
        </div>
      </details>

      <fieldset className="choice-fieldset">
        <legend className="visually-hidden">Voice provider</legend>
        <div className="provider-options">
          {(["gemini", "openai"] as const).map((provider) => {
            const option = PROVIDERS[provider];
            const availability = health.providers[provider];
            const selected = selectedProvider === provider;
            const isActive = active?.provider === provider;
            return (
              <label
                className={`provider-option provider-${provider}${selected ? " is-selected" : ""}${!availability.configured ? " is-disabled" : ""}`}
                key={provider}
              >
                <input
                  className="choice-input"
                  type="radio"
                  name="voice-provider"
                  value={provider}
                  checked={selected}
                  disabled={!availability.configured}
                  onChange={() => onProviderChange(provider)}
                />
                <span className="provider-glyph"><ProviderGlyph provider={provider} /></span>
                <span className="provider-copy">
                  <span className="provider-name-row">
                    <strong>{option.label}</strong>
                    {isActive ? <span className="active-tag">Active</span> : null}
                  </span>
                  <span>{option.description}</span>
                  <code>{availability.model}</code>
                  <small>{availability.runtime === "google-adk" ? "Google ADK" : "OpenAI Agents SDK"}</small>
                  {!availability.configured ? <em>Backend credentials missing</em> : null}
                </span>
                <span className="radio-check" aria-hidden="true">
                  {selected ? <CheckIcon /> : null}
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <div className="setting-group">
        <div className="setting-label-row">
          <div>
            <p className="panel-kicker">Voice</p>
            <h3>Pick a sound</h3>
          </div>
          <span>{PROVIDERS[selectedProvider].company}</span>
        </div>
        <fieldset className="choice-fieldset">
          <legend className="visually-hidden">{PROVIDERS[selectedProvider].label} voice</legend>
          <div className="voice-options">
            {VOICES[selectedProvider].map((voice) => (
              <label
                className={`voice-option${selectedVoice === voice.id ? " is-selected" : ""}`}
                key={voice.id}
              >
                <input
                  className="choice-input"
                  type="radio"
                  name={`${selectedProvider}-voice`}
                  value={voice.id}
                  checked={selectedVoice === voice.id}
                  onChange={() => onVoiceChange(voice.id)}
                />
                <span className="voice-preview" aria-hidden="true">
                  <i /><i /><i /><i />
                </span>
                <span><strong>{voice.label}</strong><small>{voice.tone}</small></span>
                {selectedVoice === voice.id ? <CheckIcon aria-hidden="true" /> : null}
              </label>
            ))}
          </div>
        </fieldset>
      </div>

      <div className="active-model-card">
        <span className={`model-indicator${active ? " is-active" : ""}`} aria-hidden="true" />
        <div>
          <p>{active ? "Active model" : "Selected model"}</p>
          <code>{active?.model ?? health.providers[selectedProvider].model}</code>
        </div>
        <span>
          {active
            ? `${active.agentRuntime === "google-adk" ? "Google ADK" : "OpenAI Agents SDK"} · ${active.transport.toUpperCase()}`
            : "Not connected"}
        </span>
      </div>

      <p className="privacy-note">
        {selectedProvider === "gemini"
          ? "Gemini audio travels through this application's ADK backend and then to Google. The backend uses Google Cloud Application Default Credentials. Those credentials are never sent to this browser."
          : "OpenAI audio travels directly from this browser to OpenAI over WebRTC. The OpenAI API key remains on the backend, and this browser receives only a short-lived client secret."}
      </p>
    </section>
  );
}
