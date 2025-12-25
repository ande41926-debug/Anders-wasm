// Simple client-side router
import { init as initAstar } from './routes/astar';
import { init as initPreprocess } from './routes/preprocess';

type RouteHandler = () => Promise<void>;

const routes: Map<string, RouteHandler> = new Map();

// Register routes
routes.set('/astar', initAstar);
routes.set('/preprocess', initPreprocess);

async function route(): Promise<void> {
  const path = window.location.pathname;
  
  // Root path shows landing page - no handler needed
  if (path === '/') {
    return;
  }
  
  // Try exact match first
  let handler = routes.get(path);
  
  // If no exact match, try to find a route that matches the start
  if (!handler) {
    for (const [routePath, routeHandler] of routes.entries()) {
      if (path.startsWith(routePath) && routePath !== '/') {
        handler = routeHandler;
        break;
      }
    }
  }
  
  // Also check for /pages/*.html paths (for direct HTML file access in dev)
  if (!handler) {
    if (path.includes('preprocess')) {
      handler = routes.get('/preprocess');
    } else if (path.includes('astar')) {
      handler = routes.get('/astar');
    }
  }
  
  if (handler) {
    try {
      await handler();
    } catch (error) {
      const errorDiv = document.getElementById('error');
      if (errorDiv) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        errorDiv.textContent = `Error: ${message}`;
      }
    }
  }
}

// Initialize router when DOM is ready
const initRouter = (): void => {
  route().catch((error) => {
    const errorDiv = document.getElementById('error');
    if (errorDiv) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      errorDiv.textContent = `Error: ${message}`;
    }
  });
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initRouter);
} else {
  initRouter();
}
