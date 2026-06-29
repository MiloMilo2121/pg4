import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Providers from './Providers';

export const metadata: Metadata = {
  title: 'Setaccio — Intelligence Commerciale',
  description: 'Dal territorio grezzo alla lista di aziende che vale la pena chiamare.',
};

export default function SetaccioLayout({ children }: { children: ReactNode }) {
  return <Providers>{children}</Providers>;
}
