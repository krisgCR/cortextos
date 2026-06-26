'use client';

// cortextOS Dashboard - N4 DispatchDialog component
// Kill-switch aware: disables submit when dispatch is globally disabled.
// Budget preview from rollup (eventually-consistent / informational only).
// Two-step confirm before POST to avoid accidental dispatches.

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { IconLoader2, IconAlertTriangle } from '@tabler/icons-react';
import type { TeamRollup } from '@/lib/data/dispatch-rollup';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DispatchStatus {
  enabled: boolean;
  teamBudgetTokens: number;
  maxConcurrency: number;
  fleetMaxConcurrent: number;
}

export interface DispatchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Per-team rollups for budget preview (from RSC — eventually consistent). */
  rollups: TeamRollup[];
  /** Dispatch system status — null when daemon is down; used for kill-switch. */
  dispatchStatus: DispatchStatus | null;
  /** Called after a successful dispatch (accepted). */
  onDispatched?: () => void;
}

type Step = 'form' | 'confirm' | 'result';
type Runtime = 'pty' | 'claude-bg';

const VALID_NAME = /^[a-z0-9_-]+$/;
const VALID_TEAM_ID = /^[a-z0-9_-]+$/;

function formatTokens(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// ---------------------------------------------------------------------------
// DispatchDialog
// ---------------------------------------------------------------------------

export function DispatchDialog({
  open,
  onOpenChange,
  rollups,
  dispatchStatus,
  onDispatched,
}: DispatchDialogProps) {
  const [step, setStep] = useState<Step>('form');
  const [result, setResult] = useState<{
    accepted: boolean;
    reason?: string;
    run_id?: string;
  } | null>(null);

  // Form fields
  const [teamId, setTeamId] = useState('');
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [dir, setDir] = useState('');
  const [budgetTokens, setBudgetTokens] = useState<string>('');
  const [runtime, setRuntime] = useState<Runtime>('pty');
  const [model, setModel] = useState('');

  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Kill-switch: dispatch globally disabled
  const killSwitchOff = dispatchStatus?.enabled === false;

  // Budget preview for the selected team
  const teamRollup = rollups.find((r) => r.team_id === teamId);
  const defaultBudget = dispatchStatus?.teamBudgetTokens;

  function resetForm() {
    setStep('form');
    setResult(null);
    setTeamId('');
    setName('');
    setPrompt('');
    setDir('');
    setBudgetTokens('');
    setRuntime('pty');
    setModel('');
    setError('');
    setLoading(false);
  }

  function handleOpenChange(next: boolean) {
    if (!next) resetForm();
    onOpenChange(next);
  }

  function validate(): string | null {
    if (!teamId.trim()) return 'Team ID is required.';
    if (!VALID_TEAM_ID.test(teamId.trim())) return 'Team ID must match /^[a-z0-9_-]+$/';
    if (!name.trim()) return 'Agent name is required.';
    if (!VALID_NAME.test(name.trim())) return 'Name must match /^[a-z0-9_-]+$/ (max 64 chars).';
    if (name.length > 64) return 'Name must be 64 characters or fewer.';
    if (!prompt.trim()) return 'Prompt is required.';
    if (prompt.length > 10_000) return 'Prompt must be 10,000 characters or fewer.';
    if (!dir.trim()) return 'Working directory is required.';
    if (budgetTokens !== '') {
      const n = Number(budgetTokens);
      if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n) || n > 10_000_000) {
        return 'Budget tokens must be a non-negative integer ≤ 10,000,000.';
      }
    }
    return null;
  }

  function handleFormSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setStep('confirm');
  }

  async function handleConfirm() {
    setLoading(true);
    setError('');

    const payload: Record<string, unknown> = {
      name: name.trim(),
      dir: dir.trim(),
      prompt: prompt.trim(),
      team_id: teamId.trim(),
      runtime,
    };
    if (model.trim()) payload.model = model.trim();
    if (budgetTokens !== '') payload.budget_tokens = Number(budgetTokens);

    try {
      const res = await fetch('/api/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const body = await res.json().catch(() => null);

      if (!res.ok) {
        throw new Error(body?.error ?? `Dispatch failed (${res.status})`);
      }

      // Daemon returns IPCResponse: { success, data?, error? }
      // data.dispatch may contain { accepted, reason, run_id }
      const dispatchData = (body?.data as { accepted?: boolean; reason?: string; run_id?: string }) ?? {};
      const accepted = body?.success && dispatchData.accepted !== false;

      setResult({
        accepted,
        reason: dispatchData.reason ?? body?.error,
        run_id: dispatchData.run_id,
      });
      setStep('result');

      if (accepted) {
        onDispatched?.();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setStep('form');
    } finally {
      setLoading(false);
    }
  }

  const budgetN = budgetTokens !== '' ? Number(budgetTokens) : defaultBudget;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Dispatch Run</DialogTitle>
          <DialogDescription>
            Launch a bounded run within a team budget.
          </DialogDescription>
        </DialogHeader>

        {/* Kill-switch banner */}
        {killSwitchOff && (
          <div className="flex items-center gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <IconAlertTriangle className="h-4 w-4 shrink-0" />
            <span>Dispatch is currently disabled. Enable it in daemon settings before dispatching.</span>
          </div>
        )}

        {/* STEP: form */}
        {step === 'form' && (
          <form onSubmit={handleFormSubmit} className="space-y-4">
            {/* Team ID */}
            <div className="grid gap-1.5">
              <Label htmlFor="dispatch-team-id">Team ID</Label>
              <Input
                id="dispatch-team-id"
                placeholder="my-team"
                value={teamId}
                onChange={(e) => setTeamId(e.target.value.toLowerCase())}
                disabled={loading}
                autoFocus
              />
              {/* Budget preview for the selected team */}
              {teamRollup && (
                <p className="text-xs text-muted-foreground">
                  Current budget — Reserved:{' '}
                  <span className="font-mono">{formatTokens(teamRollup.reserved)}</span>{' '}
                  · Spent:{' '}
                  <span className="font-mono">{formatTokens(teamRollup.spentEstimate)}</span>
                  {' '}(informational — daemon is authoritative)
                </p>
              )}
            </div>

            {/* Agent name */}
            <div className="grid gap-1.5">
              <Label htmlFor="dispatch-name">Agent Name</Label>
              <Input
                id="dispatch-name"
                placeholder="worker-01"
                value={name}
                onChange={(e) => setName(e.target.value.toLowerCase())}
                disabled={loading}
              />
            </div>

            {/* Working directory */}
            <div className="grid gap-1.5">
              <Label htmlFor="dispatch-dir">Working Directory</Label>
              <Input
                id="dispatch-dir"
                placeholder="/path/to/workdir"
                value={dir}
                onChange={(e) => setDir(e.target.value)}
                disabled={loading}
              />
            </div>

            {/* Prompt */}
            <div className="grid gap-1.5">
              <Label htmlFor="dispatch-prompt">Prompt</Label>
              <Textarea
                id="dispatch-prompt"
                placeholder="Describe the task…"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                disabled={loading}
                rows={4}
                className="resize-y"
              />
              <p className="text-xs text-muted-foreground text-right">
                {prompt.length}/10,000
              </p>
            </div>

            {/* Runtime */}
            <div className="grid gap-1.5">
              <Label>Runtime</Label>
              <Select value={runtime} onValueChange={(v) => setRuntime(v as Runtime)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="pty">pty (default)</SelectItem>
                  <SelectItem value="claude-bg">claude-bg (background)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Budget tokens */}
            <div className="grid gap-1.5">
              <Label htmlFor="dispatch-budget">
                Budget Tokens{' '}
                <span className="text-muted-foreground font-normal">
                  (optional{defaultBudget != null ? `, default: ${formatTokens(defaultBudget)}` : ''})
                </span>
              </Label>
              <Input
                id="dispatch-budget"
                type="number"
                min={0}
                max={10_000_000}
                step={1}
                placeholder={defaultBudget != null ? String(defaultBudget) : 'e.g. 50000'}
                value={budgetTokens}
                onChange={(e) => setBudgetTokens(e.target.value)}
                disabled={loading}
              />
            </div>

            {/* Model (optional) */}
            <div className="grid gap-1.5">
              <Label htmlFor="dispatch-model">
                Model <span className="text-muted-foreground font-normal">(optional)</span>
              </Label>
              <Input
                id="dispatch-model"
                placeholder="claude-opus-4-8 or leave blank for default"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                disabled={loading}
              />
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => handleOpenChange(false)}
                disabled={loading}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={loading || killSwitchOff}>
                Review &amp; Confirm
              </Button>
            </DialogFooter>
          </form>
        )}

        {/* STEP: confirm */}
        {step === 'confirm' && (
          <div className="space-y-4">
            <div className="rounded-md border bg-muted/30 p-4 text-sm space-y-2">
              <p>
                <span className="font-medium">Team:</span>{' '}
                <span className="font-mono">{teamId}</span>
              </p>
              <p>
                <span className="font-medium">Agent:</span>{' '}
                <span className="font-mono">{name}</span>
              </p>
              <p>
                <span className="font-medium">Dir:</span>{' '}
                <span className="font-mono text-xs">{dir}</span>
              </p>
              <p>
                <span className="font-medium">Runtime:</span>{' '}
                <span className="font-mono">{runtime}</span>
              </p>
              <p>
                <span className="font-medium">Budget:</span>{' '}
                <span className="font-mono">
                  {budgN(budgetTokens, defaultBudget)}
                </span>
              </p>
              {model && (
                <p>
                  <span className="font-medium">Model:</span>{' '}
                  <span className="font-mono">{model}</span>
                </p>
              )}
              <p className="text-xs text-muted-foreground pt-1">
                Budget preview is informational — the daemon is authoritative for acceptance.
              </p>
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setStep('form')}
                disabled={loading}
              >
                Back
              </Button>
              <Button onClick={handleConfirm} disabled={loading}>
                {loading && <IconLoader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                Confirm Dispatch
              </Button>
            </DialogFooter>
          </div>
        )}

        {/* STEP: result */}
        {step === 'result' && result && (
          <div className="space-y-4">
            {result.accepted ? (
              <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm">
                <p className="font-medium text-emerald-700 dark:text-emerald-400">
                  Run dispatched
                </p>
                {result.run_id && (
                  <p className="mt-1 font-mono text-xs text-muted-foreground">
                    {result.run_id}
                  </p>
                )}
              </div>
            ) : (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm">
                <p className="font-medium text-destructive">Dispatch refused</p>
                {result.reason && (
                  <p className="mt-1 text-muted-foreground">{result.reason}</p>
                )}
              </div>
            )}
            <DialogFooter>
              <Button onClick={() => handleOpenChange(false)}>Close</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function budgN(budgetTokens: string, defaultBudget: number | undefined): string {
  if (budgetTokens !== '') {
    const n = Number(budgetTokens);
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
  }
  if (defaultBudget != null) {
    const n = defaultBudget;
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return `${n} (daemon default)`;
  }
  return 'daemon default';
}
