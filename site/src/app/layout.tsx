import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import type { ReactNode } from 'react';
import { STAGE_SCRIPT } from '@/lib/stage';
import './styles/tokens.css';
import './styles/base.css';
import './styles/chrome.css';
import './styles/pulse.css';
import './styles/parts.css';
import './styles/connect.css';
import './styles/understood.css';
import './styles/replay.css';
import './styles/replay-gap.css';
import './styles/replay-stage.css';
import './styles/pr.css';
import './styles/pr-stage.css';
import './styles/keeps.css';
import './styles/monday.css';
import './styles/moonshot.css';
import './styles/overview.css';
import './styles/product.css';
import './styles/present.css';

const grotesk = localFont({
  src: './fonts/schibsted-grotesk-latin-wght-normal.woff2',
  weight: '400 900',
  variable: '--font-grotesk',
  display: 'swap',
});

const mono = localFont({
  src: [
    { path: './fonts/ibm-plex-mono-latin-400-normal.woff2', weight: '400' },
    { path: './fonts/ibm-plex-mono-latin-500-normal.woff2', weight: '500' },
    { path: './fonts/ibm-plex-mono-latin-600-normal.woff2', weight: '600' },
  ],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'keepup',
  description: "You can't keep up with AI. Your product can.",
  robots: { index: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#f6f3ec',
};

/** Runs before first paint, so a ?present link never flashes the dashboard. */
const PRE_PAINT = `try{if(/[?&]present/.test(location.search)){document.documentElement.classList.add('is-present');${STAGE_SCRIPT}}}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${grotesk.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: PRE_PAINT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
