import 'reflect-metadata'
import { createApp } from './create-app'

async function bootstrap(): Promise<void> {
  // bootstrap 共通化: アプリ構成（global prefix 等）は createApp() に集約。
  // 本ファイルはローカル listen 専用エントリ（Vercel serverless 側は apps/api/api/index.ts）。
  const app = await createApp()

  const port = Number(process.env.PORT ?? 3000)

  await app.listen(port)
}

void bootstrap()
