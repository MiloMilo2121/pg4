'use client';

// Root route → the Setaccio dashboard (the real product UI). The previous dark
// "pg4 intelligence" dashboard now lives at /legacy as the wiring reference.
import Providers from './setaccio/Providers';
import SetaccioPage from './setaccio/page';

export default function Page() {
  return (
    <Providers>
      <SetaccioPage />
    </Providers>
  );
}
