import { createApp } from "./app";

const app = createApp().listen({ hostname: "0.0.0.0", port: 8080 });
console.log(`Gym membership API listening on ${app.server?.hostname}:${app.server?.port}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await app.stop();
    process.exit(0);
  });
}
