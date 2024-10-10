import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { secureHeaders } from 'hono/secure-headers'
import { lighthouse } from 'lighthouse'

const app = new Hono()
app.use(secureHeaders())
app.use('/api/*', cors())
app.post('/api/lighthouse', lighthouse)

export default app
