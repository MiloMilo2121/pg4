import './globals.css';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { archivo, dmMono } from './ds/fonts';

export const metadata: Metadata = {
  title: 'Setaccio · Intelligence commerciale',
  description: 'Dal territorio grezzo alla lista di aziende che vale la pena chiamare.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="it" className={`${archivo.variable} ${dmMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
