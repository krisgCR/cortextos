// cortextOS Dashboard - Task 3.3 Cancel-run API route
// POST /api/runs/[run_id]/cancel → cancel-run IPC (async/best-effort, reason=human)
// State-changing action: requires inline auth + CSRF origin check.
// Mirrors /api/teams/[team_id]/cancel/route.ts — this is the run-scoped counterpart;
// it does NOT touch any team's cancel_generation.

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { IPCClient } from '@/lib/ipc-client';

export const dynamic = 'force-dynamic';

const VALID_RUN_ID = /^[a-zA-Z0-9_-]+$/;

// ---------------------------------------------------------------------------
// POST /api/runs/[run_id]/cancel
//
// Requests async cancellation of a single run (reason=human).
// Returns { status: 'cancel_requested' } — NOT 'stopped' (cancel is async/best-effort).
// ---------------------------------------------------------------------------

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ run_id: string }> },
) {
  // 1. Inline auth check
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 2. CSRF / origin check
  const origin = req.headers.get('origin');
  const host = req.headers.get('host');
  if (origin) {
    try {
      const originHost = new URL(origin).host;
      if (originHost !== host) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
    } catch {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  }

  // 3. Validate run_id from URL params
  const { run_id: rawRunId } = await params;
  const run_id = decodeURIComponent(rawRunId);

  if (!VALID_RUN_ID.test(run_id) || run_id.length > 128) {
    return NextResponse.json({ error: 'Invalid run_id' }, { status: 400 });
  }

  // 4. IPC call
  const ipc = new IPCClient(process.env.CTX_INSTANCE_ID ?? 'default');
  if (!(await ipc.isDaemonRunning())) {
    return NextResponse.json({ error: 'Daemon not running' }, { status: 503 });
  }

  try {
    await ipc.send({ type: 'cancel-run', data: { run_id } });
    // Return "cancel_requested" — cancellation is async/best-effort; live updates
    // arrive via SSE ('run' events) as the daemon processes the cancellation.
    return NextResponse.json({ status: 'cancel_requested' });
  } catch (err) {
    console.error('[api/runs/cancel] POST IPC error:', err);
    return NextResponse.json({ error: 'IPC error' }, { status: 503 });
  }
}
