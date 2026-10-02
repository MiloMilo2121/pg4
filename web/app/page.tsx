'use client';

// Root route → the Setaccio dashboard.
import Providers from './setaccio/Providers';
import SetaccioPage from './setaccio/page';

export default function Page() {
  return (
    <Providers>
      <SetaccioPage />
    </Providers>
  );
}
