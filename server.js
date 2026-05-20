require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const SDPDataMapper = require('./sdp-mapper');

const app = express();
app.use(cors());
app.use(express.json());

// Servir archivos estáticos desde la carpeta actual
app.use(express.static(path.join(__dirname)));

let mapper;
let mapperInitialized = false;

// ============ INICIALIZACIÓN ============

async function initializeMapper() {
  try {
    console.log('🔄 Inicializando mapper...');
    
    mapper = new SDPDataMapper(
      process.env.SDP_CLIENT_ID,
      process.env.SDP_CLIENT_SECRET,
      process.env.SDP_REFRESH_TOKEN,
      "soporte",           // subdomain
      "kashio.net",        // domain
      "itdesk"             // portal_url
    );

    // Primera sincronización
    console.log('📥 Obteniendo primeros tickets...');
    await mapper.mapAllTickets();
    mapper.generateSummary();
    
    mapperInitialized = true;
    console.log(`✅ Mapper inicializado con ${mapper.mappedData.tickets.length} tickets`);

    // Auto-sync cada 15 minutos
    const interval = parseInt(process.env.SYNC_INTERVAL) || 15;
    mapper.startAutoSync(interval);
    console.log(`🔄 Sincronización automática cada ${interval} minutos\n`);

    return true;
  } catch (error) {
    console.error('❌ Error inicializando mapper:', error.message);
    return false;
  }
}

// ============ RUTAS DASHBOARD ============

// Servir el dashboard HTML
app.get('/dashboard-realtime.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard-realtime.html'));
});

// Root redirige al dashboard
app.get('/', (req, res) => {
  res.redirect('/dashboard-realtime.html');
});

// ============ RUTAS API ============

// GET /api/status - Estado de conexión
app.get('/api/status', (req, res) => {
  res.json({
    initialized: mapperInitialized,
    ticketCount: mapper?.mappedData.tickets.length || 0,
    lastUpdate: mapper?.mappedData.lastUpdate || null,
    lastTokenRefresh: mapper?.lastRefreshTime || null
  });
});

// GET /api/tickets - Obtener todos los tickets
app.get('/api/tickets', (req, res) => {
  if (!mapperInitialized) {
    return res.status(503).json({ 
      error: 'Mapper aún no inicializado',
      message: 'Esperando primera sincronización...'
    });
  }

  const { priority, status, overdue } = req.query;
  const filters = {};

  if (priority) filters.priority = priority;
  if (status) filters.status = status;
  if (overdue !== undefined) filters.overdue = overdue === 'true';

  const result = mapper.getTicketsForAIAnalysis(filters);
  res.json(result);
});

// GET /api/summary - Resumen estadístico
app.get('/api/summary', (req, res) => {
  if (!mapperInitialized) {
    return res.status(503).json({ error: 'Mapper no inicializado' });
  }

  res.json({
    summary: mapper.mappedData.summary,
    lastUpdate: mapper.mappedData.lastUpdate,
    totalTickets: mapper.mappedData.tickets.length
  });
});

// POST /api/sync - Forzar sincronización manual
app.post('/api/sync', async (req, res) => {
  if (!mapperInitialized) {
    return res.status(503).json({ error: 'Mapper no inicializado' });
  }

  try {
    console.log('🔄 Sincronización manual solicitada...');
    await mapper.mapAllTickets();
    mapper.generateSummary();
    
    res.json({
      success: true,
      message: 'Sincronización completada',
      ticketCount: mapper.mappedData.tickets.length,
      lastUpdate: mapper.mappedData.lastUpdate
    });
    
    console.log('✅ Sincronización completada');
  } catch (error) {
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

// GET /api/export - Exportar datos en JSON (PARA DASHBOARD EN TIEMPO REAL)
app.get('/api/export', (req, res) => {
  if (!mapperInitialized) {
    return res.status(503).json({ 
      error: 'Mapper no inicializado',
      message: 'Esperando primera sincronización...'
    });
  }

  try {
    const data = mapper.exportForAnalysis();
    res.setHeader('Content-Type', 'application/json');
    res.json(data);
  } catch (error) {
    res.status(500).json({ 
      error: 'Error al exportar',
      message: error.message 
    });
  }
});

// GET /api/analyze/overdue - Tickets vencidos
app.get('/api/analyze/overdue', (req, res) => {
  if (!mapperInitialized) {
    return res.status(503).json({ error: 'Mapper no inicializado' });
  }

  const overdueTickets = mapper.getTicketsForAIAnalysis({ overdue: true });
  res.json({
    ...overdueTickets,
    urgency: 'CRÍTICA',
    recommendation: 'Estos tickets requieren atención inmediata'
  });
});

// GET /api/analyze/priority/:level - Tickets por prioridad
app.get('/api/analyze/priority/:level', (req, res) => {
  if (!mapperInitialized) {
    return res.status(503).json({ error: 'Mapper no inicializado' });
  }

  const { level } = req.params;
  const tickets = mapper.getTicketsForAIAnalysis({ priority: level });
  res.json(tickets);
});

// GET /health - Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    mapper: mapperInitialized ? 'ready' : 'initializing'
  });
});

// ============ MANEJO DE ERRORES ============

app.use((err, req, res, next) => {
  console.error('Error:', err.message);
  res.status(500).json({ 
    error: 'Internal Server Error',
    message: err.message
  });
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint no encontrado' });
});

// ============ INICIAR SERVIDOR ============

const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log('\n' + '='.repeat(60));
  console.log('🚀 SERVIDOR INICIADO');
  console.log('='.repeat(60));
  console.log(`📍 URL: http://localhost:${PORT}`);
  console.log(`🌐 Dashboard: http://localhost:${PORT}/dashboard-realtime.html`);
  console.log('\n📊 ENDPOINTS DISPONIBLES:');
  console.log(`   GET  /api/status              - Estado del mapper`);
  console.log(`   GET  /api/tickets             - Lista de todos los tickets`);
  console.log(`   GET  /api/summary             - Resumen estadístico`);
  console.log(`   GET  /api/tickets?priority=High - Filtrar por prioridad`);
  console.log(`   POST /api/sync                - Sincronizar manualmente`);
  console.log(`   GET  /api/export              - Descargar datos como JSON`);
  console.log(`   GET  /api/analyze/overdue     - Tickets vencidos`);
  console.log(`   GET  /api/analyze/priority/:level - Por prioridad`);
  console.log(`   GET  /health                  - Health check`);
  console.log('\n' + '='.repeat(60));
  console.log('⏳ INICIALIZANDO MAPPER...\n');
  
  // Inicializar mapper
  const success = await initializeMapper();
  
  if (!success) {
    console.error('\n⚠️  ADVERTENCIA: El mapper no se pudo inicializar');
    console.error('Verifica:');
    console.error('  1. El archivo .env existe y tiene valores correctos');
    console.error('  2. Tu CLIENT_ID y CLIENT_SECRET son válidos');
    console.error('  3. Tu REFRESH_TOKEN no ha expirado (válido 6 meses)');
    console.error('  4. Tienes acceso a Service Desk Plus API\n');
    console.error('El servidor seguirá corriendo, pero /api/tickets devolverá error.\n');
  }
  
  console.log('='.repeat(60) + '\n');
});

// Manejo de interrupciones
process.on('SIGINT', () => {
  console.log('\n\n👋 Servidor detenido');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n\n👋 Servidor detenido');
  process.exit(0);
});
