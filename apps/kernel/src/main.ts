import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module.js';
import { loadConfig } from './config.js';
import { loadDotenv } from './dotenv.js';

loadDotenv();
const config = loadConfig();

const app = await NestFactory.create(AppModule);
app.enableShutdownHooks();
await app.listen(config.PORT);
