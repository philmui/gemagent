import type { Metadata, Viewport } from "next";
import Script from "next/script";
import type { ReactNode } from "react";

import { THEME_BOOTSTRAP_SCRIPT, THEME_META_COLORS } from "@/lib/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: "Voice Lab | Gemini Live and OpenAI Realtime",
  description: "A secure, low-latency speech-to-speech workspace with a live provider switch.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <meta name="theme-color" content={THEME_META_COLORS.dark} />
        <Script
          id="voice-lab-theme-bootstrap"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
