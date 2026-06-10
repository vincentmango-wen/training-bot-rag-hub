import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
  })

  // RAG API は /api/v1 配下（10 §3.1 Base URL）。
  // 既存のインフラ用 liveness `/health`（health.controller）は prefix 対象外として残す。
  app.setGlobalPrefix('api/v1', { exclude: ['health'] })

  const port = Number(process.env.PORT ?? 3000)

  await app.listen(port)
}

void bootstrap()