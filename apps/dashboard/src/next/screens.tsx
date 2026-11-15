import { Card } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { Tone } from '@/lib/tone'

import { Section, StatusPill } from './parts'

type Home = 'Build' | 'Ship' | 'Observe' | 'Outside'

type Backend = 'exists' | 'rename' | 'new'

type Screen = {
  screen: string
  note?: string
  backend: Backend
  uses: string
}

const backendTone: Record<Backend, Tone> = {
  exists: 'success',
  rename: 'info',
  new: 'warning',
}

const homes: { home: Home; rule: string; screens: Screen[] }[] = [
  {
    home: 'Build',
    rule: 'Work an agent does: starting it, steering it, answering it.',
    screens: [
      {
        screen: 'New task composer',
        note: 'empty home shows the setup checklist until it is done',
        backend: 'new',
        uses: 'POST /agent-sessions starts a session in an existing workspace; a task record that picks the project machine, repo and agent is new',
      },
      {
        screen: 'A task: working, finished, setting up, could not start, queued',
        backend: 'new',
        uses: 'session events, prompts and interrupt exist under /sandboxes/:sandbox/agent; the task record, its branch and the queue on full slots are new',
      },
      {
        screen: 'A teammate’s shared task, with Fork',
        backend: 'new',
        uses: 'every agent route is instance admin only today; visibility, collaborators and fork from stored events are new',
      },
      {
        screen: 'Agent question card, command approval card',
        note: 'the cards live in the task; the Inbox links to them',
        backend: 'new',
        uses: 'the PermissionRequest approval record and decide endpoint (plan step 3)',
      },
      {
        screen: 'Missing Claude key, unreachable repository',
        note: 'shown in the composer, where they block',
        backend: 'new',
        uses: 'member keys are new; GET /v1/github/installations/:id/repositories exists for the repo check',
      },
      {
        screen: 'Share and Delete dialogs',
        backend: 'new',
        uses: 'task sharing and task delete',
      },
      {
        screen: 'Fix with an agent',
        note: 'a prefilled composer, opened from Ship and Observe',
        backend: 'exists',
        uses: 'GET /deployments/:id/diagnosis already writes the agent prompt; it opens the new composer',
      },
      {
        screen: 'Rooms',
        note: 'later',
        backend: 'new',
        uses: 'not specced',
      },
    ],
  },
  {
    home: 'Ship',
    rule: 'What runs for users and every change on its way to production.',
    screens: [
      {
        screen: 'Projects overview (All projects)',
        note: 'replaces the separate Projects page',
        backend: 'exists',
        uses: 'GET /projects, GET /projects/:project/environments, GET /environments/:environment/services',
      },
      {
        screen: 'Production apps, Previews',
        backend: 'rename',
        uses: 'environments become production and previews; PR environments from the GitHub App already create previews',
      },
      {
        screen: 'An app, including stopped, and its Settings, storage and backups',
        note: 'admin-only settings',
        backend: 'rename',
        uses: 'services become apps: /services/:service, start, stop, restart, ports, domains, volumes and backups',
      },
      {
        screen: 'New app, Use a shared app',
        backend: 'rename',
        uses: 'POST /environments/:environment/services and the shared service flag',
      },
      {
        screen: 'Approvals: review a change, your own change, a key change',
        note: 'one screen, three cases',
        backend: 'new',
        uses: 'staged changes with accept and reject exist; a task’s change as a staged change, and approval by someone other than the requester, are new',
      },
      {
        screen: 'A deploy: deploying and failed',
        note: 'a deploy is a Ship record; Observe links to it',
        backend: 'exists',
        uses: 'GET /deployments/:id, steps, wait, diagnosis, cancel, rollback',
      },
      {
        screen: 'Project keys',
        note: 'what apps read; your own Claude and GitHub keys live in Your account',
        backend: 'exists',
        uses: 'project and service variables, sealed values, grants and versions',
      },
    ],
  },
  {
    home: 'Observe',
    rule: 'Knowing what happened and why: failures, logs, metrics, who changed what.',
    screens: [
      {
        screen: 'Needs attention',
        note: 'failed deploys, slow requests, errors',
        backend: 'new',
        uses: 'failed deploys and health checks exist; one attention list across them is new',
      },
      {
        screen: 'Logs, metrics',
        note: 'the app page links here, scoped to that app',
        backend: 'exists',
        uses: 'GET /logs, service and environment metrics',
      },
      {
        screen: 'Activity log',
        note: 'scoped by the project picker; All projects is the whole team',
        backend: 'exists',
        uses: 'GET /audit, with the actor kinds it already records',
      },
    ],
  },
  {
    home: 'Outside',
    rule: 'Things about people and the installation, from the bell or the account menu.',
    screens: [
      {
        screen: 'Inbox',
        note: 'Build’s Waiting on you, Ship’s Waiting for approval and Observe’s Needs attention, for things you can act on',
        backend: 'new',
        uses: 'session attention kinds and staged changes exist; routing each item to the people who can act is new',
      },
      {
        screen: 'Your account',
        note: 'your keys, notifications, devices, version',
        backend: 'new',
        uses: 'personal tokens and renew exist for devices; member keys and email preferences are new',
      },
      {
        screen: 'Team: members, access, remove, invite',
        backend: 'new',
        uses: 'only the user table and its role column exist; members, project access, invites and removal are new',
      },
      {
        screen: 'Assistants and connecting one',
        backend: 'rename',
        uses: 'tokens and /mcp OAuth exist; the three levels map onto today’s scopes',
      },
      {
        screen: 'Servers: what uses a server, add one, release and upgrade, plain machines',
        note: 'admin',
        backend: 'rename',
        uses: 'stations become servers: /stations, /inventory, /doctor, /platform/releases, /platform/upgrade',
      },
      {
        screen: 'Settings: general, GitHub, team keys, tokens, notifications',
        note: 'admin',
        backend: 'exists',
        uses: '/settings, /v1/github, global variables, /tokens, notification channels',
      },
      {
        screen: 'Project settings',
        note: 'from the project picker’s menu, since it applies to all three modes',
        backend: 'exists',
        uses: 'PATCH and DELETE /projects/:project',
      },
      {
        screen: 'Join page',
        note: 'public, before sign-in',
        backend: 'new',
        uses: 'invite links; GitHub sign-in for members replaces magic links',
      },
    ],
  },
]

const counts = (Object.keys(backendTone) as Backend[]).map((backend) => ({
  backend,
  count: homes.flatMap((h) => h.screens).filter((s) => s.backend === backend).length,
}))

export function ScreenMap() {
  return (
    <Section title="Where every screen lives" note="each screen has exactly one home">
      <div className="flex flex-wrap gap-2">
        {counts.map((c) => (
          <StatusPill key={c.backend} tone={backendTone[c.backend]}>
            {c.count} {c.backend}
          </StatusPill>
        ))}
      </div>
      <Card className="py-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-28">Home</TableHead>
              <TableHead>Screen</TableHead>
              <TableHead className="w-24">Backend</TableHead>
              <TableHead>What it uses</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {homes.flatMap((h) => [
              <TableRow key={h.home}>
                <TableCell className="font-display text-base">{h.home}</TableCell>
                <TableCell colSpan={3} className="text-muted-foreground">
                  {h.rule}
                </TableCell>
              </TableRow>,
              ...h.screens.map((s) => (
                <TableRow key={h.home + s.screen}>
                  <TableCell />
                  <TableCell className="align-top whitespace-normal">
                    {s.screen}
                    {s.note && (
                      <div className="font-mono text-xs text-muted-foreground">{s.note}</div>
                    )}
                  </TableCell>
                  <TableCell className="align-top">
                    <StatusPill tone={backendTone[s.backend]}>{s.backend}</StatusPill>
                  </TableCell>
                  <TableCell className="align-top font-mono text-xs whitespace-normal text-muted-foreground">
                    {s.uses}
                  </TableCell>
                </TableRow>
              )),
            ])}
          </TableBody>
        </Table>
      </Card>
    </Section>
  )
}
