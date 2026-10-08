import { Home } from './pages/Home';
import { HostPage } from './pages/Host';
import { PlayerPage } from './pages/Player';
import { usePath } from './lib/router';

export function App() {
  const path = usePath();
  const host = path.match(/^\/host\/([A-Za-z0-9]{4,5})\/?$/);
  if (host) return <HostPage code={host[1].toUpperCase()} />;
  const join = path.match(/^\/(?:join|j)\/([A-Za-z0-9]{4,5})\/?$/);
  if (join) return <PlayerPage code={join[1].toUpperCase()} />;
  return <Home />;
}
