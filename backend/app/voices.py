"""Provider voice allowlists and canonicalization."""

from __future__ import annotations

from .models import Provider


# Gemini 3.1 Live prebuilt voices. Preserve Google SDK capitalization.
GEMINI_VOICES = (
    "Achernar",
    "Achird",
    "Algenib",
    "Algieba",
    "Alnilam",
    "Aoede",
    "Autonoe",
    "Callirrhoe",
    "Charon",
    "Despina",
    "Enceladus",
    "Erinome",
    "Fenrir",
    "Gacrux",
    "Iapetus",
    "Kore",
    "Laomedeia",
    "Leda",
    "Orus",
    "Puck",
    "Pulcherrima",
    "Rasalgethi",
    "Sadachbia",
    "Sadaltager",
    "Schedar",
    "Sulafat",
    "Umbriel",
    "Vindemiatrix",
    "Zephyr",
    "Zubenelgenubi",
)

# OpenAI Realtime built-in voices. New Realtime voices are intentionally not
# accepted until they have been reviewed and added here.
OPENAI_VOICES = (
    "alloy",
    "ash",
    "ballad",
    "cedar",
    "coral",
    "echo",
    "marin",
    "sage",
    "shimmer",
    "verse",
)

_CANONICAL_VOICES = {
    Provider.GEMINI: {voice.casefold(): voice for voice in GEMINI_VOICES},
    Provider.OPENAI: {voice.casefold(): voice for voice in OPENAI_VOICES},
}


class UnsupportedVoiceError(ValueError):
    def __init__(self, provider: Provider) -> None:
        self.provider = provider
        super().__init__(f"Unsupported {provider.value} voice")


def canonicalize_voice(provider: Provider, voice: str) -> str:
    try:
        return _CANONICAL_VOICES[provider][voice.casefold()]
    except KeyError as exc:
        raise UnsupportedVoiceError(provider) from exc


def voices_for(provider: Provider) -> tuple[str, ...]:
    return GEMINI_VOICES if provider is Provider.GEMINI else OPENAI_VOICES
