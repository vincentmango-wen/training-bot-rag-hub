// Vercel Functions エントリ（@vercel/node ランタイム）
//
// 設計判断（phase-2-design.md §3 判断 1 / 案 A 採用）:
// Vercel の Node ランタイムは素の (req, res) をハンドラに渡すため、Lambda イベント変換層
// （@vendia/serverless-express 等）は不要かつ不適合。NestJS 内蔵の express インスタンスを
// `app.getHttpAdapter().getInstance()` で取り出して直接呼び出す。
//
// 冪等性ガード（phase-2-design.md §5）:
// - G-1: 並行初期化レース対策 — app ではなく「初期化 Promise」を module-level でキャッシュ
//         することで、bootstrap は高々 1 回に制限される（同一関数インスタンスへの並行リクエスト）
// - G-2: 初期化失敗時の恒久 500 化対策 — reject 時は appPromise を undefined に戻し、
//         次 invocation で bootstrap を再試行する。エラーは console.error に残す（握り潰さない）
//
// 参考:
// - Vercel Node.js Runtime: https://vercel.com/docs/functions/runtimes/node-js
// - NestJS Serverless FAQ: https://docs.nestjs.com/faq/serverless

import 'reflect-metadata'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { INestApplication } from '@nestjs/common'
import { createApp } from '../src/create-app'

// G-1: app インスタンスではなく初期化 Promise をキャッシュ。
// 2 リクエスト目以降は同一 Promise を await するため bootstrap は重複しない。
let appPromise: Promise<INestApplication> | undefined

async function getApp(): Promise<INestApplication> {
  if (!appPromise) {
    appPromise = createApp()
      .then(async (app) => {
        // serverless では listen は呼ばない（ソケット bind は Vercel の責務）。
        // init() のみで DI コンテナ初期化を完了させる。
        await app.init()
        return app
      })
      .catch((err) => {
        // G-2: 初期化失敗を握り潰さずログに残し、キャッシュをリセットして
        // 次 invocation での再 bootstrap を許可する。
        console.error('[vercel-handler] Nest app initialization failed:', err)
        appPromise = undefined
        throw err
      })
  }
  return appPromise
}

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const app = await getApp()
  const expressInstance = app.getHttpAdapter().getInstance()
  // Vercel の (req, res) を express ハンドラへ素通し。
  // express 内部の router が NestJS のルートテーブルに従って dispatch する。
  expressInstance(req, res)
}
