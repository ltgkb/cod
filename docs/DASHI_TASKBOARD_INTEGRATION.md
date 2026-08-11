# Dashi Taskboard → COD integration plan

## Goal

Bring the useful taskboard concepts from `chuspeeism/dashi-taskboard` into COD as a native feature, without copying unlicensed source code.

## Legal constraint

The referenced `dashi-taskboard` repository currently has no LICENSE file. Treat its implementation as all-rights-reserved. Reimplement concepts and workflows from scratch; do not copy source files, UI code, CLI code, tests, or assets.

## What is worth adopting conceptually

1. A first-class task board inside the agent workspace.
2. Explicit workflow states: `todo`, `in_progress`, `in_review`, `done`, `blocked`, `cancelled`.
3. Optimistic concurrency via a task `version` field.
4. Conversation/thread ownership so multiple agents do not silently take over the same task.
5. Project → task → branch/worktree binding.
6. Comments as durable task requirements and review feedback.
7. A CLI for automation and agent-side task operations.
8. A Skill that claims a task before execution, verifies work, and moves it to review instead of auto-completing it.
9. Relations such as parent/child, blocks/blocked_by, related.
10. Real-time updates to task state across clients.

## What COD should NOT adopt

- CDP injection into ChatGPT/Codex windows. COD controls its own UI, so this is unnecessary and brittle.
- A second standalone local task server on port 47823. COD already has a control plane.
- Tauri packaging just for Taskboard. COD already ships Electron/mobile/web clients.
- A separate Cloudflare D1 task backend. COD should keep one source of truth in its existing control plane/PostgreSQL stack.
- Any direct source-code copying from dashi-taskboard unless a compatible license is added later.

## Target architecture

```text
COD Web / Desktop / Mobile
          |
          v
  Taskboard UI + Task Detail
          |
          v
   COD Control Plane API
          |
          +---- PostgreSQL
          +---- SSE/WebSocket events
          +---- Agent execution gateway
          +---- Desktop bridge (Git/worktree/terminal)
          |
          v
      COD Agent Skill
```

## Data model additions

### Task

Recommended fields:

```ts
interface CodTask {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: 'todo' | 'in_progress' | 'in_review' | 'done' | 'blocked' | 'cancelled';
  priority?: 'low' | 'medium' | 'high' | 'urgent';
  labels: string[];
  version: number;
  claimedByThreadId?: string;
  branch?: string;
  worktreePath?: string;
  createdAt: string;
  updatedAt: string;
}
```

### TaskComment

```ts
interface TaskComment {
  id: string;
  taskId: string;
  authorType: 'user' | 'agent' | 'system';
  authorId?: string;
  body: string;
  threadId?: string;
  createdAt: string;
}
```

### TaskRelation

```ts
interface TaskRelation {
  fromTaskId: string;
  toTaskId: string;
  type: 'parent' | 'blocks' | 'blocked_by' | 'related';
}
```

## Native COD workflow

### Claim

- Agent reads the task and latest comments.
- Agent requests transition `todo -> in_progress` with `ifVersion`.
- Control plane writes `claimedByThreadId` atomically.
- If version changed or another thread already owns the task, reject with `409 Conflict`.

### Execute

- Desktop-only local code operations use COD's existing desktop bridge and Goose sidecar.
- Web/mobile can create, monitor, comment, review, retry, cancel, and hand off tasks.
- Branch/worktree bindings remain a desktop capability but are persisted on the task for cross-device visibility.

### Review

- Agent posts a summary comment containing changes, verification, remaining risk.
- Agent transitions `in_progress -> in_review`.
- Agent must never automatically transition to `done` unless the user explicitly accepts/completes the task.

## API additions

Suggested routes:

```text
GET    /v1/projects/:projectId/tasks
POST   /v1/projects/:projectId/tasks
GET    /v1/tasks/:taskId
PATCH  /v1/tasks/:taskId
POST   /v1/tasks/:taskId/transition
GET    /v1/tasks/:taskId/comments
POST   /v1/tasks/:taskId/comments
GET    /v1/tasks/:taskId/relations
POST   /v1/tasks/:taskId/relations
DELETE /v1/tasks/:taskId/relations/:relationId
POST   /v1/tasks/:taskId/bind-worktree
POST   /v1/tasks/:taskId/unbind-worktree
```

Mutating requests should accept `ifVersion` and return the new version.

## UI

Add a native `Taskboard` entry to COD navigation.

Views:

1. Kanban board
   - Todo
   - In progress
   - In review
   - Blocked
   - Done

2. Task detail drawer/page
   - title and description
   - comments
   - labels and priority
   - agent/thread owner
   - branch/worktree
   - execution history
   - diff/verification summary
   - relations

3. Agent activity indicator
   - claimed
   - running
   - waiting for review
   - blocked
   - cancelled

## CLI

Create a COD-native CLI rather than copying `taskctl`.

Suggested binary: `codctl`

```bash
codctl task list --project <id>
codctl task get <id>
codctl task create --project <id> --title "..."
codctl task claim <id> --if-version <n>
codctl task comment <id> --body "..."
codctl task transition <id> in_review --if-version <n>
codctl task bind-worktree <id> --path /path/to/worktree
```

JSON should be the default machine-readable output for agent use, with `--human` for terminal-friendly formatting.

## Skill

Create `skills/manage-cod-task/SKILL.md` with these rules:

1. Read task + latest comments before doing work.
2. Claim before reading/modifying project code.
3. Never take over a task claimed by another thread.
4. Use optimistic version checks for every mutation.
5. Work in the bound branch/worktree if present.
6. Verify before moving to review.
7. Add a durable result comment.
8. Move to `in_review`, not `done`.
9. Only user acceptance moves the task to `done`.

## Implementation phases

### Phase 1 — task model and API

- normalize COD task statuses
- add task `version`
- add thread claim ownership
- add comments
- add transition endpoint
- add concurrency tests

### Phase 2 — native Taskboard UI

- Kanban board
- drag/drop status transitions
- task detail
- comments
- review/accept actions
- live updates

### Phase 3 — agent integration

- create `codctl`
- create manage-task Skill
- pass `COD_THREAD_ID`/task ID into agent execution
- enforce claim ownership

### Phase 4 — Git/worktree integration

- bind task to branch/worktree
- create worktree from Taskboard
- open task terminal/diff
- persist verification results

### Phase 5 — mobile and collaboration

- mobile board/detail/review
- notifications for review/blocked tasks
- multi-user assignees and permissions

## Recommended first slice

Do not start by cloning the whole dashi feature set.

Ship this vertical slice first:

```text
Taskboard UI
  -> create task
  -> claim task
  -> agent executes
  -> agent posts verification
  -> in_review
  -> user accepts
  -> done
```

That single workflow proves the core value and fits COD's existing agent/control-plane architecture.

## Architectural decision

The Taskboard should be a native COD feature, not an embedded third-party app.

The long-term product model is:

```text
COD = Agent Workspace
    + Chat
    + Tasks
    + Git/worktrees
    + Terminal
    + Devices
    + Automation
```

Taskboard becomes the orchestration surface connecting those capabilities.
