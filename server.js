require('dotenv').config();
const express = require('express');
const path = require('path');
const SDPDataMapper = require('./sdp-mapper');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const mapper = new SDPDataMapper(
  process.env.SDP_CLIENT_ID,
  process.env.SDP_CLIENT_SECRET,
  process.env.SDP_REFRESH_TOKEN,
  process.env.SDP_SUBDOMAIN || 'soporte',
  process.env.SDP_DOMAIN    || 'kashio.net',
  process.env.SDP_PORTAL    || 'itdesk'
);

// ===== ENDPOINTS =====

app.get('/health', (req, res) => res.json({
  status: 'OK', timestamp: new Date().toISOString(),
  mapper: mapper.getAllTickets().length > 0 ? 'ready' : 'empty'
}));

app.get('/api/status', (req, res) => res.json({
  totalTickets: mapper.getAllTickets().length,
  yearsAvailable: mapper.getYearsAvailable(),
  syncProgress: mapper.syncProgress,
  lastIncrementalSync: mapper.cacheInfo[new Date().getFullYear()]?.syncedAt || null
}));

// Años disponibles en caché
app.get('/api/years', (req, res) => res.json(mapper.getYearsAvailable()));

// Exportar tickets (todos los años en caché)
app.get('/api/export', (req, res) => res.json(mapper.exportForAnalysis()));

// Exportar solo un año específico
app.get('/api/export/:year', (req, res) => {
  const year = parseInt(req.params.year);
  const tickets = mapper.cache[year] || [];
  res.json({ year, total: tickets.length, tickets });
});

// ===== SYNC ENDPOINTS =====

// Progreso del sync en tiempo real
app.get('/api/sync/progress', (req, res) => res.json(mapper.syncProgress));

// Sync de un año específico
app.post('/api/sync/year/:year', async (req, res) => {
  const year = parseInt(req.params.year);
  if (isNaN(year) || year < 2020 || year > 2030)
    return res.status(400).json({ error: 'Año inválido' });

  if (mapper.syncProgress.status === 'running')
    return res.status(409).json({ error: `Sync en progreso: ${mapper.syncProgress.year}`, progress: mapper.syncProgress });

  // Si ya está en caché completo, devolver inmediatamente
  if (mapper.cache[year]?.length > 0 && mapper.cacheInfo[year]?.complete)
    return res.json({ message: 'Ya en caché', year, total: mapper.cache[year].length, cached: true });

  // Iniciar sync en background
  res.json({ message: `Sync ${year} iniciado en background`, year });
  mapper.syncYear(year).catch(e => console.error(`❌ Error sync ${year}:`, e.message));
});

// Sync incremental manual
app.post('/api/sync', async (req, res) => {
  try {
    await mapper.incrementalSync();
    res.json({ success: true, totalTickets: mapper.getAllTickets().length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Token debug
app.get('/api/token', (req, res) => res.json({ accessToken: mapper.accessToken }));

// ===== 404 =====
app.use((req, res) => res.status(404).json({ error: 'Endpoint no encontrado' }));
app.use((err, req, res, next) => res.status(500).json({ error: err.message }));

// ===== INICIO =====
const PORT = process.env.PORT || 3000;
const SYNC_INTERVAL = parseInt(process.env.SYNC_INTERVAL || '15');

app.listen(PORT, async () => {
  console.log('\n' + '='.repeat(60));
  console.log('🚀 KASHIO SDP DASHBOARD V3 - Lazy Loading por Año');
  console.log('='.repeat(60));
  console.log(`📍 http://localhost:${PORT}`);
  console.log('\n📡 ENDPOINTS:');
  console.log('  GET  /api/export            - Todos los tickets en caché');
  console.log('  GET  /api/export/:year      - Tickets de un año');
  console.log('  GET  /api/years             - Años disponibles en caché');
  console.log('  GET  /api/status            - Estado del servidor');
  console.log('  GET  /api/sync/progress     - Progreso del sync actual');
  console.log('  POST /api/sync/year/:year   - Sync de un año específico');
  console.log('  POST /api/sync              - Sync incremental');
  console.log('='.repeat(60) + '\n');

  await mapper.initialSync();

  setInterval(() => mapper.incrementalSync(), SYNC_INTERVAL * 60 * 1000);
  console.log(`🔄 Auto-sync incremental cada ${SYNC_INTERVAL} minutos\n`);
});
