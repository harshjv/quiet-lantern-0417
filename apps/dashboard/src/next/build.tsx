import { Clock, Folder, GitBranch, Lock, Share2, User, Users } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'

import { Conversation, ConversationContent } from '@/components/ai-elements/conversation'
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message'
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from '@/components/ai-elements/prompt-input'
import { Shimmer } from '@/components/ai-elements/shimmer'
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from '@/components/ai-elements/tool'
import { Button } from '@/components/ui/button'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import type { Tone } from '@/lib/tone'

import type { Place } from './app'
import { LiveBuild } from './build-live'
import { ShareDialog, TaskMenu, type Visibility } from './build-task'
import { useLive } from './data'
import { baseTask, projects, taskTone, unreachableRepos, yourKeys, type Task } from './fixtures'
import { YourWeek } from './game'
import { AgentSays, Facts, Meta, Notice, StatusPill } from './parts'
import { PixelScene } from './scene'
import { changes, phaseFacts, phaseOf, type Change, type Phase } from './stages'
import { forkId, useStory, useWorld } from './story'

type Story = ReturnType<typeof useStory>

type Props = { place: Place; go: (next: Partial<Place>) => void }

const fixPrompt =
  'api v42 failed its health check: it logged relation "orders_paise" does not exist and exited, because the migration that creates it did not run before start. Make the migration run before the app starts on deploy, check it against the preview database, and ship the fix.'

export function BuildScreen({ place, go }: Props) {
  return useLive() ? <LiveBuild place={place} go={go} /> : <MockBuild place={place} go={go} />
}

function MockBuild({ place, go }: Props) {
  const { tasks } = useWorld()
  const forking = place.view?.startsWith('fork:') ? baseTask(place.view.slice(5)) : undefined

  if (forking) {
    return <Composer project={forking.project} fork={forking} go={go} />
  }

  if (place.view === 'new' || place.view === 'fix') {
    return (
      <Composer
        project={place.project}
        prefill={place.view === 'fix' ? fixPrompt : undefined}
        go={go}
      />
    )
  }

  const shown = tasks.filter((t) => !place.project || t.project === place.project)
  const task = shown.find((t) => t.id === place.view) ?? shown[0]

  if (!task) {
    return <Composer project={place.project} go={go} />
  }

  return <Thread key={task.id} task={task} go={go} />
}

function Thread({ task, go }: { task: Task; go: Props['go'] }) {
  const story = useStory()
  const [sharing, setSharing] = useState(false)
  const [visibility, setVisibility] = useState<Visibility>(
    task.owner === 'you' ? 'private' : 'project',
  )
  const body = bodies[task.id] ?? (task.forkOf ? forkBody : undefined)
  const leave = () => {
    story.drop(task.id)
    go({
      view: null,
    })
  }

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-4 px-6 pt-6">
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <h1 className="text-lg font-semibold">{task.title}</h1>
          <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
            <StatusPill tone={taskTone[task.state]}>
              {task.state === 'working' ? 'Working' : task.reason}
            </StatusPill>
            <Meta icon={Folder} label="Project">
              {task.project}
            </Meta>
            <Meta icon={GitBranch} label="Branch">
              task/{task.id}
            </Meta>
            <Meta icon={User} label="Started by">
              {task.owner}
            </Meta>
            <Meta icon={Clock} label="Started">
              {task.age === 'now' ? 'just now' : `${task.age} ago`}
            </Meta>
            <Meta icon={visibility === 'private' ? Lock : Users} label="Visibility">
              {task.owner !== 'you'
                ? 'Shared with you'
                : visibility === 'private'
                  ? 'Private'
                  : `Everyone in ${task.project}`}
            </Meta>
          </div>
        </div>
        {task.owner === 'you' && (
          <Button variant="ghost" size="sm" onClick={() => setSharing(true)}>
            <Share2 /> Share
          </Button>
        )}
        <TaskMenu
          branch={`task/${task.id}`}
          own={task.owner === 'you'}
          preview={task.state === 'finished' ? () => undefined : undefined}
          fork={() =>
            go({
              view: `fork:${task.id}`,
            })
          }
          archive={leave}
          remove={leave}
        />
      </div>
      <ShareDialog
        key={task.id}
        task={task}
        visibility={visibility}
        onVisibility={setVisibility}
        open={sharing}
        onOpenChange={setSharing}
      />

      <Conversation className="min-h-0 flex-1">
        <ConversationContent className="px-0">
          <Message from="user">
            <MessageContent>
              {prompts[task.id] ?? prompts[task.forkOf ?? ''] ?? task.title}
            </MessageContent>
          </Message>
          {body?.(go, task, story) ?? null}
        </ConversationContent>
      </Conversation>

      {task.owner === 'you' ? (
        <PromptInput className="mb-6" onSubmit={() => undefined}>
          <PromptInputBody>
            <PromptInputTextarea placeholder="Reply to continue this task…" />
          </PromptInputBody>
          <PromptInputFooter>
            <PromptInputTools>
              <span className="text-xs text-muted-foreground">
                Sends to the agent working on this task.
              </span>
            </PromptInputTools>
            <PromptInputSubmit />
          </PromptInputFooter>
        </PromptInput>
      ) : (
        <Notice
          tone="neutral"
          title={`This is ${task.owner}'s task`}
          action={
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                go({
                  view: `fork:${task.id}`,
                })
              }
            >
              Fork into your own task
            </Button>
          }
        >
          You can read it; only {task.owner} and people they invite can reply.
        </Notice>
      )}
    </div>
  )
}

const prompts: Record<string, string> = {
  paise:
    "Order totals are floats and we're seeing ₹0.01 drift on invoices. Store every amount as integer paise and fix the maths.",
  signup: 'The signup email link sometimes 404s. Find out why and fix it.',
  dark: 'Add a dark mode that follows the system setting, with a toggle in the header.',
  flow: "Summarise the API's business flow for a new teammate, as a one-page doc.",
  next16: 'Upgrade Next.js to 16 and fix whatever breaks.',
  gst: 'Add a CSV export of GST invoices per month for the accountant.',
  fixv42: fixPrompt,
}

const agent = (children: ReactNode) => <AgentSays>{children}</AgentSays>

const bodies: Record<string, (go: Props['go'], task: Task, story: Story) => ReactNode> = {
  paise: (go, _task, story) => (
    <>
      {agent(
        <>
          <MessageResponse>
            I&apos;ll find every place amounts are stored or computed, switch them to integer paise,
            and add a migration for existing orders.
          </MessageResponse>
          <Tool>
            <ToolHeader
              type="dynamic-tool"
              toolName="Grep"
              title="price|total|amount src/"
              state="output-available"
            />
            <ToolContent>
              <ToolInput
                input={{
                  pattern: 'price|total|amount',
                  path: 'src/',
                }}
              />
              <ToolOutput output="14 files matched" errorText={undefined} />
            </ToolContent>
          </Tool>
          <Tool>
            <ToolHeader
              type="dynamic-tool"
              toolName="Bash"
              title="pnpm test orders"
              state="output-available"
            />
          </Tool>
          <MessageResponse>
            The code is converted and tests pass. Existing orders still hold floats, so I want to
            run a one-off conversion against this task&apos;s preview database.
          </MessageResponse>
        </>,
      )}
      {story.stage === 'command' ? (
        <Notice
          tone="warning"
          title="Approve a command"
          action={
            <>
              <Button variant="outline" size="sm">
                Deny
              </Button>
              <Button variant="outline" size="sm" onClick={() => story.to('finished')}>
                Allow once
              </Button>
              <Button size="sm" onClick={() => story.to('finished')}>
                Allow for this task
              </Button>
            </>
          }
        >
          <code className="font-mono text-xs">
            psql &quot;$DATABASE_URL&quot; -f migrations/0042_integer_paise.sql
          </code>
          <span className="block">
            Runs against this task&apos;s preview database. Production changes only through Ship.
          </span>
        </Notice>
      ) : (
        <>
          <Facts
            facts={[
              {
                kind: 'user',
                text: 'you allowed psql for this task',
              },
              {
                kind: 'time',
                text: 'just now',
              },
            ]}
          />
          {agent(
            <>
              <Tool>
                <ToolHeader
                  type="dynamic-tool"
                  toolName="Bash"
                  title="psql -f migrations/0042_integer_paise.sql"
                  state="output-available"
                />
              </Tool>
              <MessageResponse>
                Done. 18,204 orders converted on the preview database, every total matches to the
                paisa, and the preview is up for you to try.
              </MessageResponse>
            </>,
          )}
          <ShipCard change={changes.paise} go={go} />
        </>
      )}
    </>
  ),
  fixv42: (go) => <FixBody go={go} />,
  signup: () => (
    <>
      {agent(
        <MessageResponse>
          The link is built from `APP_URL`, which is unset in previews. Before I change it I need
          one decision.
        </MessageResponse>,
      )}
      <Notice tone="warning" title="Question for you" action={<Button size="sm">Answer</Button>}>
        <span className="block">Should the link expire in 24 hours or 7 days?</span>
        <RadioGroup defaultValue="24h" className="mt-2">
          <label className="flex items-center gap-2 text-sm">
            <RadioGroupItem value="24h" /> 24 hours
          </label>
          <label className="flex items-center gap-2 text-sm">
            <RadioGroupItem value="7d" /> 7 days
          </label>
        </RadioGroup>
      </Notice>
    </>
  ),
  dark: (go, task) => (
    <>
      {agent(
        <>
          <Tool>
            <ToolHeader
              type="dynamic-tool"
              toolName="Edit"
              title="app/theme.ts app/header.tsx app/globals.css app/layout.tsx"
              state="output-available"
            />
          </Tool>
          <MessageResponse>
            Done. The theme follows the system setting, the header has a sun/moon toggle that
            remembers your choice, and every page passes contrast checks in both themes.
          </MessageResponse>
        </>,
      )}
      <Notice
        tone="success"
        title="Preview is up"
        action={
          <>
            <Button variant="outline" size="sm">
              Open preview
            </Button>
            <Button
              size="sm"
              onClick={() =>
                go({
                  mode: 'ship',
                  project: task.project,
                })
              }
            >
              Ship to production
            </Button>
          </>
        }
      >
        <Facts
          facts={[
            {
              kind: 'files',
              text: '4 files',
            },
            {
              kind: 'preview',
              text: 'dark-mode.yolo.preview',
            },
          ]}
        />
      </Notice>
    </>
  ),
  flow: () => agent(<Shimmer>Reading docs/BUSINESS_FLOW.md and the order routes…</Shimmer>),
  next16: () => (
    <div className="flex flex-col gap-3">
      <PixelScene slots={3} running={3} queued={1} className="h-36" />
      <Notice
        tone="neutral"
        title="Queued: all 3 slots are busy"
        action={
          <Button size="sm" variant="outline">
            Run it separately now
          </Button>
        }
      >
        Starts when a task finishes, usually within a few minutes.
      </Notice>
    </div>
  ),
  gst: () =>
    agent(
      <MessageResponse>
        Added `GET /reports/gst?month=2026-10` returning CSV with GSTIN, HSN, taxable value and the
        CGST/SGST/IGST split. Tests cover intra- and inter-state orders.
      </MessageResponse>,
    ),
}

const shipCard: Record<Phase, { tone: Tone; title: string; label: string; place: Partial<Place> }> =
  {
    working: {
      tone: 'info',
      title: 'Working',
      label: 'Open in Ship',
      place: {
        mode: 'ship',
      },
    },
    ready: {
      tone: 'success',
      title: 'Preview is up',
      label: 'Ship to production',
      place: {
        mode: 'ship',
        view: 'review',
      },
    },
    review: {
      tone: 'neutral',
      title: 'Waiting for approval in Ship',
      label: 'Open the approval',
      place: {
        mode: 'ship',
        view: 'review',
      },
    },
    deploying: {
      tone: 'info',
      title: 'Deploying to production',
      label: 'Watch the deploy',
      place: {
        mode: 'ship',
        view: 'deploy',
      },
    },
    failed: {
      tone: 'danger',
      title: 'The deploy failed',
      label: 'Open in Observe',
      place: {
        mode: 'observe',
        view: null,
      },
    },
    shipped: {
      tone: 'success',
      title: 'In production',
      label: 'Open in Ship',
      place: {
        mode: 'ship',
        view: null,
      },
    },
  }

function ShipCard({ change, go }: { change: Change; go: Props['go'] }) {
  const story = useStory()
  const phase = phaseOf(change, story.stage)
  const card = shipCard[phase]

  return (
    <Notice
      tone={card.tone}
      title={card.title}
      action={
        <>
          {phase === 'ready' && (
            <Button variant="outline" size="sm">
              Open preview
            </Button>
          )}
          <Button
            size="sm"
            variant={phase === 'ready' ? 'default' : 'outline'}
            onClick={() => {
              if (phase === 'ready') {
                story.to(change.stages.review)
              }

              go({
                ...card.place,
                project: 'etherbit',
              })
            }}
          >
            {card.label}
          </Button>
        </>
      }
    >
      <Facts facts={phaseFacts(change, phase)} />
    </Notice>
  )
}

function FixBody({ go }: { go: Props['go'] }) {
  const story = useStory()
  const working = story.stage === 'fixing'

  useEffect(() => {
    if (!working) {
      return
    }

    const timer = setTimeout(() => story.to('fixed'), 3000)

    return () => clearTimeout(timer)
  }, [story, working])

  if (working) {
    return agent(
      <Shimmer>
        Reading the deploy log and the start script, then moving the migration before start…
      </Shimmer>,
    )
  }

  return (
    <>
      {agent(
        <>
          <Tool>
            <ToolHeader
              type="dynamic-tool"
              toolName="Edit"
              title="scripts/start.sh"
              state="output-available"
            />
          </Tool>
          <Tool>
            <ToolHeader
              type="dynamic-tool"
              toolName="Bash"
              title="pnpm test deploy"
              state="output-available"
            />
          </Tool>
          <MessageResponse>{changes.fix.summary}</MessageResponse>
        </>,
      )}
      <ShipCard change={changes.fix} go={go} />
    </>
  )
}

const forkBody = (go: Props['go'], task: Task, story: Story) => (
  <>
    {bodies[task.forkOf!]?.(go, task, story)}
    {agent(<Shimmer>Picking up from the forked branch…</Shimmer>)}
  </>
)

function Blocker({ agent: picked, repo, go }: { agent: string; repo: string; go: Props['go'] }) {
  if (picked === 'codex' && !yourKeys.codex) {
    return (
      <Notice
        tone="warning"
        title="You haven't added a Codex key"
        action={
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              go({
                mode: 'outside',
                view: 'account',
              })
            }
          >
            Add your key
          </Button>
        }
      >
        Tasks run on your own keys. Add one in Your account, or pick Claude Code.
      </Notice>
    )
  }

  if (unreachableRepos.includes(repo)) {
    return (
      <Notice
        tone="danger"
        title={`Stationly can't reach ${repo}`}
        action={
          <Button size="sm" variant="outline">
            Copy the link for an admin
          </Button>
        }
      >
        The Stationly GitHub app lost access to it. An admin of {repo.split('/')[0]} adds it back in
        GitHub settings, then you can start the task.
      </Notice>
    )
  }

  return null
}

function Composer({
  project,
  prefill,
  fork,
  go,
}: {
  project: string | null
  prefill?: string
  fork?: Task
  go: Props['go']
}) {
  const story = useStory()
  const { tasks } = useWorld()
  const repos = (project ? projects.filter((p) => p.id === project) : projects).flatMap(
    (p) => p.repos,
  )
  const [picked, setPicked] = useState('claude')
  const [repo, setRepo] = useState(repos[0]!)
  const blocked = (picked === 'codex' && !yourKeys.codex) || unreachableRepos.includes(repo)
  const running = tasks.filter((t) => t.state === 'working' || t.state === 'waiting').length
  const queued = running >= 3
  const owner = fork?.owner === 'you' ? 'this' : `${fork?.owner}'s`

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-8">
      <PixelScene
        slots={3}
        running={Math.min(running, 3)}
        queued={tasks.filter((t) => t.state === 'queued').length}
        live
        className="h-40 border"
      />
      <h1 className="font-display text-2xl">
        {fork ? `Fork ${owner} task` : prefill ? 'Fix the failed deploy' : 'What should we build?'}
      </h1>
      <PromptInput
        onSubmit={() => {
          if (blocked) {
            return
          }

          if (fork) {
            story.fork(fork.id)
            go({
              mode: 'build',
              project: fork.project,
              view: forkId(fork.id),
            })
          } else if (prefill) {
            story.to('fixing')
            go({
              mode: 'build',
              project: 'etherbit',
              view: 'fixv42',
            })
          }
        }}
      >
        <PromptInputBody>
          <PromptInputTextarea
            defaultValue={prefill}
            placeholder={
              fork
                ? 'What should change from this version?'
                : 'Describe the task. An agent works on it on a new branch and shows you what it changed.'
            }
          />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputTools>
            <PromptInputSelect value={picked} onValueChange={setPicked}>
              <PromptInputSelectTrigger aria-label="Agent">
                <PromptInputSelectValue />
              </PromptInputSelectTrigger>
              <PromptInputSelectContent>
                <PromptInputSelectItem value="claude">Claude Code</PromptInputSelectItem>
                <PromptInputSelectItem value="codex">Codex</PromptInputSelectItem>
              </PromptInputSelectContent>
            </PromptInputSelect>
            {fork ? (
              <Meta icon={GitBranch} label="Starts from">
                task/{fork.id}
              </Meta>
            ) : (
              <PromptInputSelect value={repo} onValueChange={setRepo}>
                <PromptInputSelectTrigger aria-label="Repository">
                  <PromptInputSelectValue />
                </PromptInputSelectTrigger>
                <PromptInputSelectContent>
                  {repos.map((r) => (
                    <PromptInputSelectItem key={r} value={r}>
                      {r}
                    </PromptInputSelectItem>
                  ))}
                </PromptInputSelectContent>
              </PromptInputSelect>
            )}
          </PromptInputTools>
          <PromptInputSubmit disabled={blocked} />
        </PromptInputFooter>
      </PromptInput>
      <Blocker agent={picked} repo={repo} go={go} />
      {queued && !blocked && (
        <Notice tone="neutral" title="It waits in line">
          {running} tasks are running on this project&apos;s machine, so this one starts when one
          finishes.
        </Notice>
      )}
      <p className="text-sm text-muted-foreground">
        {fork
          ? `Starts from task/${fork.id} with ${fork.owner === 'you' ? 'your' : `${fork.owner}'s`} conversation. It runs on your keys and stays private to you.`
          : prefill
            ? 'Starts from task/integer-paise, the branch that failed, with the deploy log and diagnosis. The fix comes back as an approval before it reaches production.'
            : `Runs in project ${project ?? 'etherbit'} on a new branch, with your ${picked === 'codex' ? 'Codex' : 'Claude'} key. Anything that needs approval is stopped and shown to you.`}
      </p>
      {!prefill && !fork && <YourWeek />}
    </div>
  )
}
