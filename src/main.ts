import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // ✅ Augmenter le timeout HTTP à 5 minutes
  const server = app.getHttpServer();
  server.setTimeout(8 * 60 * 1000); // 5 minutes
  server.keepAliveTimeout = 5 * 60 * 1000;
  server.headersTimeout = 5 * 60 * 1000 + 1000;

  const port = process.env.PORT || 3000;
  await app.listen(port, '0.0.0.0');
  console.log(`Application running on port ${port}`);
}

bootstrap();
