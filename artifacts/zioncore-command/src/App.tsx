import { type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';
import { Shell } from '@/components/shell';
import Dashboard from '@/pages/dashboard';
import EnginePage from '@/pages/engine';
import ResearchPage from '@/pages/research';
import RunsPage from '@/pages/runs';
import RunPage from '@/pages/run';
import GenesisPage from '@/pages/genesis';
import ContinuityPage from '@/pages/continuity';
import KnowledgePage from '@/pages/knowledge';

const queryClient = new QueryClient();

function Router() {
  return (
    <Shell>
      <RoutedErrorBoundary>
        <Switch>
          <Route path="/" component={Dashboard} />
          <Route path="/command.html" component={Dashboard} />
          <Route path="/engines/:id" component={EnginePage} />
          <Route path="/research" component={ResearchPage} />
          <Route path="/knowledge" component={KnowledgePage} />
          <Route path="/runs" component={RunsPage} />
          <Route path="/runs/:id" component={RunPage} />
          <Route path="/genesis" component={GenesisPage} />
          <Route path="/continuity" component={ContinuityPage} />
          <Route component={NotFound} />
        </Switch>
      </RoutedErrorBoundary>
    </Shell>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
