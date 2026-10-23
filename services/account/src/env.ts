export type Env = Cloudflare.Env & {
  GOOGLE_CLIENT_SECRET: string
}

export interface User {
  id: string
  email: string
}

export type AppEnv = {
  Bindings: Env
  Variables: {
    user: User
    sessionId: string
  }
}
