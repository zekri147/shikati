import type { Env } from './env';
import { assertSameOrigin, errorResponse, HttpError, json } from './http';
import { currentUser, login, logout, requireUser } from './auth';
import { handleAdmin } from './admin';
import { modules } from './modules';
import { handleSetup, setupAvailable } from './setup';

async function handleApi(req: Request, env: Env, path: string): Promise<Response> {
  assertSameOrigin(req);

  if (path === '/api/login' && req.method === 'POST') return login(req, env);
  if (path === '/api/logout' && req.method === 'POST') return logout(req, env);
  if (path === '/api/setup' && req.method === 'POST') return handleSetup(req, env);

  if (path === '/api/me' && req.method === 'GET') {
    const user = await requireUser(req, env);
    return json({
      user: { username: user.username, display_name: user.display_name, role: user.role },
      modules: modules.filter((m) => m.roles.includes(user.role)).map((m) => ({ id: m.id, title: m.title })),
    });
  }

  if (path.startsWith('/api/admin/')) {
    const admin = await requireUser(req, env, ['admin']);
    return handleAdmin(req, env, admin, path.slice('/api/admin'.length));
  }

  const m = path.match(/^\/api\/m\/([a-z0-9-]+)(\/.*)?$/);
  if (m) {
    const mod = modules.find((x) => x.id === m[1]);
    if (!mod) throw new HttpError(404, 'غير موجود.');
    const user = await requireUser(req, env, mod.roles);
    return mod.handle(req, env, user, m[2] || '');
  }

  throw new HttpError(404, 'غير موجود.');
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(req, env, url.pathname);

      // الصفحات: من لم يسجّل الدخول يُحوَّل إلى صفحة الدخول
      if (url.pathname === '/' || url.pathname === '/admin') {
        const user = await currentUser(req, env);
        if (!user) return Response.redirect(new URL('/login', url).toString(), 302);
        if (url.pathname === '/admin' && user.role !== 'admin') {
          return Response.redirect(new URL('/', url).toString(), 302);
        }
        return env.ASSETS.fetch(new Request(new URL(url.pathname === '/' ? '/app.html' : '/admin.html', url), req));
      }
      if (url.pathname === '/setup') {
        if (!(await setupAvailable(env))) return Response.redirect(new URL('/login', url).toString(), 302);
        return env.ASSETS.fetch(new Request(new URL('/setup.html', url), req));
      }
      if (url.pathname === '/help') {
        return env.ASSETS.fetch(new Request(new URL('/help.html', url), req));
      }
      if (url.pathname === '/login') {
        return env.ASSETS.fetch(new Request(new URL('/login.html', url), req));
      }
      return env.ASSETS.fetch(req);
    } catch (e) {
      return errorResponse(e);
    }
  },
} satisfies ExportedHandler<Env>;
