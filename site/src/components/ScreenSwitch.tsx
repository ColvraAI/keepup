'use client';

import type { Route } from '@/lib/routes';
import { ConnectScreen } from '@/screens/Connect';
import { KeepsUpScreen } from '@/screens/KeepsUp';
import { MondayScreen } from '@/screens/Monday';
import { MoonshotScreen } from '@/screens/Moonshot';
import { HomeScreen } from '@/screens/Home';
import { PullRequestsScreen } from '@/screens/PullRequests';
import { PulseScreen } from '@/screens/Pulse';
import { RealScreen } from '@/screens/Real';
import { RepoScreen } from '@/screens/Repo';
import { ReplayScreen } from '@/screens/Replay';
import { UnderstoodScreen } from '@/screens/Understood';

/** Every screen is already in the bundle: changing screens never waits on anything. */
export function ScreenSwitch({ route }: { route: Route }) {
  switch (route.screen) {
    case 'pulse':
      return <PulseScreen key="pulse" />;
    case 'connect':
      return <ConnectScreen key="connect" />;
    case 'understood':
      return <UnderstoodScreen key={`understood-${route.arg ?? ''}`} arg={route.arg} />;
    case 'replay':
      return <ReplayScreen key="replay" />;
    case 'pr':
      return <PullRequestsScreen key="pr" arg={route.arg} />;
    case 'keeps-up':
      return <KeepsUpScreen key="keeps-up" />;
    case 'monday':
      return <MondayScreen key="monday" />;
    case 'moonshot':
      return <MoonshotScreen key="moonshot" />;
    case 'repo':
      return <RepoScreen key={`repo-${route.arg ?? ''}`} arg={route.arg} />;
    case 'real':
      return <RealScreen key="real" />;
    default:
      return <HomeScreen key="overview" />;
  }
}
