const UPSTREAM =
  'https://github.com/RevealUIStudio/revdev/releases/download/studio-latest/latest.json';

export const config = { runtime: 'edge' };

/**
 * Baked-in Studio updater URL must return JSON, not a GitHub asset 302.
 * GitHub `studio-latest` stays the authored feed. This host is the stable edge.
 */
export default async function handler() {
  const upstream = await fetch(UPSTREAM, {
    headers: { 'user-agent': 'revealui-studio-releases' },
    redirect: 'follow',
  });
  if (!upstream.ok) {
    return Response.json(
      { error: 'updater feed unavailable', status: upstream.status },
      { status: 502 },
    );
  }

  const body = await upstream.text();
  try {
    JSON.parse(body);
  } catch {
    return Response.json({ error: 'updater feed was not JSON' }, { status: 502 });
  }

  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=60, s-maxage=60',
    },
  });
}
