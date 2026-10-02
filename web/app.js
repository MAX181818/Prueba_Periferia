const CASES = [
  [
    'sol-001',
    'Compra sin excepciones',
    'Solicitud completa y controles conformes.',
    'Flujo normal',
  ],
  ['sol-002', 'Proveedor no registrado', 'El proveedor no existe en el maestro.', 'Bloqueo'],
  [
    'sol-003',
    'Aprobación sin autoridad',
    'El aprobador no está autorizado para el centro.',
    'Bloqueo',
  ],
  [
    'sol-004',
    'Diferencia en cotización',
    'La cotización y la solicitud tienen valores distintos.',
    'Confirmación',
  ],
  [
    'sol-005',
    'Compra retroactiva',
    'La factura tiene fecha anterior a la solicitud.',
    'Confirmación',
  ],
  [
    'sol-006',
    'IVA por confirmar',
    'El indicador se deriva del maestro del proveedor.',
    'Confirmación',
  ],
];
const STORAGE_KEY = 'perxia.oc.session.v1';
const parse = (value) => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};
const display = (value) =>
  typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? 'Sin datos');

export function createApp({ document, fetch, storage }) {
  const el = (id) => document.getElementById(id);
  const node = (tag, text, className = '') => {
    const n = document.createElement(tag);
    n.textContent = text;
    n.className = className;
    return n;
  };
  let sessionId;
  let selectedCase = 'sol-001';
  let summaryCase = null;
  let pendingCase = null;
  let busy = false;
  let toolCount = 0;
  const caseButtons = [];
  const summary = new Map();
  function clearConfirmation() {
    pendingCase = null;
    el('confirmation').hidden = true;
  }
  function setBusy(value) {
    busy = value;
    for (const id of [
      'send-button',
      'preview-button',
      'process-button',
      'confirm-button',
      'cancel-button',
      'new-session',
    ])
      el(id).disabled = value;
    for (const button of caseButtons) button.disabled = value;
    el('chat-form').setAttribute('aria-busy', String(value));
  }
  function message(role, text) {
    if (el('history').children.length === 1 && el('history').children[0].className === 'welcome')
      el('history').replaceChildren();
    const row = node('article', '', `message message-${role}`);
    row.append(
      node(
        'span',
        role === 'user' ? 'TÚ' : role === 'error' ? 'AVISO' : 'ASISTENTE',
        'message-label',
      ),
      node('p', text, 'message-body'),
    );
    el('history').append(row);
    el('history').scrollTop = el('history').scrollHeight;
  }
  function renderSummary() {
    const container = el('order-summary');
    container.replaceChildren();
    for (const [label, value] of summary) {
      const row = node('div', '', 'summary-row');
      row.append(
        node('span', label, 'summary-label'),
        node('pre', display(value), 'summary-value'),
      );
      container.append(row);
    }
  }
  function summarize(call) {
    const caseId = parse(call.args)?.caso;
    if (CASES.some((item) => item[0] === caseId)) {
      if (summaryCase !== caseId) summary.clear();
      summaryCase = caseId;
      selectedCase = caseId;
      el('active-case').textContent = caseId;
      for (const button of caseButtons)
        button.setAttribute('aria-pressed', String(button.dataset.case === caseId));
    }
    const result = parse(call.result);
    if (!result || typeof result !== 'object') return;
    if (result.ok === false) {
      summary.set('Error de herramienta', result.error ?? 'No se pudo completar');
      renderSummary();
      return;
    }
    const data = result.data ?? result;
    if (!data || typeof data !== 'object') return;
    const payload = data.payload ?? data.orden ?? data;
    if (payload.proveedor) {
      summary.set('Proveedor', payload.proveedor.nombre ?? payload.proveedor);
      if (payload.proveedor.codigo_sap) summary.set('Código SAP', payload.proveedor.codigo_sap);
    }
    if (payload.referencia?.solicitud_id) summary.set('Solicitud', payload.referencia.solicitud_id);
    if (payload.moneda) summary.set('Moneda', payload.moneda);
    if (payload.condiciones_pago) summary.set('Condiciones de pago', payload.condiciones_pago);
    if (payload.posiciones) summary.set('Posiciones', payload.posiciones);
    if ('apta' in data) {
      summary.set('Validación', data.apta ? 'Apta según validación' : 'Bloqueada');
      summary.delete('Bloqueos');
      summary.delete('Excepciones a confirmar');
      summary.delete('Valores derivados');
    }
    if (data.bloqueos?.length) summary.set('Bloqueos', data.bloqueos);
    if (data.confirmaciones?.length) summary.set('Excepciones a confirmar', data.confirmaciones);
    if ('retroactiva' in data) summary.set('Retroactiva', data.retroactiva ? 'Sí' : 'No');
    if (data.derivados && Object.keys(data.derivados).length)
      summary.set('Valores derivados', data.derivados);
    if (data.numero_oc) {
      summary.set('Orden creada', data.numero_oc);
      if ('idempotente' in data)
        summary.set('Orden existente', data.idempotente ? 'Sí, recuperada sin duplicar' : 'No');
    }
    if (data.ruta) summary.set('Evidencia', data.ruta);
    if (data.sha256) summary.set('SHA-256', data.sha256);
    if (data.trazabilidad_ruta || data.ruta_trazabilidad)
      summary.set('Trazabilidad', data.trazabilidad_ruta ?? data.ruta_trazabilidad);
    renderSummary();
  }
  function tool(call) {
    if (toolCount === 0) el('tool-history').replaceChildren();
    toolCount++;
    const detail = node('details', '', 'tool-call');
    detail.append(
      node('summary', `${String(toolCount).padStart(2, '0')} · ${call.name ?? 'Herramienta'}`),
    );
    detail.append(
      node('span', 'ARGUMENTOS', 'tool-label'),
      node('pre', display(parse(call.args))),
      node('span', 'RESULTADO', 'tool-label'),
      node('pre', display(parse(call.result))),
    );
    el('tool-history').append(detail);
    el('tool-count').textContent = String(toolCount);
    summarize(call);
  }
  function selectCase(id) {
    if (busy || !CASES.some((c) => c[0] === id)) return;
    selectedCase = id;
    clearConfirmation();
    summary.clear();
    summaryCase = id;
    el('order-summary').replaceChildren(
      node('p', 'Procesa este caso para consultar sus valores y controles.', 'empty-state'),
    );
    el('active-case').textContent = id;
    for (const button of caseButtons)
      button.setAttribute('aria-pressed', String(button.dataset.case === id));
    el('status').textContent = `Solicitud seleccionada: ${id}.`;
  }
  async function request(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90000);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const data = await response.json();
      if (!response.ok)
        throw new Error(
          typeof data.error === 'string' ? data.error : 'No fue posible completar la solicitud.',
        );
      return data;
    } finally {
      clearTimeout(timer);
    }
  }
  async function send(text) {
    text = typeof text === 'string' ? text.trim() : '';
    if (busy || !text) return;
    const messageCases = new Set(text.match(/\bsol-00[1-6]\b/g) ?? []);
    if (messageCases.size === 1 && [...messageCases][0] !== selectedCase)
      selectCase([...messageCases][0]);
    clearConfirmation();
    setBusy(true);
    message('user', text);
    el('message').value = '';
    el('status').textContent = 'Revisando solicitud y ejecutando controles…';
    try {
      const data = await request('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...(sessionId ? { sessionId } : {}), message: text }),
      });
      if (typeof data.sessionId === 'string') {
        sessionId = data.sessionId;
        try {
          storage?.setItem(STORAGE_KEY, sessionId);
        } catch {}
      }
      const calls = Array.isArray(data.toolCalls) ? data.toolCalls : [];
      for (const call of calls) tool(call);
      message(
        'assistant',
        typeof data.reply === 'string'
          ? data.reply
          : 'El servidor no devolvió una respuesta legible.',
      );
      const mentioned = text.match(/\bsol-00[1-6]\b/g) ?? [];
      const toolCases = calls
        .map((c) => parse(c.args)?.caso)
        .filter((c) => CASES.some((item) => item[0] === c));
      const reviewed = new Set(toolCases.length ? toolCases : mentioned);
      if (data.needsConfirmation && reviewed.size === 1) {
        pendingCase = [...reviewed][0];
        el('confirmation').hidden = false;
        el('confirmation-title').textContent = `Confirmar creación · ${pendingCase}`;
        el('confirmation-description').textContent =
          'Lee la respuesta y las excepciones. Este botón confirma únicamente la solicitud indicada.';
      }
      el('status').textContent = data.needsConfirmation
        ? 'El agente espera tu decisión. Revisa el caso y las excepciones.'
        : 'Revisión completada. Puedes continuar la conversación.';
    } catch (error) {
      const text =
        error?.name === 'AbortError'
          ? 'La respuesta tardó demasiado. Vuelve a intentarlo; la sesión se conserva.'
          : (error?.message ?? 'No hay conexión con el servidor. Vuelve a intentarlo.');
      message('error', text);
      el('status').textContent = text;
    } finally {
      setBusy(false);
      el('message').focus();
    }
  }
  async function confirm() {
    if (!pendingCase || busy) return;
    const reviewed = pendingCase;
    await send(`Confirmo ${reviewed}`);
  }
  function reset() {
    if (busy) return;
    sessionId = undefined;
    clearConfirmation();
    try {
      storage?.removeItem(STORAGE_KEY);
    } catch {}
    el('history').replaceChildren();
    el('tool-history').replaceChildren(
      node('p', 'Todavía no hay llamadas a herramientas.', 'empty-state'),
    );
    toolCount = 0;
    el('tool-count').textContent = '0';
    selectCase(selectedCase);
    message('assistant', 'Conversación nueva. Selecciona una solicitud para comenzar.');
  }
  async function init() {
    setBusy(true);
    try {
      for (const [id, title, description, type] of CASES) {
        const button = node('button', '', 'case-button');
        button.type = 'button';
        button.dataset.case = id;
        button.disabled = busy;
        button.setAttribute('aria-pressed', String(id === selectedCase));
        const top = node('span', '', 'case-top');
        top.append(
          node('span', id),
          node('span', type, `case-kind ${type === 'Bloqueo' ? 'kind-block' : ''}`),
        );
        button.append(top, node('strong', title), node('span', description, 'case-description'));
        button.addEventListener('click', () => selectCase(id));
        caseButtons.push(button);
        el('case-list').append(button);
      }
      el('chat-form').addEventListener('submit', (event) => {
        event.preventDefault();
        void send(el('message').value);
      });
      el('preview-button').addEventListener(
        'click',
        () =>
          void send(
            `Procesa la solicitud "${selectedCase}". Muéstrame la OC como quedaría en SAP, las validaciones y las excepciones. No la crees hasta que yo confirme explícitamente.`,
          ),
      );
      el('process-button').addEventListener(
        'click',
        () =>
          void send(
            `Procesa la solicitud "${selectedCase}". Valida todos los controles, muestra el resultado y crea la OC solo si no hay bloqueos ni excepciones pendientes de confirmación. Si requiere confirmación, detente y pregúntame.`,
          ),
      );
      el('confirm-button').addEventListener('click', () => void confirm());
      el('cancel-button').addEventListener('click', () => {
        if (pendingCase) void send(`No confirmo la creación de ${pendingCase}. No crees la orden.`);
      });
      el('new-session').addEventListener('click', reset);
      try {
        const health = await request('/api/health');
        const offline = /offline|simulad|determin/i.test(`${health.provider} ${health.model}`);
        el('offline-notice').hidden = !offline;
        el('provider-status').textContent = offline
          ? 'Demostración · simulador sin LLM'
          : `${health.provider ?? 'Proveedor'} · ${health.model ?? 'Modelo'} · SAP simulado`;
      } catch {
        el('provider-status').textContent = 'Servidor sin conexión · vuelve a intentarlo';
      }
      let saved;
      try {
        saved = storage?.getItem(STORAGE_KEY);
      } catch {}
      if (!saved || !/^[a-zA-Z0-9_-]{1,128}$/.test(saved)) return;
      try {
        const data = await request(`/api/sessions/${encodeURIComponent(saved)}`);
        const history = Array.isArray(data) ? data : (data.messages ?? data.history ?? []);
        if (!Array.isArray(history)) throw new Error('Historial no disponible');
        sessionId = saved;
        for (const item of history) {
          if (
            (item.role === 'user' || item.role === 'assistant') &&
            typeof item.content === 'string' &&
            item.content
          )
            message(item.role, item.content);
          if (Array.isArray(item.toolCalls)) for (const call of item.toolCalls) tool(call);
          if (item.role === 'tool')
            tool({ name: item.name ?? 'Herramienta', args: item.args ?? {}, result: item.content });
        }
        el('status').textContent =
          'Conversación recuperada. Las confirmaciones deben revisarse de nuevo.';
      } catch {
        try {
          storage?.removeItem(STORAGE_KEY);
        } catch {}
        el('status').textContent =
          'Iniciamos una conversación nueva; el historial anterior no está disponible.';
      }
    } finally {
      setBusy(false);
    }
  }
  return { init, send, selectCase, confirm };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  let storage;
  try {
    storage = window.localStorage;
  } catch {}
  void createApp({ document, fetch: window.fetch.bind(window), storage }).init();
}
