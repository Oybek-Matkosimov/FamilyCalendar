import type { ReactNode } from 'react';
import type { Metadata, Viewport } from 'next';
import { Bricolage_Grotesque, Figtree } from 'next/font/google';
import { ToastProvider } from '@/components/ui/Toast';
import './globals.css';

const display = Bricolage_Grotesque({ subsets: ['latin'], variable: '--font-bricolage', display: 'swap' });
const body = Figtree({ subsets: ['latin'], variable: '--font-figtree', display: 'swap' });

export const metadata: Metadata = {
  title: 'Family Calendar',
  description: 'One shared calendar for the whole family. See who is doing what, and spot clashes early.',
};
/**
 * Pages are rendered per request (not prerendered at build time) so Next.js can stamp the per-request CSP nonce
 * (set in src/middleware.ts) on its inline scripts. Static HTML would be blocked by the strict CSP.
 */
export const dynamic = 'force-dynamic';

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`}>
      <body>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
