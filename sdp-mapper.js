/**
 * Service Desk Plus Cloud - Data Mapper (VERSIÓN SIMPLIFICADA)
 * Endpoint: GET https://soporte.kashio.net/app/itdesk/api/v3/requests?input_data={...}
 * Auth: Zoho-oauthtoken
 */

class SDPDataMapper {
  constructor(clientId, clientSecret, refreshToken, subdomain, domain, portalUrl) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.refreshToken = refreshToken;
    
    // URL base del API
    this.subdomain = subdomain;
    this.domain = domain;
    this.portalUrl = portalUrl;
    this.apiBase = `https://${subdomain}.${domain}/app/${portalUrl}/api/v3`;
    
    this.accessToken = null;
    this.tokenExpiresAt = null;
    
    // Almacenamiento de datos
    this.mappedData = {
      tickets: [],
      summary: {},
      lastUpdate: null
    };
  }

  /**
   * Refresca el access token
   */
  async refreshAccessToken() {
    try {
      const url = "https://accounts.zoho.com/oauth/v2/token";
      
      const params = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: this.refreshToken,
        client_id: this.clientId,
        client_secret: this.clientSecret
      });

      console.log('🔄 Refrescando token de Zoho...');

      const response = await fetch(url, {
        method: "POST",
        body: params,
        headers: { "Content-Type": "application/x-www-form-urlencoded" }
      });

      const data = await response.json();

      if (data.error) {
        throw new Error(`Zoho Error: ${data.error}`);
      }

      if (!data.access_token) {
        throw new Error(`Sin access_token en respuesta`);
      }

      this.accessToken = data.access_token;
      this.tokenExpiresAt = new Date(Date.now() + (data.expires_in * 1000));
      
      console.log(`✅ Token refrescado correctamente`);
      console.log(`   Válido hasta: ${this.tokenExpiresAt.toLocaleTimeString()}`);
      
      return this.accessToken;
    } catch (error) {
      console.error("❌ Error refrescando token:", error.message);
      throw error;
    }
  }

  /**
   * Obtiene token válido
   */
  async getValidToken() {
    if (!this.accessToken || new Date() > new Date(this.tokenExpiresAt - 300000)) {
      console.log('⏳ Token inválido o próximo a expirar, obteniendo uno nuevo...');
      await this.refreshAccessToken();
    }
    return this.accessToken;
  }

  /**
    * Obtiene todos los tickets CON udf_fields (consultando cada uno individualmente)
   */
  async fetchAllTickets() {
    try {
      console.log("📥 Obteniendo tickets del API de Service Desk Plus Cloud...");
      
      const token = await this.getValidToken();
      
      // 1️⃣ Primero: Obtén lista de IDs
      const inputData = JSON.stringify({
        "list_info": {
          "start_index": 1,
          "row_count": 100,
          "sort_field": "created_time",
          "sort_order": "desc"
        }
      });

      const listUrl = `${this.apiBase}/requests?input_data=${encodeURIComponent(inputData)}`;
      
      console.log(`📡 GET /requests (lista)`);

      const listResponse = await fetch(listUrl, {
        method: "GET",
        headers: {
          "Authorization": `Zoho-oauthtoken ${token}`,
          "Accept": "application/vnd.manageengine.sdp.v3+json"
        }
      });

      let listData = await listResponse.json();

      if (!listData.requests || listData.requests.length === 0) {
        console.log("⚠️ No hay tickets");
        return [];
      }

      console.log(`✅ ${listData.requests.length} tickets obtenidos de lista`);

      // 2️⃣ Ahora: Consulta CADA uno individualmente para obtener udf_fields
      console.log(`📥 Obteniendo detalles completos de cada ticket (con udf_fields)...`);
      
      const fullTickets = [];
      
      for (const ticket of listData.requests) {
        try {
          const detailUrl = `${this.apiBase}/requests/${ticket.id}`;
          
          const detailResponse = await fetch(detailUrl, {
            method: "GET",
            headers: {
              "Authorization": `Zoho-oauthtoken ${token}`,
              "Accept": "application/vnd.manageengine.sdp.v3+json"
            }
          });

          const detailData = await detailResponse.json();
          
          if (detailData.request) {
            fullTickets.push(detailData.request);
          }
        } catch (error) {
          console.warn(`⚠️ Error obteniendo detalles de ticket ${ticket.id}:`, error.message);
          // Continuar con el siguiente ticket
        }
      }

      console.log(`✅ ${fullTickets.length} tickets con detalles completos obtenidos`);
      return fullTickets;
    } catch (error) {
      console.error("❌ Error obteniendo tickets:", error.message);
      throw error;
    }
  }

  /**
   * Mapea un ticket individual extrayendo TODOS los campos importantes
   * Según estructura de Postman Collection
   */
  mapTicket(rawTicket) {
    return {
      // Identificadores
      id: rawTicket.id,
      displayId: rawTicket.display_id,
      
      // Información básica
      subject: rawTicket.subject,
      description: rawTicket.description,
      
      // Estado y flujo
      status: rawTicket.status?.name || rawTicket.status,
      priority: rawTicket.priority?.name || rawTicket.priority,
      urgency: rawTicket.urgency?.name || rawTicket.urgency,
      impact: rawTicket.impact?.name || rawTicket.impact,
      
      // Categorización
      category: rawTicket.category?.name || rawTicket.category,
      subcategory: rawTicket.subcategory?.name || rawTicket.subcategory,
      serviceCategory: rawTicket.service_category?.name || rawTicket.service_category,
      
      // Personas involucradas
      requestor: rawTicket.requester?.name || null,
      requestorId: rawTicket.requester?.id || null,
      requestorEmail: rawTicket.requester?.email_id || null,
      requestorPhone: rawTicket.requester?.phone || null,
      requestorMobile: rawTicket.requester?.mobile || null,
      
      assignedTo: rawTicket.technician?.name || null,
      assignedToId: rawTicket.technician?.id || null,
      assignedToEmail: rawTicket.technician?.email_id || null,
      assignedToCostPerHour: rawTicket.technician?.cost_per_hour || null,
      
      createdBy: rawTicket.created_by?.name || null,
      createdById: rawTicket.created_by?.id || null,
      
      // Tiempos
      createdTime: rawTicket.created_time?.value || rawTicket.created_time,
      lastModifiedTime: rawTicket.last_updated_time?.value || rawTicket.last_updated_time,
      dueDate: rawTicket.due_by_time?.value || rawTicket.due_by_time,
      firstResponseDueBy: rawTicket.first_response_due_by_time?.value || null,
      resolvedTime: rawTicket.resolved_time?.value || rawTicket.resolved_time,
      respondedTime: rawTicket.responded_time?.value || rawTicket.responded_time,
      completedTime: rawTicket.completed_time?.value || rawTicket.completed_time,
      
      // Estados y banderas
      overdue: rawTicket.is_overdue || false,
      isFirstResponseOverdue: rawTicket.is_first_response_overdue || false,
      isEscalated: rawTicket.is_escalated || false,
      isReopened: rawTicket.is_reopened || false,
      isFCR: rawTicket.is_fcr || false,
      isServiceRequest: rawTicket.is_service_request || false,
      isTrash: rawTicket.is_trashed || false,
      
      // Organización
      group: rawTicket.group?.name || null,
      groupId: rawTicket.group?.id || null,
      department: rawTicket.department?.name || null,
      departmentId: rawTicket.department?.id || null,
      site: rawTicket.site?.name || null,
      siteId: rawTicket.site?.id || null,
      
      // SLA y nivel de servicio
      sla: rawTicket.sla?.name || null,
      slaId: rawTicket.sla?.id || null,
      level: rawTicket.level?.name || null,
      levelId: rawTicket.level?.id || null,
      
      // Resolución
      resolution: rawTicket.resolution?.content || null,
      
      // Modo y fuente
      mode: rawTicket.mode?.name || null,
      
      // Recursos y relaciones
      assets: rawTicket.assets?.map(a => ({ name: a.name, id: a.id, barcode: a.barcode })) || [],
      configurationItems: rawTicket.configuration_items?.map(c => ({ name: c.name, id: c.id })) || [],
      
      // Información adicional
      requestType: rawTicket.request_type?.name || null,
      requestTypeId: rawTicket.request_type?.id || null,
      template: rawTicket.template?.name || null,
      templateId: rawTicket.template?.id || null,
      totalCost: rawTicket.total_cost || null,
      serviceCost: rawTicket.service_cost || null,
      timeElapsed: rawTicket.time_elapsed || null,
      unrepliedCount: rawTicket.unreplied_count || 0,
      
      // Contactos
      emailTo: rawTicket.email_to || [],
      emailCC: rawTicket.email_cc || [],
      emailBCC: rawTicket.email_bcc || [],
      
      // Metadatos
      hasAttachments: rawTicket.has_attachments || false,
      hasNotes: rawTicket.has_notes || false,
      hasProblem: rawTicket.has_problem || false,
      hasProject: rawTicket.has_project || false,
      hasLinkedRequests: rawTicket.has_linked_requests || false,
      hasChangeInitiatedRequest: rawTicket.has_change_initiated_request || false,
      hasRequestInitiatedChange: rawTicket.has_request_initiated_change || false,
      hasDraft: rawTicket.has_draft || false,
      hasPurchaseOrders: rawTicket.has_purchase_orders || false,

      // ============ CAMPOS PERSONALIZADOS (udf_fields) - MAPEO OFICIAL KASHIO ============
      // Extraer de udf_fields según la tabla oficial de campos de la ticketera
      
      // Información de la empresa
      empresa: rawTicket.udf_fields?.udf_char2 || null,                    // Clientes de Kashio
      tipoEmpresa: rawTicket.udf_fields?.udf_char6 || null,               // Tipo de Empresa
      
      // Información de contacto
      emailIdCustom: rawTicket.udf_fields?.udf_char1 || null,             // Email id
      
      // Clasificación y módulos
      modulo: rawTicket.udf_fields?.udf_char5 || null,                    // Módulo
      erp: rawTicket.udf_fields?.udf_char10 || null,                      // ERP (Administradora)
      region: rawTicket.udf_fields?.udf_char15 || null,                   // Región
      
      // Motivos y estados
      motivoPendiente: rawTicket.udf_fields?.udf_char3 || null,           // Motivo de Pendiente
      motivoCancelacion: rawTicket.udf_fields?.udf_char4 || null,         // Motivo de Cancelación
      
      // Flags de negocio y horario
      afectaNegocio: rawTicket.udf_fields?.udf_char7 || null,             // Afecta a Negocio
      dentroHorarioOficina: rawTicket.udf_fields?.udf_char8 || null,      // Dentro de Horario de Oficina
      horarioMadrugada: rawTicket.udf_fields?.udf_char9 || null,          // Horario de madrugada
      
      // Clasificación corporativa
      corporativo: rawTicket.udf_fields?.udf_char11 || null,              // Corporativo
      solicitante: rawTicket.udf_fields?.udf_char12 || null,              // Solicitante
      informativo: rawTicket.udf_fields?.udf_char13 || null,              // Informativo
      
      // Fechas y textos adicionales
      fechaComprometida: rawTicket.udf_fields?.udf_date1?.value || null,  // Fecha comprometida
      jiraGenerado: rawTicket.udf_fields?.txt_jira_generado || null,      // Jira Generado
      comentarios: rawTicket.udf_fields?.txt_comentarios || null,         // Comentarios
      solicitudAsociada: rawTicket.udf_fields?.txt_solicitud_asociada || null, // Solicitud asociada
    };
  }

  /**
   * Mapea todos los tickets
   */
  async mapAllTickets() {
    try {
      const rawTickets = await this.fetchAllTickets();
      this.mappedData.tickets = rawTickets.map(ticket => this.mapTicket(ticket));
      this.mappedData.lastUpdate = new Date();
      
      console.log(`✅ ${this.mappedData.tickets.length} tickets mapeados\n`);
      return this.mappedData.tickets;
    } catch (error) {
      console.error("❌ Error mapeando tickets:", error.message);
      throw error;
    }
  }

  /**
   * Genera resumen
   */
  generateSummary() {
    const tickets = this.mappedData.tickets;
    
    if (tickets.length === 0) {
      return { error: "No hay tickets" };
    }

    return {
      totalTickets: tickets.length,
      byStatus: this.groupBy(tickets, "status"),
      byPriority: this.groupBy(tickets, "priority"),
      overdueCount: tickets.filter(t => t.overdue).length
    };
  }

  /**
   * Agrupa elementos
   */
  groupBy(arr, key) {
    return arr.reduce((acc, obj) => {
      const group = obj[key] || "Sin clasificar";
      acc[group] = (acc[group] || 0) + 1;
      return acc;
    }, {});
  }

  /**
   * Sincronización automática
   */
  startAutoSync(intervalMinutes = 15) {
    console.log(`🔄 Sincronización automática cada ${intervalMinutes} minutos\n`);
    
    setInterval(async () => {
      try {
        console.log(`\n🔄 [${new Date().toLocaleTimeString()}] Sincronización automática...`);
        await this.mapAllTickets();
        this.generateSummary();
        console.log(`✅ Sincronización completada`);
      } catch (error) {
        console.error("❌ Error:", error.message);
      }
    }, intervalMinutes * 60 * 1000);
  }

  /**
   * Exporta datos
   */
  exportForAnalysis() {
    return {
      metadata: {
        exportTime: new Date().toISOString(),
        totalTickets: this.mappedData.tickets.length
      },
      tickets: this.mappedData.tickets,
      summary: this.mappedData.summary
    };
  }

  /**
   * Obtiene tickets para análisis
   */
  getTicketsForAIAnalysis() {
    return {
      count: this.mappedData.tickets.length,
      tickets: this.mappedData.tickets.map(t => ({
        id: t.id,
        summary: `[${t.priority}] ${t.subject}`,
        description: t.description,
        context: {
          status: t.status,
          assignedTo: t.assignedTo,
          overdue: t.overdue
        }
      }))
    };
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = SDPDataMapper;
}
