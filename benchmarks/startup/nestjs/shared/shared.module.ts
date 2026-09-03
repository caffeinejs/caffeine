import { Module } from '@nestjs/common'

import { LoggerService } from './logger.service.js'
import { NotifierService } from './notifier.service.js'

@Module({
  providers: [
    LoggerService,
    {
      provide: NotifierService,
      useFactory: (logger: LoggerService) => new NotifierService(logger),
      inject: [LoggerService],
    },
  ],
  exports: [LoggerService, NotifierService],
})
export class SharedModule {}
