import { createApp } from './app';
import { config } from './config';

const { server, io, rooms } = await createApp(config);

server.listen(config.port, () => {
  console.log(`Image Bracket listening on :${config.port}`);
  console.log(`  data dir:   ${config.dataDir}`);
  console.log(`  public URL: ${config.publicUrl ?? '(from request host)'}`);
});

let closing = false;
function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  console.log(`${signal} received, shutting down`);
  rooms.stop();
  io.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
