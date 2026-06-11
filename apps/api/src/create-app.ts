import { NestFactory } from '@nestjs/core'
import type { INestApplication } from '@nestjs/common'
import { AppModule } from './app.module'

/**
 * NestJS アプリケーションファクトリ。
 *
 * main.ts（ローカル listen）と api/index.ts（Vercel serverless）の双方から呼び出し、
 * global prefix 等のアプリ構成ロジックを単一の真実の源（SSoT）に集約する。
 *
 * 注意:
 * - `app.listen()` / `app.init()` は呼び出し側の責務（serverless では listen 不要 / init のみ）。
 * - prefix 設計は phase-1 設計書 §3.1 Base URL `/api/v1` を踏襲し、liveness `/health` を除外。
 *
 * 参考: https://docs.nestjs.com/faq/serverless
 */
export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
  })

  // RAG API は /api/v1 配下（phase-1 設計書 §3.1）。
  // インフラ用 liveness `/health` は prefix 対象外として残す。
  app.setGlobalPrefix('api/v1', { exclude: ['health'] })

  return app
}
