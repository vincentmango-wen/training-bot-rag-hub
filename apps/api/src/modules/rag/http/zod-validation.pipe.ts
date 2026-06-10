/**
 * ZodValidationPipe — packages/shared の Zod schema で request body / query を検証する。
 *
 * 失敗時は ZodError を投げ、RagExceptionFilter が RAG_VALIDATION_ERROR(400) +
 * details[{field,code,message}] へ写像する（10 §3.4 / §5.3 共通完了条件）。
 *
 * controller では `@Body(new ZodValidationPipe(queryRequestSchema))` のように使う。
 * DTO クラスは作らず、Zod を SSoT のまま検証境界に通す（enum SSoT / 値リテラル再宣言なし）。
 */
import { Injectable, type PipeTransform } from '@nestjs/common'
import type { ZodTypeAny, infer as ZodInfer } from 'zod'

@Injectable()
export class ZodValidationPipe<TSchema extends ZodTypeAny>
  implements PipeTransform<unknown, ZodInfer<TSchema>>
{
  constructor(private readonly schema: TSchema) {}

  transform(value: unknown): ZodInfer<TSchema> {
    // parse は失敗時 ZodError を throw（filter が写像）。成功時は型付き値を返す。
    return this.schema.parse(value) as ZodInfer<TSchema>
  }
}
