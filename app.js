'use strict';
/* ==========================================
   HydroControl - lógica del panel (MQTT)
   Contrato con la Pi (pi/main.py), tema base configurable (por defecto "bomba"):
     Pi -> app : estado, config, horarios, historial (retained), disponibilidad
     app -> Pi : cmd/modo, cmd/bomba, cmd/valvula, cmd/calibracion, cmd/autonivel,
                 cmd/horario/guardar, cmd/horario/eliminar   (nunca retained)
========================================== */

const MAX_RPM = 3000;
const ESTADO_CADUCA_MS = 6000;       // sin estado de la Pi durante este tiempo => se considera sin conexión
const CONFIRMACION_MS = 5000;        // espera máxima de la confirmación de la Pi a un cambio de configuración
const DIAS = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];   // índice 0 = lunes (igual que weekday() en la Pi)
const CLAVE_MODO = { manual: 'control_manual', programa: 'control_programa', autonivel: 'control_autonivel' };

let T = 'bomba';
let client = null;
let everConnected = false;
let brokerUp = false;
let piOnline = null;                 // null = aún no se sabe
let estado = null, prevEstado = null, lastEstadoAt = 0, lastBeat = 0;
let config = null, horarios = [];
let locked = false, draggingSpeed = false;
const pendientes = {};               // { config: t, horarios: t } cambios enviados esperando confirmación

const $ = (id) => document.getElementById(id);
const hora = () => new Date().toLocaleTimeString();

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'style') n.style.cssText = v;
    else n.setAttribute(k, v);
  }
  n.append(...kids);
  return n;
}

function guardarLocal(k, v) { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } }
function leerLocal(k) { try { return localStorage.getItem(k); } catch { return null; } }

/* ---------- ajustes de conexión ----------
   Versión web (sin Electron): se guardan en localStorage del navegador, propio de este origen y este
   dispositivo. A diferencia de la app de escritorio, aquí NO se cifra: cualquiera con acceso físico al
   celular desbloqueado y a las herramientas de desarrollador del navegador podría leer la contraseña
   guardada. Aun así nunca sale del dispositivo ni se sube a ningún sitio; el riesgo es solo local. */
function cargarAjustesConexion() {
  try { return JSON.parse(localStorage.getItem('hc_conexion') || '{}'); } catch { return {}; }
}
function guardarAjustesConexion(s) {
  const datos = { host: s.host, port: s.port, path: s.path, tls: s.tls, user: s.user, topicBase: s.topicBase };
  if (s.remember) datos.password = s.password;
  try { localStorage.setItem('hc_conexion', JSON.stringify(datos)); } catch { /* sin almacenamiento: habrá que volver a escribir el login cada vez */ }
}
function olvidarContraseña() {
  const s = cargarAjustesConexion();
  delete s.password;
  try { localStorage.setItem('hc_conexion', JSON.stringify(s)); } catch { /* nada que borrar */ }
}

/* ---------- vistas ---------- */
function switchView(id) {
  document.querySelectorAll('.view-section').forEach((s) => s.classList.remove('view-active'));
  $(id).classList.add('view-active');
}

/* ---------- registros ---------- */
function agregarFila(contenedor, fila, max) {
  contenedor.appendChild(fila);
  const filas = contenedor.querySelectorAll(':scope > .log-row');
  if (filas.length > max) filas[0].remove();
  contenedor.scrollTop = contenedor.scrollHeight;
}

function logControl(texto, color = '#ecf0f1') {
  const box = $('logControl');
  box.querySelector('.log-placeholder')?.remove();
  agregarFila(box, el('div', { class: 'log-row', style: `color:${color}`, text: `[${hora()}] ${texto}` }), 100);
}

function logLatido(texto) {
  agregarFila($('colStates'), el('div', { class: 'log-row', text: `[${hora()}] ${texto}` }), 50);
}

function colorAccion(a) {
  if (a === 'Bomba ON') return 'var(--neon-green)';
  if (a === 'Bomba OFF') return 'var(--neon-red)';
  if (a === 'Válvula') return 'var(--neon-cyan)';
  return 'var(--neon-blue)';
}

function renderHistorial(lista) {
  const col = $('colHist');
  col.querySelectorAll('.log-row').forEach((n) => n.remove());
  for (const ev of lista) {
    col.appendChild(el('div', { class: 'log-row hist-row', style: `border-left:3px solid ${colorAccion(ev.accion)}` },
      el('b', { text: String(ev.accion) }), ` ${ev.detalle ?? ''}`, el('br'),
      el('small', { class: 'text-muted', text: new Date(ev.fecha).toLocaleString() })));
  }
}

/* ---------- comandos ---------- */
function cmd(sub, payload, descripcion) {
  if (!client || !client.connected) { logControl('> SIN CONEXIÓN: comando no enviado', 'var(--neon-red)'); return false; }
  client.publish(`${T}/cmd/${sub}`, JSON.stringify(payload), { qos: 1, retain: false });
  logControl(`> [CMD] ${descripcion}`, '#7dd3fc');
  return true;
}

function esperarConfirmacion(tipo) { pendientes[tipo] = Date.now(); }

function velocidadElegida() { return Number($('speedSlider').value); }

function aviso(texto) { logControl(`> ${texto}`, '#ffc107'); }

function enviarAutonivel() {
  const mn = Number($('cfgMin').value), mx = Number($('cfgMax').value), vel = Number($('cfgVel').value);
  if (![mn, mx, vel].every(Number.isInteger)) return aviso('AUTO-NIVEL: completa los tres valores con números enteros.');
  if (!(mn >= 0 && mn < mx && mx <= 100)) return aviso('AUTO-NIVEL: el mínimo debe ser menor que el máximo (0 a 100 %).');
  if (vel < 0 || vel > MAX_RPM) return aviso(`AUTO-NIVEL: la velocidad debe estar entre 0 y ${MAX_RPM} RPM.`);
  if (cmd('autonivel', { min_pct: mn, max_pct: mx, vel }, `AUTO-NIVEL ${mn}% - ${mx}% a ${vel} RPM`)) esperarConfirmacion('config');
}

function enviarCalibracion() {
  const vacio = Number($('cfgVacio').value), lleno = Number($('cfgLleno').value);
  if (![vacio, lleno].every(Number.isInteger)) return aviso('CALIBRACIÓN: completa los dos valores en mm.');
  if (vacio <= lleno) return aviso('CALIBRACIÓN: "vacío" debe ser mayor que "lleno" (el sensor mide distancia al agua).');
  if (cmd('calibracion', { vacio_mm: vacio, lleno_mm: lleno }, `CALIBRACIÓN vacío ${vacio} mm / lleno ${lleno} mm`)) esperarConfirmacion('config');
}

function agregarHorario() {
  const dias = [...document.querySelectorAll('#diasBox input:checked')].map((i) => i.value);
  const ini = $('hIni').value, fin = $('hFin').value, vel = Number($('hVel').value);
  if (!dias.length) return aviso('HORARIO: elige al menos un día.');
  if (!ini || !fin || ini >= fin) return aviso('HORARIO: la hora de inicio debe ser anterior a la de fin.');
  if (!Number.isInteger(vel) || vel < 0 || vel > MAX_RPM) return aviso(`HORARIO: la velocidad debe estar entre 0 y ${MAX_RPM} RPM.`);
  const id = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)).slice(0, 8);
  const nombres = dias.map((d) => DIAS[Number(d)]).join(' ');
  if (cmd('horario/guardar', { id, dias, hora_inicio: ini, hora_fin: fin, velocidad: vel, activo: true }, `HORARIO ${nombres} ${ini}-${fin} a ${vel} RPM`)) esperarConfirmacion('horarios');
}

function eliminarHorario(id) {
  if (cmd('horario/eliminar', { id }, `ELIMINAR HORARIO ${id}`)) esperarConfirmacion('horarios');
}

function inyeccionManual() {
  const tema = $('manualTopic').value.trim();
  if (!client || !client.connected) return aviso('SIN CONEXIÓN');
  if (!tema.startsWith(`${T}/`) || /[#+]/.test(tema)) return aviso(`INYECCIÓN: el tema debe empezar por "${T}/" y no puede llevar comodines.`);
  try { JSON.parse($('manualPayload').value); } catch { return aviso('INYECCIÓN: el payload no es JSON válido.'); }
  client.publish(tema, $('manualPayload').value, { qos: 1, retain: false });
  logControl(`> [INYECCIÓN] ${tema}`, '#ffc107');
}

/* ---------- render ---------- */
function estadoFresco() { return !!estado && (Date.now() - lastEstadoAt) < ESTADO_CADUCA_MS; }
function piOk() { return brokerUp && piOnline !== false && estadoFresco(); }

function pill(id, texto, tono) {
  const p = $(id);
  p.textContent = texto;
  p.className = `status-pill tone-${tono}`;
}

function renderBadges() {
  document.querySelectorAll('.badge-sys').forEach((b) => {
    let cls, txt;
    if (!brokerUp) { cls = 'bg-dark border border-secondary text-secondary'; txt = 'SIN CONEXIÓN AL BROKER'; }
    else if (piOnline === null && !estado) { cls = 'bg-dark border border-secondary text-secondary'; txt = 'ESPERANDO DATOS...'; }
    else if (!piOk()) { cls = 'system-failure'; txt = '⚠ BOMBA SIN CONEXIÓN'; }
    else if (!estado.sensor_ok) { cls = 'bg-warning text-dark'; txt = 'SENSOR SIN LECTURA'; }
    else { cls = 'bg-success border border-success text-white'; txt = 'SYSTEM ONLINE'; }
    b.className = `badge-sys badge ${cls} p-2 px-3 rounded-0`;
    b.textContent = txt;
  });
}

function aplicarControles() {
  const base = piOk() && !locked;
  const manual = base && estado.control_manual;
  document.querySelectorAll('.ctrl').forEach((e) => { e.disabled = !base; });
  document.querySelectorAll('.needs-manual').forEach((e) => { e.disabled = !manual; });
  $('hintManual').hidden = !base || estado.control_manual;
}

function actualizarVelocimetro(val) {
  $('lblSpeedGauge').textContent = val;
  $('speedGauge').style.background = `conic-gradient(var(--neon-blue) ${(val / MAX_RPM) * 100}%, var(--gauge-bg) 0%)`;
}

function renderValores() {
  const e = piOk() ? estado : null;   // sin Pi conectada no se muestran valores viejos

  pill('pillBomba', e ? (e.bomba_run ? 'ENCENDIDA' : 'APAGADA') : '--', e ? (e.bomba_run ? 'ok' : 'off') : 'off');
  pill('pillValvula', e ? (e.valvula_abierta ? 'ABIERTA' : 'CERRADA') : '--', e ? (e.valvula_abierta ? 'info' : 'off') : 'off');
  pill('pillSensor', e ? (e.sensor_ok ? 'OK' : 'SIN LECTURA') : '--', e ? (e.sensor_ok ? 'ok' : 'bad') : 'off');
  $('alertSensor').hidden = !(e && !e.sensor_ok);

  document.querySelectorAll('.mode-sw').forEach((sw) => { sw.checked = !!(e && e[CLAVE_MODO[sw.dataset.bucle]]); });

  if (e && e.bomba_run && !draggingSpeed) $('speedSlider').value = e.velocidad_rpm;
  actualizarVelocimetro(Number($('speedSlider').value));

  // vista de nivel
  const ok = !!(e && e.sensor_ok);
  $('lvlPct').textContent = ok ? e.porcentaje : '--';
  $('lvlMm').textContent = e ? e.nivel_mm : '--';
  $('tankFill').style.height = `${ok ? e.porcentaje : 0}%`;
  $('tankFill').classList.toggle('no-data', !ok);
  $('tankNoSensor').hidden = ok || !e;
  $('lvlBomba').textContent = e ? (e.bomba_run ? 'ENCENDIDA' : 'APAGADA') : '--';
  $('lvlBomba').style.color = e && e.bomba_run ? 'var(--neon-green)' : 'var(--text-muted)';
  $('lvlRpm').textContent = e && e.bomba_run ? `${e.velocidad_rpm} RPM` : ' ';
  $('lvlValvula').textContent = e ? (e.valvula_abierta ? 'ABIERTA' : 'CERRADA') : '--';
  $('lvlValvula').style.color = e && e.valvula_abierta ? 'var(--neon-blue)' : 'var(--text-muted)';
}

function renderConfig() {
  if (!config) return;
  const { calibracion: c, autonivel: a } = config;
  const idle = (id, v) => { const i = $(id); if (document.activeElement !== i) i.value = v; };
  idle('cfgMin', a.min_pct); idle('cfgMax', a.max_pct); idle('cfgVel', a.vel);
  idle('cfgVacio', c.vacio_mm); idle('cfgLleno', c.lleno_mm);
  $('markMin').style.bottom = `${a.min_pct}%`;
  $('markMax').style.bottom = `${a.max_pct}%`;
  $('lvlConfig').textContent = `Vacío ${c.vacio_mm} mm · Lleno ${c.lleno_mm} mm · Arranca ≤ ${a.min_pct}% · Para ≥ ${a.max_pct}% · ${a.vel} RPM`;
}

function renderHorarios() {
  const lista = $('listHorarios');
  lista.replaceChildren();
  if (!horarios.length) { lista.appendChild(el('div', { class: 'horario-vacio', text: 'Sin horarios programados' })); return; }
  for (const h of horarios) {
    const dias = h.dias.map((d) => DIAS[Number(d)] ?? '?').join(' ');
    const borrar = el('button', { class: 'btn btn-outline-danger btn-sm py-0 ctrl', type: 'button', 'aria-label': 'Eliminar horario' }, el('i', { class: 'bi bi-trash' }));
    borrar.addEventListener('click', () => eliminarHorario(h.id));
    lista.appendChild(el('div', { class: 'horario-row' },
      el('span', {}, el('b', { text: dias }), ` · ${h.hora_inicio}-${h.hora_fin} · ${h.velocidad} RPM`), borrar));
  }
  aplicarControles();
}

function renderTodo() { renderBadges(); renderValores(); aplicarControles(); }

/* ---------- mensajes del broker ---------- */
const ETIQUETAS = {
  bomba_run: (v) => (v ? 'Bomba ENCENDIDA' : 'Bomba APAGADA'),
  valvula_abierta: (v) => (v ? 'Válvula ABIERTA' : 'Válvula CERRADA'),
  control_manual: (v) => `Modo manual ${v ? 'activado' : 'desactivado'}`,
  control_programa: (v) => `Modo programa ${v ? 'activado' : 'desactivado'}`,
  control_autonivel: (v) => `Modo auto-nivel ${v ? 'activado' : 'desactivado'}`,
  sensor_ok: (v) => (v ? 'Sensor de nivel: lectura recuperada' : 'Sensor de nivel: SIN LECTURA'),
};

function registrarCambios(prev, cur) {
  if (!prev) return;
  for (const [k, texto] of Object.entries(ETIQUETAS)) {
    if (prev[k] === cur[k]) continue;
    const malo = (k === 'sensor_ok' && !cur[k]);
    logControl(`> [ESTADO] ${texto(cur[k])}`, malo ? 'var(--neon-red)' : '#86efac');
  }
}

function onEstado(e) {
  prevEstado = estado;
  estado = e;
  lastEstadoAt = Date.now();
  registrarCambios(prevEstado, e);
  if (Date.now() - lastBeat >= 5000) {
    lastBeat = Date.now();
    logLatido(`Nivel ${e.sensor_ok ? e.porcentaje + '%' : '--'} (${e.nivel_mm} mm) · Bomba ${e.bomba_run ? 'ON ' + e.velocidad_rpm + ' RPM' : 'OFF'} · Válvula ${e.valvula_abierta ? 'abierta' : 'cerrada'}`);
  }
  renderTodo();
}

function confirmar(tipo) {
  if (!pendientes[tipo]) return;
  delete pendientes[tipo];
  logControl(`> [OK] La Pi confirmó ${tipo === 'config' ? 'la configuración' : 'los horarios'}`, '#86efac');
}

function onMensaje(topic, payload) {
  const sub = topic.slice(T.length + 1);
  const texto = new TextDecoder().decode(payload);
  if (sub === 'disponibilidad') {
    const antes = piOnline;
    piOnline = texto.replace(/"/g, '') === 'online';
    if (antes !== null && antes !== piOnline) logControl(piOnline ? '> La Pi volvió a conectarse' : '> La Pi se desconectó del broker', piOnline ? '#86efac' : 'var(--neon-red)');
    return renderTodo();
  }
  let datos;
  try { datos = JSON.parse(texto); } catch { return; }
  if (sub === 'estado') onEstado(datos);
  else if (sub === 'config') { config = datos; renderConfig(); confirmar('config'); }
  else if (sub === 'horarios') { horarios = Array.isArray(datos) ? datos : []; renderHorarios(); confirmar('horarios'); }
  else if (sub === 'historial') renderHistorial(Array.isArray(datos) ? datos : []);
}

/* ---------- conexión ---------- */
function mostrarErrorLogin(msg) {
  const box = $('loginError');
  box.textContent = msg;
  box.hidden = !msg;
}

function conectarMQTT() {
  const host = $('host').value.trim().replace(/^\w+:\/\//, '').replace(/\/.*$/, '');
  const port = Number($('port').value);
  let path = $('path').value.trim() || '/mqtt';
  if (!path.startsWith('/')) path = `/${path}`;
  const tls = $('tls').checked;
  const user = $('user').value.trim(), pass = $('pass').value;
  const base = $('topicBase').value.trim().replace(/^\/+|\/+$/g, '');

  if (!host) return mostrarErrorLogin('Escribe el host del broker.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) return mostrarErrorLogin('El puerto no es válido.');
  if (!base || /[#+]/.test(base)) return mostrarErrorLogin('El tema base no es válido.');
  if (pass && !user) return mostrarErrorLogin('Escribe también el usuario: MQTT exige usuario y contraseña juntos.');
  mostrarErrorLogin('');

  T = base;
  everConnected = false;
  guardarAjustesConexion({ host, port, path, tls, user, topicBase: base, remember: $('remember').checked, password: pass });

  const btn = $('btnConnect');
  btn.disabled = true; btn.textContent = 'CONECTANDO...';
  const terminar = (msg) => {
    if (client) { client.end(true); client = null; }
    btn.disabled = false; btn.innerHTML = '<i class="bi bi-link-45deg"></i> INICIAR ENLACE';
    mostrarErrorLogin(msg);
  };

  let ultimoError = '';
  const c = mqtt.connect(`${tls ? 'wss' : 'ws'}://${host}:${port}${path}`, {
    username: user || undefined, password: pass || undefined,
    clientId: `hydro-app-${Math.random().toString(16).slice(2, 10)}`,
    clean: true, keepalive: 30, connectTimeout: 10000, reconnectPeriod: 0,   // sin reintentos hasta la primera conexión
  });
  client = c;

  c.on('connect', () => {
    if (c !== client) return;
    if (!everConnected) {
      everConnected = true;
      c.options.reconnectPeriod = 3000;
      btn.disabled = false; btn.innerHTML = '<i class="bi bi-link-45deg"></i> INICIAR ENLACE';
      switchView('view-main');
      $('advBase').textContent = T;
      $('manualTopic').value = `${T}/cmd/modo`;
      logControl('> CONEXIÓN ESTABLECIDA', '#00ff9d');
    } else {
      logControl('> RECONECTADO AL BROKER', '#00ff9d');
    }
    brokerUp = true;
    c.subscribe(['estado', 'config', 'horarios', 'historial', 'disponibilidad'].map((s) => `${T}/${s}`), { qos: 1 });
    renderTodo();
  });
  c.on('close', () => {
    if (c !== client) return;
    // Si el WebSocket no llega a abrirse, mqtt.js solo emite 'close' (sin 'error')
    if (!everConnected) return terminar(ultimoError || 'No se pudo conectar al broker. Revisa el host, el puerto y el path.');
    if (brokerUp) logControl('> CONEXIÓN PERDIDA. Reintentando...', '#ffc107');
    brokerUp = false;
    renderTodo();
  });
  c.on('error', (err) => {
    if (c !== client || everConnected) return;
    const m = String((err && err.message) || err);
    ultimoError = /not authorized|bad user/i.test(m) ? 'Usuario o contraseña incorrectos.' : `No se pudo conectar: ${m}`;
    terminar(ultimoError);
  });
  c.on('message', onMensaje);
}

function desconectarMQTT() {
  if (client) { client.end(true); client = null; }
  brokerUp = false; everConnected = false; piOnline = null; estado = null; prevEstado = null;
  renderTodo();
}

/* ---------- exportar ---------- */
function exportarRegistro() {
  const texto = (id) => [...$(id).querySelectorAll('.log-row')].map((r) => r.innerText.replace(/\s*\n\s*/g, ' | ')).join('\n');
  const cuerpo = `REGISTRO DE HYDROCONTROL - ${new Date().toLocaleString()}\n${'='.repeat(40)}\n\n` +
    `--- SISTEMA ---\n${texto('logControl')}\n\n--- MONITOREO ---\n${texto('colStates')}\n\n--- HISTORIAL (PI) ---\n${texto('colHist')}\n`;
  const a = el('a', { href: URL.createObjectURL(new Blob([cuerpo], { type: 'text/plain' })), download: `hydrocontrol_${Date.now()}.txt` });
  document.body.appendChild(a); a.click(); a.remove();
}

/* ---------- inicio ---------- */
function construirDias() {
  const box = $('diasBox');
  DIAS.forEach((d, i) => {
    box.appendChild(el('label', { class: 'dia-chip', title: ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'][i] },
      el('input', { type: 'checkbox', value: String(i), ...(i < 5 ? { checked: '' } : {}) }), el('span', { text: d })));
  });
}

function aplicarTema(oscuro) {
  document.body.classList.toggle('theme-dark', oscuro);
  $('cfgDarkMode').checked = oscuro;
  guardarLocal('hc_dark', oscuro ? '1' : '0');
}

function aplicarZoom(pct) {
  $('cfgZoom').value = pct;
  document.body.style.zoom = pct / 100;   // sin efecto en Safari/iOS: ahí se usa el pellizco nativo
  guardarLocal('hc_zoom', String(pct));
}

document.addEventListener('DOMContentLoaded', async () => {
  construirDias();
  renderHorarios();
  renderTodo();

  // eventos de la interfaz
  document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));
  $('btnConnect').addEventListener('click', conectarMQTT);
  document.querySelectorAll('#view-login input').forEach((i) => i.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') conectarMQTT(); }));
  $('btnTogglePass').addEventListener('click', () => {
    const p = $('pass'), oculto = p.type === 'password';
    p.type = oculto ? 'text' : 'password';
    $('iconPass').className = oculto ? 'bi bi-eye-slash' : 'bi bi-eye';
  });
  $('btnLogout').addEventListener('click', () => { desconectarMQTT(); switchView('view-login'); });

  document.querySelectorAll('.mode-sw').forEach((sw) => sw.addEventListener('click', (ev) => {
    ev.preventDefault();   // el interruptor solo cambia cuando la Pi confirma el nuevo estado
    const activo = sw.checked;   // durante el click ya trae el valor pedido, aunque luego se revierta
    cmd('modo', { bucle: sw.dataset.bucle, activo }, `MODO ${sw.dataset.bucle.toUpperCase()} -> ${activo ? 'ACTIVAR' : 'DESACTIVAR'}`);
  }));

  $('btnOn').addEventListener('click', () => {
    const v = velocidadElegida();
    if (v <= 0) return aviso('ENCENDER: elige una velocidad mayor que 0 RPM.');
    cmd('bomba', { accion: 'encender', velocidad: v }, `BOMBA -> ENCENDER a ${v} RPM`);
  });
  $('btnOff').addEventListener('click', () => cmd('bomba', { accion: 'apagar' }, 'BOMBA -> APAGAR'));
  $('btnValveOpen').addEventListener('click', () => cmd('valvula', { accion: 'abrir' }, 'VÁLVULA -> ABRIR'));
  $('btnValveClose').addEventListener('click', () => cmd('valvula', { accion: 'cerrar' }, 'VÁLVULA -> CERRAR'));

  const slider = $('speedSlider');
  slider.addEventListener('pointerdown', () => { draggingSpeed = true; });
  slider.addEventListener('input', () => actualizarVelocimetro(Number(slider.value)));
  slider.addEventListener('change', () => {
    draggingSpeed = false;
    if (estado && estado.bomba_run && estado.control_manual) {
      cmd('bomba', { accion: 'actualizar_vel', velocidad: Number(slider.value) }, `VELOCIDAD -> ${slider.value} RPM`);
    }
  });

  $('btnAddHorario').addEventListener('click', agregarHorario);
  $('btnSaveAuto').addEventListener('click', enviarAutonivel);
  $('btnSaveCal').addEventListener('click', enviarCalibracion);
  $('btnInject').addEventListener('click', inyeccionManual);
  $('btnExport').addEventListener('click', exportarRegistro);
  $('btnClearLog').addEventListener('click', () => { $('logControl').replaceChildren(); });

  $('cfgDarkMode').addEventListener('change', (ev) => aplicarTema(ev.target.checked));
  $('cfgZoom').addEventListener('input', (ev) => aplicarZoom(Number(ev.target.value)));
  $('cfgReadOnly').addEventListener('change', (ev) => { locked = ev.target.checked; aplicarControles(); });
  $('btnForget').addEventListener('click', () => {
    olvidarContraseña();
    $('pass').value = ''; $('remember').checked = false;
    logControl('> Contraseña guardada eliminada de este dispositivo', '#ffc107');
  });

  // preferencias guardadas
  aplicarTema(leerLocal('hc_dark') === '1');
  const z = Number(leerLocal('hc_zoom'));
  if (z >= 80 && z <= 150) aplicarZoom(z);

  const s = cargarAjustesConexion();
  if (s.host) $('host').value = s.host;
  if (s.port) $('port').value = s.port;
  if (s.path) $('path').value = s.path;
  if (s.tls !== undefined) $('tls').checked = s.tls;
  if (s.user) $('user').value = s.user;
  if (s.password) $('pass').value = s.password;
  if (s.topicBase) $('topicBase').value = s.topicBase;
  $('remember').checked = !!s.password;

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => { /* sin service worker la app sigue funcionando, solo sin instalación offline del cascarón */ }));
  }

  // ticks de 1 s: caducidad del estado y confirmaciones pendientes
  setInterval(() => {
    for (const [tipo, t] of Object.entries(pendientes)) {
      if (Date.now() - t > CONFIRMACION_MS) {
        delete pendientes[tipo];
        logControl(`> [AVISO] La Pi no confirmó ${tipo === 'config' ? 'la configuración' : 'los horarios'}. Revisa el valor enviado.`, '#ffc107');
      }
    }
    if (brokerUp) renderTodo();
  }, 1000);
});
