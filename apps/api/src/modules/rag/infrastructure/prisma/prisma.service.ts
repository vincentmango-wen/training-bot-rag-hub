import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common'
import { PrismaClient } from '@prisma/client'

/**
 * Prisma クライアントを NestJS ライフサイクルに接続する Service。
 *
 * - onModuleInit で $connect、onModuleDestroy で $disconnect。
 * - pgvector を使う ANN 検索は Prisma 標準型で表現できないため `$queryRaw` 運用
 *   （05 §9.4 / §8.1）。本 Service の `prisma` インスタンス経由で raw クエリを発行する。
 * - DATABASE_URL の schema は public（pgvector 拡張が public 常駐 / vector 型・演算子が
 *   search_path に解決される）。order_permission の一次防御は DB ロール GRANT 物理遮断
 *   （schema 非依存 / 05 §2.4.3）。
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  async onModuleInit(): Promise<void> {
    await this.$connect()
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect()
  }
}
