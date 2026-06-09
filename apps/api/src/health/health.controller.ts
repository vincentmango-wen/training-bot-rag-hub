import { Controller, Get } from '@nestjs/common'

type HealthResponse = {
  status: 'ok'
  service: 'training-bot-rag-hub-api'
}

@Controller('health')
export class HealthController {
  @Get()
  getHealth(): HealthResponse {
    return {
      status: 'ok',
      service: 'training-bot-rag-hub-api',
    }
  }
}