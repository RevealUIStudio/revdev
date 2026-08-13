import { useState } from 'react';
import type { HarnessTask } from '../../types';
import Button from '../adapters/Button';
import Input from '../adapters/Input';

interface TaskBoardProps {
  tasks: HarnessTask[];
  agentId: string;
  onCreate: (taskId: string, description: string) => Promise<void>;
  onClaim: (taskId: string) => Promise<void>;
  onComplete: (taskId: string) => Promise<void>;
  onRelease: (taskId: string) => Promise<void>;
}

type TaskColumn = 'open' | 'claimed' | 'completed';

const COLUMN_CONFIG: Record<TaskColumn, { label: string; accent: string; bgAccent: string }> = {
  open: { label: 'Open', accent: 'text-info', bgAccent: 'bg-info-subtle' },
  claimed: { label: 'Claimed', accent: 'text-warning', bgAccent: 'bg-warning-subtle' },
  completed: { label: 'Done', accent: 'text-success', bgAccent: 'bg-success-subtle' },
};

const COLUMNS: TaskColumn[] = ['open', 'claimed', 'completed'];

export default function TaskBoard({
  tasks,
  agentId,
  onCreate,
  onClaim,
  onComplete,
  onRelease,
}: TaskBoardProps) {
  const [creating, setCreating] = useState(false);
  const [newId, setNewId] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleCreate(): Promise<void> {
    if (!(newId.trim() && newDesc.trim())) return;
    setSubmitting(true);
    try {
      await onCreate(newId.trim(), newDesc.trim());
      setCreating(false);
      setNewId('');
      setNewDesc('');
    } finally {
      setSubmitting(false);
    }
  }

  function relativeTime(iso: string): string {
    const ts = Date.parse(iso);
    if (Number.isNaN(ts)) return iso;
    const diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }

  function tasksByColumn(col: TaskColumn): HarnessTask[] {
    return tasks.filter((t) => t.status === col);
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-edge px-3 py-2">
        <span className="text-xs font-semibold text-fg">Tasks</span>
        <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-fg-muted">
          {tasks.length}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setCreating(!creating)}
          className="ml-auto rounded bg-info-subtle px-2 py-1 text-[10px] font-medium text-info hover:bg-info-subtle/70"
        >
          {creating ? 'Cancel' : '+ Task'}
        </Button>
      </div>

      {/* Create form */}
      {creating ? (
        <div className="border-b border-edge bg-surface-1/50 p-3">
          <Input
            value={newId}
            onChange={(e) => setNewId(e.target.value)}
            placeholder="Task ID (e.g. task-004)"
            className="mb-2"
          />
          <Input
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            placeholder="Description"
            className="mb-2"
          />
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={() => void handleCreate()}
            disabled={submitting || !newId.trim() || !newDesc.trim()}
          >
            {submitting ? 'Creating…' : 'Create'}
          </Button>
        </div>
      ) : null}

      {/* Kanban columns */}
      <div className="flex flex-1 gap-2 overflow-x-auto p-3">
        {COLUMNS.map((col) => {
          const cfg = COLUMN_CONFIG[col];
          const colTasks = tasksByColumn(col);
          return (
            <div
              key={col}
              className={`flex min-w-[180px] flex-1 flex-col rounded-lg ${cfg.bgAccent}`}
            >
              <div className="flex items-center gap-1.5 px-2.5 py-2">
                <span
                  className={`text-[10px] font-semibold uppercase tracking-wider ${cfg.accent}`}
                >
                  {cfg.label}
                </span>
                <span className="rounded bg-surface-2 px-1 py-0.5 text-[10px] text-fg-subtle">
                  {colTasks.length}
                </span>
              </div>
              <div className="flex flex-1 flex-col gap-1.5 overflow-y-auto px-2 pb-2">
                {colTasks.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    agentId={agentId}
                    relativeTime={relativeTime}
                    onClaim={() => void onClaim(task.id)}
                    onComplete={() => void onComplete(task.id)}
                    onRelease={() => void onRelease(task.id)}
                  />
                ))}
                {colTasks.length === 0 ? (
                  <p className="py-4 text-center text-[10px] text-fg-subtle">Empty</p>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Task card ────────────────────────────────────────────────────────────────

interface TaskCardProps {
  task: HarnessTask;
  agentId: string;
  relativeTime: (iso: string) => string;
  onClaim: () => void;
  onComplete: () => void;
  onRelease: () => void;
}

function TaskCard({ task, agentId, relativeTime, onClaim, onComplete, onRelease }: TaskCardProps) {
  const isOwned = task.owner === agentId;

  return (
    <div className="rounded border border-edge bg-surface-1/80 p-2">
      <p className="text-[10px] font-medium text-fg-subtle">{task.id}</p>
      <p className="mt-0.5 text-xs leading-snug text-fg">{task.description}</p>
      {task.owner ? (
        <p className="mt-1 text-[10px] text-fg-subtle">
          owner: <span className="text-fg-muted">{task.owner}</span>
        </p>
      ) : null}
      <p className="mt-0.5 text-[10px] text-fg-subtle">{relativeTime(task.created_at)}</p>

      {/* Actions */}
      <div className="mt-1.5 flex gap-1">
        {task.status === 'open' ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClaim}
            className="rounded bg-info-subtle px-2 py-0.5 text-[10px] font-medium text-info hover:bg-info-subtle/70"
          >
            Claim
          </Button>
        ) : null}
        {task.status === 'claimed' && isOwned ? (
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onComplete}
              className="rounded bg-success-subtle px-2 py-0.5 text-[10px] font-medium text-success hover:bg-success-subtle/70"
            >
              Complete
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onRelease}
              className="rounded bg-surface-3/40 px-2 py-0.5 text-[10px] font-medium text-fg-muted hover:bg-surface-3/60"
            >
              Release
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}
