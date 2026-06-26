// cortextOS Dashboard - N4 Cancel-team API route
// POST /api/teams/[team_id]/cancel → cancel-team IPC (async/best-effort)
// State-changing action: requires inline auth + CSRF origin check.

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { IPCClient } from '@/lib/ipc-client';

export const dynamic = 'force-dynamic';

const VALID_TEAM_ID = /^[a-z0-9_-]+$/;

// ---------------------------------------------------------------------------
// POST /api/teams/[team_id]/cancel
//
// Requests async cancellation of all live runs in the team.
// Returns { status: 'cancel_requested' } — NOT 'stopped' (cancel is async/best-effort).
// ---------------------------------------------------------------------------

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ team_id: string }> },
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

  // 3. Validate team_id from URL params
  const { team_id: rawTeamId } = await params;
  const team_id = decodeURIComponent(rawTeamId);

  if (!VALID_TEAM_ID.test(team_id)) {
    return NextResponse.json({ error: 'Invalid team_id' }, { status: 400 });
  }

  // 4. IPC call
  const ipc = new IPCClient(process.env.CTX_INSTANCE_ID ?? 'default');
  if (!(await ipc.isDaemonRunning())) {
    return NextResponse.json({ error: 'Daemon not running' }, { status: 503 });
  }

  try {
    await ipc.send({ type: 'cancel-team', data: { team_id } });
    // Return "cancel_requested" — cancellation is async/best-effort; live updates
    // arrive via SSE as the daemon processes individual run cancellations.
    return NextResponse.json({ status: 'cancel_requested' });
  } catch (err) {
    console.error('[api/teams/cancel] POST IPC error:', err);
    return NextResponse.json({ error: 'IPC error' }, { status: 503 });
  }
}
