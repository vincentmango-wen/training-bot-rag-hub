import { Global, Module } from '@nestjs/common'
import { PrismaService } from './prisma.service'

/**
 * PrismaService を global provider として公開する Module。
 * RAG モジュール全体（repository / usecase / worker）から DI で利用する。
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
