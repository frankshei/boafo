import pg from "pg";

const pool = new pg.Pool({
  host: process.env.PG_HOST ?? "localhost",
  port: Number(process.env.PG_PORT ?? 5432),
  database: process.env.DATABASE ?? "cb",
  user: process.env.PG_USER ?? "postgres",
  password: process.env.PG_PASSWORD ?? "",
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  ...(process.env.PG_SSL === "true" ? { ssl: { rejectUnauthorized: true } } : {}),
});

pool.on("connect", (client) => {
  client.query("SET ivfflat.probes = 10");
});

export default pool;
