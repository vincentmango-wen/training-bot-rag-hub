import { Module } from '@nestjs/common'

import { PrismaModule } from '../modules/rag/infrastructure/prisma/prisma.module'
import { RetrievalService } from './retrieval.service'

/**
 * Retrieval モジュール（05 §8.1 検索 / §5.9 永続化）。
 * PrismaModule（@Global）から PrismaService を解決する。
 */
@Module({
  imports: [PrismaModule],
  providers: [RetrievalService],
  exports: [RetrievalService],
})
export class RetrievalModule {}
