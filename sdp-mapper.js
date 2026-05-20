/**
 * SDP Mapper V4 - Sin filtro de fechas en API (no funciona en Zoho)
 * Pagina ordenado por fecha DESC y corta cuando llega al año solicitado
 */
const fs = require('fs');
const path = require('path');
const CONCURRENCY = 15;

class SDPDataMapper {
  constructor(clientId, clientSecret, refreshToken, subdomain, domain, portalUrl) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.refreshToken = refreshToken;
    this.apiBase = `https://${subdomain}.${domain}/app/${portalUrl}/api/v3`;
    this.accessToken = null;
    this.tokenExpiresAt = null;
    this.cache = {};
    this.cacheInfo = {};
    this.syncProgress = { status: 'idle', year: null, total: 0, current: 0, phase: '', pct: 0 };
    this.loadAllCaches();
  }

  cacheFile(year) { return path.join(__dirname, `tickets-cache-${year}.json`); }

  loadAllCaches() {
    const y = new Date().getFullYear();
    [y, y - 1].forEach(yr => this.loadYearCache(yr));
  }

  loadYearCache(year) {
    try {
      const file = this.cacheFile(year);
      if (fs.existsSync(file)) {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        this.cache[year] = raw.tickets || [];
        this.cacheInfo[year] = { total: raw.tickets?.length || 0, syncedAt: raw.syncedAt, complete: raw.complete || false };
        console.log(`📦 Caché ${year}: ${this.cache[year].length} tickets`);
      }
    } catch (e) { console.log(`📦 Sin caché para ${year}`); }
  }

  saveYearCache(year, complete = true) {
    try {
      fs.writeFileSync(this.cacheFile(year), JSON.stringify({
        year, tickets: this.cache[year] || [], syncedAt: new Date().toISOString(), complete
      }), 'utf8');
      console.log(`💾 Caché ${year}: ${this.cache[year]?.length} tickets guardados`);
    } catch (e) { console.error('❌ Error guardando caché:', e.message); }
  }

  getAllTickets() { return Object.values(this.cache).flat(); }

  getYearsAvailable() {
    return Object.entries(this.cacheInfo).map(([year, info]) => ({
      year: parseInt(year), total: info.total, syncedAt: info.syncedAt, complete: info.complete
    }));
  }

  // ===== TOKEN =====
  async refreshAccessToken() {
    const params = new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: this.refreshToken,
      client_id: this.clientId, client_secret: this.clientSecret
    });
    console.log('🔄 Refrescando token...');
    const res = await fetch('https://accounts.zoho.com/oauth/v2/token', {
      method: 'POST', body: params,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    const data = await res.json();
    if (!data.access_token) throw new Error(`Token error: ${JSON.stringify(data)}`);
    this.accessToken = data.access_token;
    this.tokenExpiresAt = new Date(Date.now() + data.expires_in * 1000);
    console.log(`✅ Token válido hasta: ${this.tokenExpiresAt.toLocaleTimeString()}`);
    return this.accessToken;
  }

  async getValidToken() {
    if (!this.accessToken || new Date() > new Date(this.tokenExpiresAt - 300000))
      await this.refreshAccessToken();
    return this.accessToken;
  }

  // ===== FETCH PÁGINA (sin filtro de fechas) =====
  async fetchPage(token, startIndex) {
    const input = {
      list_info: {
        start_index: startIndex,
        row_count: 100,
        sort_field: 'created_time',
        sort_order: 'desc'
      }
    };
    const url = `${this.apiBase}/requests?input_data=${encodeURIComponent(JSON.stringify(input))}`;
    const res = await fetch(url, {
      headers: {
        'Authorization': `Zoho-oauthtoken ${token}`,
        'Accept': 'application/vnd.manageengine.sdp.v3+json'
      }
    });
    const data = await res.json();
    if (!data.requests) throw new Error(`API error: ${JSON.stringify(data).substring(0, 200)}`);
    return { tickets: data.requests, hasMore: data.list_info?.has_more_rows || false };
  }

  // ===== FETCH DETALLE INDIVIDUAL =====
  async fetchDetail(token, id) {
    try {
      const res = await fetch(`${this.apiBase}/requests/${id}`, {
        headers: {
          'Authorization': `Zoho-oauthtoken ${token}`,
          'Accept': 'application/vnd.manageengine.sdp.v3+json'
        }
      });
      const data = await res.json();
      return data.request || null;
    } catch { return null; }
  }

  // ===== ENRIQUECER EN PARALELO =====
  async enrichParallel(tickets, token) {
    const results = [];
    for (let i = 0; i < tickets.length; i += CONCURRENCY) {
      const batch = tickets.slice(i, i + CONCURRENCY);
      const enriched = await Promise.all(batch.map(t => this.fetchDetail(token, t.id)));
      enriched.forEach((detail, idx) => results.push(detail || batch[idx]));
      this.syncProgress.current += batch.length;
      this.syncProgress.pct = this.syncProgress.total > 0
        ? Math.round(this.syncProgress.current / this.syncProgress.total * 100) : 0;
      if (i % 150 === 0) console.log(`   🔄 ${this.syncProgress.current}/${this.syncProgress.total} (${this.syncProgress.pct}%)`);
      await new Promise(r => setTimeout(r, 30));
    }
    return results;
  }

  // ===== SYNC DE UN AÑO =====
  async syncYear(year) {
    if (this.syncProgress.status === 'running')
      throw new Error(`Sync en progreso: ${this.syncProgress.year}`);

    const fromTime = new Date(`${year}-01-01T00:00:00Z`).getTime();
    const toTime   = new Date(`${year}-12-31T23:59:59Z`).getTime();

    this.syncProgress = {
      status: 'running', year, total: 0, current: 0,
      phase: `Fase 1: Obteniendo lista ${year}...`, pct: 0, startTime: Date.now()
    };

    try {
      const token = await this.getValidToken();

      // FASE 1: Paginar ordenado por fecha DESC, parar cuando ticket < fromTime
      console.log(`\n📋 SYNC ${year} - Fase 1: Paginando tickets...`);
      const yearTickets = [];
      let startIndex = 1, hasMore = true, page = 1, stop = false;

      while (hasMore && !stop) {
        const { tickets, hasMore: more } = await this.fetchPage(token, startIndex);

        for (const t of tickets) {
          const ts = parseInt(t.created_time?.value || t.created_time || 0);
          if (ts > toTime) continue;   // más nuevo que el rango → skip
          if (ts < fromTime) { stop = true; break; } // más viejo → parar
          yearTickets.push(t);
        }

        hasMore = more && !stop;
        startIndex += 100;
        this.syncProgress.phase = `Fase 1: ${yearTickets.length} tickets de ${year} encontrados (pág. ${page})...`;
        console.log(`   📄 Página ${page}: ${yearTickets.length} tickets del ${year} acumulados`);
        page++;
        if (page > 300) break;
        await new Promise(r => setTimeout(r, 80));
      }

      console.log(`✅ Total ${year}: ${yearTickets.length} tickets`);

      if (yearTickets.length === 0) {
        console.log(`⚠️ No se encontraron tickets para ${year}`);
        this.cache[year] = [];
        this.cacheInfo[year] = { total: 0, syncedAt: new Date().toISOString(), complete: true };
        this.saveYearCache(year, true);
        this.syncProgress = { status: 'done', year, total: 0, current: 0, phase: `✅ ${year}: 0 tickets`, pct: 100 };
        return [];
      }

      this.syncProgress.total = yearTickets.length;
      this.syncProgress.current = 0;
      this.syncProgress.phase = `Fase 2: Enriqueciendo ${yearTickets.length} tickets...`;

      // FASE 2: Enriquecer con udf_fields
      console.log(`\n🔍 SYNC ${year} - Fase 2: Enriqueciendo con UDF (${CONCURRENCY} paralelas)...`);
      const enriched = await this.enrichParallel(yearTickets, token);

      // FASE 3: Mapear y guardar
      console.log(`\n🗺️  SYNC ${year} - Fase 3: Mapeando...`);
      this.syncProgress.phase = 'Fase 3: Mapeando y guardando...';
      this.cache[year] = enriched.map(t => this.mapTicket(t));
      this.cacheInfo[year] = { total: this.cache[year].length, syncedAt: new Date().toISOString(), complete: true };
      this.saveYearCache(year, true);

      const elapsed = Math.round((Date.now() - this.syncProgress.startTime) / 1000);
      console.log(`\n✅ SYNC ${year} COMPLETO: ${this.cache[year].length} tickets en ${elapsed}s`);
      this.syncProgress = {
        status: 'done', year, total: this.cache[year].length, current: this.cache[year].length,
        phase: `✅ ${year} completado en ${elapsed}s`, pct: 100
      };

      return this.cache[year];
    } catch (e) {
      this.syncProgress.status = 'error';
      this.syncProgress.phase = `Error: ${e.message}`;
      throw e;
    }
  }

  // ===== SYNC INICIAL (año actual) =====
  async initialSync() {
    const year = new Date().getFullYear();
    if (this.cache[year]?.length > 0 && this.cacheInfo[year]?.complete) {
      console.log(`✅ Usando caché ${year}: ${this.cache[year].length} tickets`);
      return this.cache[year];
    }
    // Borrar caché vacío si existe
    if (this.cacheInfo[year] && this.cache[year]?.length === 0) {
      delete this.cache[year];
      delete this.cacheInfo[year];
      const f = this.cacheFile(year);
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    console.log(`📥 Sync inicial año ${year}...`);
    return await this.syncYear(year);
  }

  // ===== SYNC INCREMENTAL =====
  async incrementalSync() {
    try {
      console.log('\n🔄 Sync incremental...');
      const token = await this.getValidToken();
      const year = new Date().getFullYear();
      const { tickets } = await this.fetchPage(token, 1);
      const existing = new Map((this.cache[year] || []).map(t => [t.id, t]));
      const toEnrich = tickets.filter(t => {
        const cached = existing.get(t.id);
        return !cached || (t.last_updated_time?.value && +t.last_updated_time.value > +(cached.lastModifiedTime || 0));
      });
      if (!toEnrich.length) { console.log('✅ Sin cambios'); return; }
      console.log(`🔄 ${toEnrich.length} tickets nuevos/modificados`);
      const saved = this.syncProgress;
      const enriched = await this.enrichParallel(toEnrich, token);
      this.syncProgress = saved;
      enriched.forEach(raw => {
        const mapped = this.mapTicket(raw);
        if (!this.cache[year]) this.cache[year] = [];
        const idx = this.cache[year].findIndex(t => t.id === mapped.id);
        if (idx >= 0) this.cache[year][idx] = mapped;
        else this.cache[year].unshift(mapped);
      });
      this.cacheInfo[year] = { ...this.cacheInfo[year], total: this.cache[year].length, syncedAt: new Date().toISOString() };
      this.saveYearCache(year, this.cacheInfo[year]?.complete || false);
      console.log(`✅ Incremental OK: ${this.cache[year].length} tickets en ${year}`);
    } catch (e) { console.error('❌ Error incremental:', e.message); }
  }

  // ===== MAPEADOR =====
  mapTicket(r) {
    return {
      id: r.id, displayId: r.display_id, subject: r.subject, description: r.description,
      status: r.status?.name || r.status, priority: r.priority?.name || r.priority,
      urgency: r.urgency?.name || r.urgency, impact: r.impact?.name || r.impact,
      category: r.category?.name || r.category, subcategory: r.subcategory?.name || r.subcategory,
      serviceCategory: r.service_category?.name || r.service_category,
      requestor: r.requester?.name || null, requestorId: r.requester?.id || null,
      requestorEmail: r.requester?.email_id || null,
      assignedTo: r.technician?.name || null, assignedToId: r.technician?.id || null,
      assignedToEmail: r.technician?.email_id || null,
      createdBy: r.created_by?.name || null,
      createdTime: r.created_time?.value || r.created_time,
      lastModifiedTime: r.last_updated_time?.value || r.last_updated_time,
      dueDate: r.due_by_time?.value || r.due_by_time,
      firstResponseDueBy: r.first_response_due_by_time?.value || null,
      resolvedTime: r.resolved_time?.value || r.resolved_time,
      respondedTime: r.responded_time?.value || r.responded_time,
      completedTime: r.completed_time?.value || r.completed_time,
      overdue: r.is_overdue || false, isFirstResponseOverdue: r.is_first_response_overdue || false,
      isEscalated: r.is_escalated || false, isReopened: r.is_reopened || false,
      isFCR: r.is_fcr || false, isServiceRequest: r.is_service_request || false,
      group: r.group?.name || null, groupId: r.group?.id || null,
      department: r.department?.name || null, site: r.site?.name || null,
      sla: r.sla?.name || null, slaId: r.sla?.id || null, level: r.level?.name || null,
      resolution: r.resolution?.content || null, mode: r.mode?.name || null,
      requestType: r.request_type?.name || null, template: r.template?.name || null,
      totalCost: r.total_cost || null, serviceCost: r.service_cost || null,
      timeElapsed: r.time_elapsed || null, unrepliedCount: r.unreplied_count || 0,
      emailTo: r.email_to || [], emailCC: r.email_cc || [], emailBCC: r.email_bcc || [],
      hasAttachments: r.has_attachments || false, hasNotes: r.has_notes || false,
      hasProblem: r.has_problem || false, hasProject: r.has_project || false,
      hasLinkedRequests: r.has_linked_requests || false, hasDraft: r.has_draft || false,
      hasPurchaseOrders: r.has_purchase_orders || false,
      empresa: r.udf_fields?.udf_char2 || null,
      tipoEmpresa: r.udf_fields?.udf_char6 || null,
      emailIdCustom: r.udf_fields?.udf_char1 || null,
      modulo: r.udf_fields?.udf_char5 || null,
      erp: r.udf_fields?.udf_char10 || null,
      region: r.udf_fields?.udf_char15 || null,
      motivoPendiente: r.udf_fields?.udf_char3 || null,
      motivoCancelacion: r.udf_fields?.udf_char4 || null,
      afectaNegocio: r.udf_fields?.udf_char7 || null,
      dentroHorarioOficina: r.udf_fields?.udf_char8 || null,
      horarioMadrugada: r.udf_fields?.udf_char9 || null,
      corporativo: r.udf_fields?.udf_char11 || null,
      solicitante: r.udf_fields?.udf_char12 || null,
      informativo: r.udf_fields?.udf_char13 || null,
      fechaComprometida: r.udf_fields?.udf_date1?.value || null,
      jiraGenerado: r.udf_fields?.txt_jira_generado || null,
      comentarios: r.udf_fields?.txt_comentarios || null,
      solicitudAsociada: r.udf_fields?.txt_solicitud_asociada || null
    };
  }

  generateSummary() {
    const tickets = this.getAllTickets();
    return {
      totalTickets: tickets.length,
      yearsLoaded: Object.keys(this.cache).map(Number),
      byStatus: this.groupBy(tickets, 'status'),
      byPriority: this.groupBy(tickets, 'priority'),
      overdueCount: tickets.filter(t => t.overdue).length
    };
  }

  groupBy(arr, key) {
    return arr.reduce((a, o) => { const g = o[key] || 'Sin clasificar'; a[g] = (a[g] || 0) + 1; return a; }, {});
  }

  exportForAnalysis() {
    return {
      metadata: { exportTime: new Date().toISOString(), totalTickets: this.getAllTickets().length, yearsAvailable: this.getYearsAvailable() },
      tickets: this.getAllTickets(),
      summary: this.generateSummary()
    };
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = SDPDataMapper;
