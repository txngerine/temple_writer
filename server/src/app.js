import cors from 'cors';
import express from 'express';
import adminRouter from './routes/admin/index.js';
import deviceRouter from './routes/device/index.js';

export function createApp() {
  const app = express();
  const origins = (process.env.WEB_ORIGIN || 'http://localhost:5173').split(',').map((s) => s.trim());
  app.use(cors({ origin: origins }));
  app.use(express.json({ limit: '2mb' }));

  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use('/device/v1', deviceRouter);
  app.use('/admin', adminRouter);

  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Server error' : err.message });
  });
  return app;
}
