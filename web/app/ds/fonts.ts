// The two DS v2 families, self-hosted by next/font. Archivo carries display,
// headings and body; DM Mono carries everything measured (labels, numbers,
// dates). No italic cuts: the DS has no italics. The CSS variables are read
// by --display / --sans / --mono in tokens.css.
import { Archivo, DM_Mono } from 'next/font/google';

export const archivo = Archivo({
  subsets: ['latin'],
  style: ['normal'],
  display: 'swap',
  variable: '--font-archivo',
});

export const dmMono = DM_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  style: ['normal'],
  display: 'swap',
  variable: '--font-dm-mono',
});
