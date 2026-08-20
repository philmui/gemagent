"use client";

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

import { scrollConversationToLatest } from "@/lib/conversation-scroll";
import { formatTtfaSeconds } from "@/lib/ttfa";
import { PROVIDERS, type TranscriptItem } from "@/lib/types";
import { SparkIcon, TrashIcon, VolumeIcon } from "./icons";

interface ConversationPanelProps {
  items: TranscriptItem[];
  active: boolean;
  onClear: () => void;
}

export function ConversationPanel({ items, active, onClear }: ConversationPanelProps) {
  const logRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const scrollToLatest = useCallback(() => {
    if (active) scrollConversationToLatest(logRef.current);
  }, [active]);

  // Keep scrolling local to the transcript. scrollIntoView() can move the page
  // or another ancestor, and smooth scrolling can lag behind streaming updates.
  useLayoutEffect(() => {
    if (!active) return;
    scrollToLatest();
    const frame = window.requestAnimationFrame(scrollToLatest);
    return () => window.cancelAnimationFrame(frame);
  }, [active, items, scrollToLatest]);

  // Width changes can reflow old messages without changing the item array.
  // DOM observation also covers rapid streaming text mutations between renders.
  useEffect(() => {
    const thread = threadRef.current;
    if (!active || !thread) return;
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scrollToLatest);
    const mutationObserver =
      typeof MutationObserver === "undefined" ? null : new MutationObserver(scrollToLatest);
    resizeObserver?.observe(thread);
    mutationObserver?.observe(thread, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    return () => {
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    };
  }, [active, scrollToLatest]);

  return (
    <section className="conversation-section" aria-label="Live captions">
      <div className="panel-toolbar">
        <div>
          <p className="panel-kicker">Live captions</p>
          <p className="panel-subtitle">Captions may differ from what the model heard.</p>
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={onClear}
          disabled={items.length === 0}
          aria-label="Clear live captions"
        >
          <TrashIcon />
        </button>
      </div>

      <div
        ref={logRef}
        className="conversation-log"
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        aria-label="Conversation transcript, newest turn last"
      >
        <div className="conversation-thread" ref={threadRef}>
          {items.length === 0 ? (
            <div className="empty-conversation">
              <span className="empty-icon"><SparkIcon /></span>
              <h2>Your conversation will appear here</h2>
              <p>Try asking for a quick explanation, a plan, or a creative idea.</p>
              <div className="prompt-chips" aria-label="Example prompts">
                <span>“Plan my afternoon”</span>
                <span>“Explain this simply”</span>
                <span>“Practice Spanish”</span>
              </div>
            </div>
          ) : (
            items.map((item) => {
              if (item.role === "system") {
                return (
                  <div className="session-divider" key={item.id}>
                    <span>{item.text}</span>
                    <code>{item.model}</code>
                  </div>
                );
              }
              const provider = PROVIDERS[item.provider];
              const ttfaSeconds =
                item.role === "assistant" ? formatTtfaSeconds(item.ttfaMs) : null;
              const ttfaPending = ttfaSeconds === null && item.status !== "interrupted";
              const stateLabel =
                item.status === "interrupted"
                  ? "Interrupted"
                  : item.status === "partial"
                    ? "Listening…"
                    : null;
              return (
                <article className={`caption caption-${item.role}`} key={item.id}>
                  <div className="caption-meta">
                    <div className="caption-speaker">
                      <span>{item.role === "user" ? "You" : provider.label}</span>
                      {item.role === "assistant" ? (
                        <span
                          className="caption-ttfa"
                          title={
                            ttfaSeconds === null
                              ? ttfaPending
                                ? "Waiting for first response audio"
                                : "No response audio started before this reply was interrupted"
                              : "Time to first audio, measured from detected end of your speech to first response audio"
                          }
                        >
                          <VolumeIcon />
                          <span className="caption-ttfa-label" aria-hidden="true">TTFA</span>
                          {ttfaSeconds === null ? (
                            <span
                              className="caption-ttfa-value"
                              aria-label={
                                ttfaPending
                                  ? "Time to first audio pending"
                                  : "Time to first audio unavailable"
                              }
                            >
                              {ttfaPending ? "…" : "—"}
                            </span>
                          ) : (
                            <time className="caption-ttfa-value" dateTime={`PT${ttfaSeconds}S`}>
                              <span aria-hidden="true">{ttfaSeconds} s</span>
                              <span className="visually-hidden">
                                Time to first audio: {ttfaSeconds} seconds, measured from detected
                                end of your speech to first response audio.
                              </span>
                            </time>
                          )}
                        </span>
                      ) : null}
                    </div>
                    <code>{item.model}</code>
                  </div>
                  <p>{item.text}</p>
                  {stateLabel ? <span className="caption-state">{stateLabel}</span> : null}
                </article>
              );
            })
          )}
        </div>
      </div>
    </section>
  );
}
