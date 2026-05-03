import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Pool } from "pg";
import { ApiModule } from "./api/app.module.js";
import { applyPostgresSchema } from "./persistence/postgres/schema.js";

const port = Number(process.env.PORT ?? 3000);
const database = new Pool({
  connectionString: process.env.DATABASE_URL,
});

await applyPostgresSchema(database);

const app = await NestFactory.create(ApiModule.register({ database }));
app.enableCors({ origin: true });
await app.listen(port);
