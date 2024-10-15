import { Ratelimit } from '@upstash/ratelimit' // for deno: see above
import { Redis } from '@upstash/redis/cloudflare'
import { Context } from 'hono'
import type { Env } from './worker-configuration'

// The maximum age of a cached value that we will serve
const SERVE_STALE_INTERVAL = 24 * 60 * 60 * 1000 // 1 hour
// The maximum age of a requested cached value before we rebuild it (in the background)
const REBUILD_MAX_TTL = SERVE_STALE_INTERVAL - 5 * 60 * 1000 // 55 minutes

export const lighthouse = async (ctx: Context<{ Bindings: Env }>) => {
  let lighthouseUrl: URL
  try {
    const body = await ctx.req.json()
    lighthouseUrl = new URL(body?.url)
  } catch {
    return Response.json({ error: 'Invalid request' }, { status: 400 })
  }
  const [ttl, result] = await Redis.fromEnv(ctx.env)
    .multi()
    .pttl(lighthouseUrl.href)
    .get<Record<string, any>>(lighthouseUrl.href)
    .exec()
  if (result && ttl > 0) {
    if (ttl < REBUILD_MAX_TTL) {
      // Rebuild cache in the background
      console.log('Rebuilding cache (in background) for', lighthouseUrl.href)
      ctx.executionCtx.waitUntil(callLighthouse(lighthouseUrl.href, ctx, true))
    }
    return Response.json(result)
  }
  // Create a new ratelimiter, that allows 5 requests per 60 seconds per ip address
  const ratelimit = new Ratelimit({
    redis: Redis.fromEnv(ctx.env),
    limiter: Ratelimit.slidingWindow(5, '60 s'),
    analytics: true,
    prefix: 'RATELIMIT:',
  })
  const ip =
    ctx.req.raw.headers.get('x-real-ip') ??
    ctx.req.raw.headers.get('cf-connecting-ip')
  const { success } = await ratelimit.limit(ip)
  if (!success) {
    return Response.json({ error: 'Rate limit exceeded' }, { status: 429 })
  }
  const data = await callLighthouse(lighthouseUrl.href, ctx, false)
  if (data) {
    return Response.json(data)
  }
  return Response.json(
    { error: 'Failed to fetch Lighthouse score' },
    { status: 500 },
  )
}

const callLighthouse = async (
  url: string,
  ctx: Context<{ Bindings: Env }>,
  background: boolean,
) => {
  console.log('Calling Lighthouse for url:', url)
  if (background) {
    // Check if we started a background lighthouse request less than 30 seconds ago for this url
    const lastRequest = await Redis.fromEnv(ctx.env).get('lh:' + url)
    if (lastRequest === true) {
      console.log('Skipping Lighthouse request for url: ', url)
      return
    }
  }
  // Save a record that we started a lighthouse request for this url
  await Redis.fromEnv(ctx.env).set('lh:' + url, true, { px: 30 * 1000 })
  try {
    const response = await fetch(
      `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?key=${ctx.env.PAGESPEED_API_KEY}&category=performance&url=${url}`,
    )
    if (!response.ok) {
      console.warn('Lighthouse score request was not successful for url:', url)
      return
    }
    const data = await response.json()
    // Persist the result to Redis cache in the background
    console.log('Caching result for url: ', url)
    ctx.executionCtx.waitUntil(
      Redis.fromEnv(ctx.env).set(url, data, { px: SERVE_STALE_INTERVAL }),
    )
    return data
  } catch {
    console.warn('Failed to fetch Lighthouse score for url:', url)
    return
  }
}
