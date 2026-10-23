import { Hono } from 'hono'
import type { AppEnv } from './env'
import { notFound, onError } from './http'
import { apiRoutes } from './routes/api'
import { loginRoutes } from './routes/login'

const app = new Hono<AppEnv>()

app.onError(onError)
app.notFound(notFound)

app.route('/', loginRoutes)
app.route('/', apiRoutes)

export default app
