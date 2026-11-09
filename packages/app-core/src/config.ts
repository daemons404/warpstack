import { z } from 'zod'

/** Parsed at startup: a bad config fails before the first screen, naming the field and the fix. */
export const AppConfig = z.object({
  apiUrl: z.url({ protocol: /^https?$/, error: 'apiUrl must be the deployment origin, such as https://reader.example.app' }),
  appName: z.string().min(1).max(40).default('Warpstack'),
})
export type AppConfig = z.infer<typeof AppConfig>

export const parseAppConfig = (input: unknown): AppConfig => {
  const r = AppConfig.safeParse(input)
  if (!r.success) throw new Error(`Invalid app config: ${r.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  return r.data
}
