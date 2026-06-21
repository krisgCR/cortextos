// cortextOS Dashboard - Runtimes (fleet view) page (N3)
// Server component: fetches initial snapshot, delegates live updates to the client island.

import { getRuntimes } from '@/lib/data/runtimes';
import { RuntimeTree } from './runtime-tree';

export const dynamic = 'force-dynamic';

export default function RuntimesPage() {
  const initialRuntimes = getRuntimes();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Runtimes</h1>
        <p className="text-sm text-muted-foreground">
          Live fleet view — active runtime boundary records from all agents.
        </p>
      </div>

      <RuntimeTree initialRuntimes={initialRuntimes} />
    </div>
  );
}
