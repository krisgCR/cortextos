// cortextOS Dashboard - N4 Dispatch API route
// POST /api/dispatch → spawn-worker IPC
// Billed action: requires inline auth + CSRF origin check.

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { IPCClient } from '@/lib/ipc-client';

export const dynamic = 'force-dynamic';

const VALID_NAME = /^[a-z0-9_-]+$/;
const VALID_TEAM_ID = /^[a-z0-9_-]+$/;
const VALID_RUNTIMES = ['pty', 'claude-bg'] as const;

// ---------------------------------------------------------------------------
// POST /api/dispatch
//
// Body: { name, dir, prompt, model?, runtime?, team_id?, budget_tokens? }
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  // 1. Inline auth check (billed action — don't rely on middleware alone)
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

  // 3. Parse body
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { name, dir, prompt, model, runtime, team_id, budget_tokens } = body;

  // Validate name
  if (!name || typeof name !== 'string' || !VALID_NAME.test(name) || name.length > 64) {
    return NextResponse.json(
      { error: 'Invalid name (must match /^[a-z0-9_-]+$/, max 64 chars)' },
      { status: 400 },
    );
  }

  // Validate dir
  if (!dir || typeof dir !== 'string') {
    return NextResponse.json({ error: 'Invalid dir' }, { status: 400 });
  }

  // Validate prompt
  if (!prompt || typeof prompt !== 'string' || prompt.length > 10_000) {
    return NextResponse.json(
      { error: 'Invalid prompt (max 10000 chars)' },
      { status: 400 },
    );
  }

  // Validate runtime (optional, allowlist)
  if (runtime !== undefined && !VALID_RUNTIMES.includes(runtime as typeof VALID_RUNTIMES[number])) {
    return NextResponse.json(
      { error: 'runtime must be pty or claude-bg' },
      { status: 400 },
    );
  }

  // Validate team_id (optional)
  if (team_id !== undefined && (typeof team_id !== 'string' || !VALID_TEAM_ID.test(team_id))) {
    return NextResponse.json({ error: 'Invalid team_id' }, { status: 400 });
  }

  // Validate budget_tokens (optional, finite non-negative integer ≤ 10M)
  if (budget_tokens !== undefined) {
    if (
      typeof budget_tokens !== 'number' ||
      !Number.isFinite(budget_tokens) ||
      budget_tokens < 0 ||
      !Number.isInteger(budget_tokens) ||
      budget_tokens > 10_000_000
    ) {
      return NextResponse.json({ error: 'Invalid budget_tokens' }, { status: 400 });
    }
  }

  // Validate model (optional)
  if (model !== undefined && typeof model !== 'string') {
    return NextResponse.json({ error: 'Invalid model' }, { status: 400 });
  }

  // 4. IPC call
  const ipc = new IPCClient(process.env.CTX_INSTANCE_ID ?? 'default');
  if (!(await ipc.isDaemonRunning())) {
    return NextResponse.json({ error: 'Daemon not running' }, { status: 503 });
  }

  try {
    const response = await ipc.send({
      type: 'spawn-worker',
      data: {
        name: name as string,
        dir: dir as string,
        prompt: prompt as string,
        ...(model !== undefined && { model: model as string }),
        ...(runtime !== undefined && { runtime: runtime as 'pty' | 'claude-bg' }),
        ...(team_id !== undefined && { team_id: team_id as string }),
        ...(budget_tokens !== undefined && { budget_tokens: budget_tokens as number }),
      },
    });
    return NextResponse.json(response);
  } catch (err) {
    console.error('[api/dispatch] POST IPC error:', err);
    return NextResponse.json({ error: 'IPC error' }, { status: 503 });
  }
}
