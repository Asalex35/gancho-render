// Gancho — interfaz. Sin frameworks: todo el texto se inserta con textContent (nunca innerHTML) para evitar XSS.

// ================= utilidades =================
const $app = document.getElementById("app");
// Pinta la vista ignorando partes vacías (null/false): replaceChildren las convertiría en el texto "null".
const limpias = (k) => k.flat(Infinity).filter((x) => x != null && x !== false);
const mostrar = (...k) => $app.replaceChildren(...limpias(k));
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") for (const [sk, sv] of Object.entries(v)) el.style.setProperty(sk.startsWith("--") ? sk : sk.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`), sv);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}
async function api(path, { method = "GET", body, form } = {}) {
  const init = { method, headers: { "X-Gancho": "1" }, credentials: "same-origin" };
  if (form) init.body = form;
  else if (body !== undefined) { init.body = JSON.stringify(body); init.headers["Content-Type"] = "application/json"; }
  let res;
  try { res = await fetch(path, init); } catch { throw new Error("Sin conexión. Revisa tu internet e intenta de nuevo."); }
  if (res.status === 401) { location.href = "/login"; throw new Error("Sesión expirada"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Algo falló. Intenta de nuevo.");
  return data;
}
let toastT;
function toast(msg, err = false) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.className = `toast${err ? " err" : ""}`; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), err ? 6000 : 2600);
}
async function copiar(texto) {
  try { await navigator.clipboard.writeText(texto); toast("Copiado"); }
  catch { toast("No se pudo copiar. Selecciona el texto y usa Cmd+C.", true); }
}
const media = (key) => `/media/${key}`;
const local = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
const modal = document.getElementById("modal");
function abrirModal(...contenido) {
  modal.className = "";
  document.getElementById("modal-in").replaceChildren(...limpias(contenido));
  if (!modal.open) modal.showModal();
}
const cerrarModal = () => modal.close();
modal.addEventListener("click", (e) => { if (e.target === modal) cerrarModal(); });
const zoom = document.getElementById("zoom");
zoom.addEventListener("click", () => zoom.close());
function verGrande(src) { document.getElementById("zoom-img").src = src; zoom.showModal(); }
const fecha = (iso) => new Date(iso).toLocaleString("es-MX", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const confirmar = (titulo, texto, accion, boton = "Sí, continuar") => abrirModal(
  h("h2", {}, titulo), texto ? h("p", { class: "muted", style: { margin: 0 } }, texto) : null,
  h("div", { class: "foot" }, h("button", { class: "btn ghost", type: "button", onclick: cerrarModal }, "Cancelar"),
    h("button", { class: "btn primary", type: "button", onclick: async (e) => { const b = e.currentTarget; b.disabled = true; try { await accion(); cerrarModal(); } catch (er) { toast(er.message, true); b.disabled = false; } } }, boton)));
function seg(opciones, valor, alCambiar) {
  const box = h("div", { class: "seg", role: "group" });
  box.append(...Object.entries(opciones).map(([v, txt]) => h("button", { type: "button", "aria-pressed": String(valor === v), onclick: (e) => {
    box.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === e.currentTarget))); alCambiar(v);
  } }, txt)));
  return box;
}
async function descargar(url) {
  try {
    const res = await fetch(url, { credentials: "same-origin" });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "No se pudo descargar.");
    const nombre = decodeURIComponent((res.headers.get("content-disposition") || "").match(/filename\*=UTF-8''([^;]+)/)?.[1] || "portada.jpg");
    const blob = URL.createObjectURL(await res.blob());
    const a = h("a", { href: blob, download: nombre }); document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(blob), 60e3);
  } catch (e) { toast(e.message, true); }
}

const ROLES = { transgresor: "Transgresor", victima: "Víctima", testigo: "Testigo", villano: "Villano", otro: "Otro" };
const RAZONES = {
  portada: ["No se entiende la historia", "Las caras no se parecen", "Poca emoción", "Se ve falsa o de IA", "Muy explícita", "Colores apagados", "Composición confusa", "Manos o caras deformes"],
  titulo: ["No engancha", "Revela el final", "Muy largo", "No suena al canal", "Muy genérico", "Confuso"],
};
const colorScore = (v) => (v >= 80 ? "var(--good)" : v >= 65 ? "var(--mid)" : "var(--bad)");
const etiquetaScore = (v) => (v >= 80 ? "Muy fuerte" : v >= 65 ? "Buena" : "Floja");
const OCUPADA = (x) => ["en_cola", "generando"].includes(x.imagen?.estado) || x.evaluando || x.rehaciendo;

let me = null;
let poll = null;
let ultimoJSON = "";
let editando = false;
// Cada navegación tiene un número: una respuesta que llega tarde de otra vista no pinta ni reprograma nada.
let navId = 0;
const vigente = (t) => t === navId;
const canalNombre = (id) => me.canales.find((c) => c.id === id)?.nombre || id;
const canalIdioma = (id) => me.canales.find((c) => c.id === id)?.idioma || "es";
const chipIdioma = (idioma) => h("span", { class: "idioma", title: me.idiomas?.[idioma] || idioma }, String(idioma).toUpperCase());
const opcionesCanal = () => Object.fromEntries(me.canales.map((c) => [c.id, `${c.nombre} · ${String(c.idioma).toUpperCase()}`]));

// ================= barra superior y router =================
async function cargarMe() {
  me = await api("/api/me");
  document.querySelector("#m-creditos b").textContent = me.creditos ?? "?";
  document.querySelector("#m-uso b").textContent = `${me.uso.imagenes}/${me.limites.userDailyImages}`;
  document.getElementById("m-usuario").textContent = me.usuario;
  document.getElementById("nav-admin").hidden = me.rol !== "admin";
}
document.getElementById("salir").addEventListener("click", async () => { await api("/api/logout", { method: "POST" }); location.href = "/login"; });

async function ruta() {
  clearTimeout(poll); ultimoJSON = ""; editando = false; navId++;
  const [, a = "", id, b] = location.hash.split("/");
  document.querySelectorAll("#nav a").forEach((n) => n.toggleAttribute("aria-current", n.dataset.r === (a === "ep" ? "" : a)));
  document.querySelectorAll("#nav a[aria-current]").forEach((n) => n.setAttribute("aria-current", "page"));
  window.scrollTo(0, 0);
  try {
    if (!me) await cargarMe();
    if (a === "nuevo") return await vistaEditor(null);
    if (a === "ep" && id && b === "editar") return await vistaEditor(id);
    if (a === "ep" && id) return await vistaEpisodio(id);
    if (a === "lote" && id === "nuevo") return await vistaLoteNuevo();
    if (a === "lote" && id) return await vistaLote(id);
    if (a === "actores") return await vistaActores();
    if (a === "auto") return await vistaAuto();
    if (a === "canales") return await vistaCanales();
    if (a === "admin") return await vistaAdmin();
    if (a === "prisma") return await vistaPrisma();
    return await vistaInicio();
  } catch (e) {
    mostrar(h("div", { class: "vacio" }, h("h2", {}, "No se pudo cargar"), h("p", { class: "muted" }, e.message), h("a", { class: "btn", href: "#/" }, "Volver")));
  }
}
window.addEventListener("hashchange", ruta);

// ================= INICIO =================
const todoEquipo = () => me?.rol === "admin" && local.get("ver-todo") === true;
const qTodo = () => (todoEquipo() ? "?todos=1" : "");
// Interruptor del administrador: ver solo lo mío o lo de todo el equipo.
function interruptorEquipo(recargar) {
  if (me?.rol !== "admin") return null;
  return seg({ mio: "Solo lo mío", todo: "Todo el equipo" }, todoEquipo() ? "todo" : "mio", (v) => { local.set("ver-todo", v === "todo"); recargar(); });
}
async function vistaInicio() {
  const t0 = navId;
  const [lotes, eps] = await Promise.all([api(`/api/lotes${qTodo()}`), api(`/api/episodios${qTodo()}`)]);
  if (!vigente(t0)) return;
  const estados = { borrador: ["Borrador", ""], en_cola: ["En cola", "warn"], pensando: ["Generando", "warn"], procesando: ["Viendo el video", "warn"], listo: ["Listo", "ok"], error: ["Con error", "bad"] };
  mostrar(
    h("div", { class: "head" }, h("div", {}, h("div", { class: "eyebrow" }, "Inicio"), h("h1", {}, "¿Qué estrenamos hoy?")),
      h("div", { class: "row" }, interruptorEquipo(() => vistaInicio()), h("a", { class: "btn primary big", href: "#/auto" }, "⬆ Subir video"), h("a", { class: "btn big", href: "#/nuevo" }, "+ Un episodio"), h("a", { class: "btn big", href: "#/lote/nuevo" }, "+ Lote masivo"))),
    lotes.length ? h("section", { class: "stack", style: { marginBottom: "34px" } }, h("h2", {}, "Lotes"), h("div", { class: "lotes" }, lotes.map(tarjetaLote))) : null,
    h("section", { class: "stack" }, h("h2", {}, "Episodios sueltos"),
      eps.length
        ? h("div", { class: "episodios" }, eps.map((p) => {
            const [txt, cls] = estados[p.estado] || ["", ""];
            return h("button", { class: "ep", type: "button", onclick: () => (location.hash = `#/ep/${p.id}`) },
              h("div", { class: "img" }, p.portada ? h("img", { src: media(p.portada), alt: "", loading: "lazy" }) : "Sin portada todavía"),
              h("div", { class: "txt" }, h("b", {}, p.titulo),
                h("div", { class: "row" }, h("span", { class: "tag" }, canalNombre(p.canal)), h("span", { class: `tag ${cls}` }, txt), p.elegida ? h("span", { class: "tag ok" }, "Elegida") : null),
                h("span", { class: "muted", style: { fontSize: ".78rem" } }, `${p.creado_por} · ${fecha(p.actualizado)}`)));
          }))
        : h("div", { class: "vacio" }, h("p", { class: "muted", style: { margin: 0 } }, "Para uno solo usa \"+ Un episodio\". Para muchos, \"+ Lote masivo\"."))));
}

function barra(total, elegidos, pensando, errores) {
  const pct = (n) => `${total ? (n / total) * 100 : 0}%`;
  return h("div", { class: "progreso", role: "img", "aria-label": `${elegidos} de ${total} listos` },
    h("i", { class: "ok", style: { width: pct(elegidos) } }), h("i", { class: "go", style: { width: pct(Math.max(0, total - elegidos - pensando - errores)) } }), h("i", { class: "bad", style: { width: pct(errores) } }));
}
function tarjetaLote(l) {
  return h("a", { class: "lote", href: `#/lote/${l.id}` },
    h("div", { class: "stack", style: { gap: "4px" } }, h("b", {}, l.nombre), h("div", { class: "cifras" },
      h("span", {}, h("b", {}, l.elegidos), ` de ${l.total} listos`),
      l.pensando ? h("span", {}, h("b", {}, l.pensando), " generando") : null,
      l.errores ? h("span", { style: { color: "var(--bad)" } }, h("b", {}, l.errores), " con error") : null,
      h("span", {}, `${canalNombre(l.canal)} · ${l.creado_por} · ${fecha(l.creado)}`))),
    h("span", { class: "btn small" }, "Abrir"),
    barra(l.total, l.elegidos, l.pensando, l.errores));
}

// ================= LOTE NUEVO =================
async function vistaLoteNuevo() {
  const st = local.get("gancho-lote") || { nombre: "", canal: me.canales[0]?.id, modelo: "pro", autoElegir: true, texto: "" };
  const guardar = () => local.set("gancho-lote", st);
  const texto = h("textarea", { id: "lote-texto", style: { minHeight: "220px", fontFamily: "ui-monospace, Menlo, monospace", fontSize: ".82rem" },
    placeholder: "Copia las filas desde Google Sheets o Excel (con la fila de encabezados) y pégalas aquí." });
  texto.value = st.texto;
  texto.addEventListener("input", () => { st.texto = texto.value; guardar(); });
  const archivo = h("input", { type: "file", accept: ".csv,.tsv,.txt", hidden: true, onchange: async () => {
    const f = archivo.files[0]; if (!f) return;
    if (f.size > 2.5 * 1024 * 1024) return toast("El archivo es muy grande. Divide el lote.", true);
    texto.value = await f.text(); st.texto = texto.value; guardar(); toast(`Cargué ${f.name}`);
  } });
  const nombre = h("input", { type: "text", id: "lote-nombre", placeholder: "Ej. Semana 41 · CLAC" });
  nombre.value = st.nombre;
  nombre.addEventListener("input", () => { st.nombre = nombre.value; guardar(); });
  const auto = h("input", { type: "checkbox", id: "lote-auto" });
  auto.checked = st.autoElegir;
  auto.addEventListener("change", () => { st.autoElegir = auto.checked; guardar(); });
  const resultado = h("div", { class: "stack" });

  async function revisar() {
    if (!texto.value.trim()) return toast("Pega primero la lista de episodios.", true);
    try { pintarRevision(await api("/api/lotes/previsualizar", { method: "POST", body: { texto: texto.value } })); }
    catch (e) { toast(e.message, true); }
  }
  function pintarRevision(r) {
    if (r.error) return resultado.replaceChildren(h("div", { class: "aviso" }, r.error));
    const validas = r.filas.filter((f) => !f.errores.length);
    const imagenes = validas.length * 3;
    const creditos = imagenes * me.creditosPorImagen;
    const alcanza = me.creditos == null || me.creditos >= creditos;
    const quedanHoy = me.limites.userDailyImages - me.uso.imagenes;
    const lanzar = h("button", { class: "btn primary big", type: "button", disabled: !validas.length || Boolean(r.aviso) || !alcanza, onclick: async (e) => {
      const b = e.currentTarget; b.disabled = true;
      try {
        const l = await api("/api/lotes", { method: "POST", body: { ...st, texto: texto.value } });
        local.del("gancho-lote"); toast(`Lote creado con ${l.episodios} episodios`); location.hash = `#/lote/${l.id}`;
      } catch (er) { toast(er.message, true); b.disabled = false; }
    } }, `Lanzar ${validas.length} episodios`);
    resultado.replaceChildren(
      h("div", { class: "kpis" },
        h("div", { class: "kpi" }, h("span", { class: "muted" }, "Episodios válidos"), h("b", {}, `${validas.length} / ${r.filas.length}`)),
        h("div", { class: "kpi" }, h("span", { class: "muted" }, "Portadas a generar"), h("b", {}, imagenes)),
        h("div", { class: `kpi${alcanza ? "" : " alerta"}` }, h("span", { class: "muted" }, "Créditos estimados"), h("b", {}, `≈ ${creditos}`),
          h("span", { class: "muted", style: { fontSize: ".78rem" } }, alcanza ? `Tienes ${me.creditos ?? "?"}` : `Solo tienes ${me.creditos}. Recarga antes.`)),
        h("div", { class: `kpi${quedanHoy < imagenes ? " alerta" : ""}` }, h("span", { class: "muted" }, "Te quedan hoy"), h("b", {}, quedanHoy), h("span", { class: "muted", style: { fontSize: ".78rem" } }, "portadas"))),
      r.aviso ? h("div", { class: "aviso" }, r.aviso) : "",
      r.desconocidas?.length ? h("div", { class: "aviso" }, `Ignoré estas columnas: ${r.desconocidas.join(", ")}`) : "",
      h("div", { class: "tw" }, h("table", {},
        h("thead", {}, h("tr", {}, ["Fila", "Episodio", "Actores", "Revisión"].map((t) => h("th", {}, t)))),
        h("tbody", {}, r.filas.map((f) => h("tr", { class: f.errores.length ? "malo" : "" },
          h("td", { class: "num" }, f.fila),
          h("td", {}, h("b", {}, f.nombre), h("div", { class: "muted", style: { fontSize: ".8rem" } }, f.brief.sinopsis.slice(0, 120) + (f.brief.sinopsis.length > 120 ? "…" : ""))),
          h("td", {}, f.reparto.length ? h("div", { class: "chips" }, f.reparto.map((a) => h("span", { class: `tag ${a.actorId ? "ok" : "warn"}` }, `${a.personaje}: ${a.actorNombre || "?"}`))) : h("span", { class: "muted" }, "Claude arma el cast")),
          h("td", {}, [...f.errores.map((x) => h("div", { style: { color: "var(--bad)" } }, x)), ...f.avisos.map((x) => h("div", { class: "muted", style: { fontSize: ".8rem" } }, x))], !f.errores.length && !f.avisos.length ? h("span", { class: "tag ok" }, "Listo") : null)))))),
      h("div", { class: "row", style: { justifyContent: "flex-end" } }, lanzar));
    resultado.scrollIntoView({ behavior: "smooth" });
  }

  mostrar(
    h("div", { class: "head" }, h("div", {}, h("div", { class: "eyebrow" }, "Lote masivo"), h("h1", {}, "Muchos episodios de una vez")),
      h("a", { class: "btn", href: "/api/plantilla.csv" }, "Descargar plantilla")),
    h("div", { class: "grid2" },
      h("section", { class: "panel stack" },
        h("h2", {}, "1. Pega la lista"),
        h("p", { class: "muted", style: { margin: 0 } }, "Una fila por episodio. Solo la sinopsis es obligatoria; Claude deduce lo demás. Pon la duración en minutos en \"duracion\". En \"actores\" escribe Personaje=Actor separados por punto y coma."),
        texto,
        h("div", { class: "row" }, h("button", { class: "btn", type: "button", onclick: () => archivo.click() }, "O sube un CSV"), archivo)),
      h("section", { class: "panel stack" },
        h("h2", {}, "2. Ajustes"),
        h("label", {}, "Nombre del lote", nombre),
        h("div", { class: "campo-seg" }, h("span", { class: "etq" }, "Canal"), seg(opcionesCanal(), st.canal, (v) => { st.canal = v; guardar(); })),
        h("div", { class: "campo-seg" }, h("span", { class: "etq" }, "Modelo de imagen"), seg(me.modelos, st.modelo, (v) => { st.modelo = v; guardar(); })),
        h("label", { class: "switch" }, auto, h("span", {}, "Elegir la mejor automáticamente", h("br"), h("span", { class: "hint" }, "Gancho elige la de mayor calificación y escribe la descripción. Tú solo revisas y cambias las que no te gusten."))),
        me.refsPublicas ? null : h("div", { class: "aviso" }, "Modo local: Nano Banana no ve las fotos de los actores hasta publicar la app."),
        h("button", { class: "btn primary big", type: "button", onclick: revisar }, "Revisar lista"))),
    h("div", { style: { marginTop: "22px" } }, resultado));
}

// ================= LOTE: revisión rápida =================
let filtroLote = "todos";
async function vistaLote(id, t = navId) {
  const l = await api(`/api/lotes/${id}`);
  if (!vigente(t)) return;
  clearTimeout(poll);
  const json = JSON.stringify(l);
  if (json !== ultimoJSON) { ultimoJSON = json; pintarLote(l); }
  const ocupado = l.episodios.some((e) => ["en_cola", "pensando"].includes(e.estado) || e.eligiendo || e.propuestas.some((p) => ["en_cola", "generando"].includes(p.estado) || p.evaluando || p.rehaciendo));
  if (ocupado) poll = setTimeout(() => vistaLote(id, t).catch(() => { if (vigente(t)) poll = setTimeout(() => vistaLote(id, t).catch(() => {}), 15000); }), 4000);
  else cargarMe().catch(() => {});
}

function pintarLote(l) {
  const recargar = () => { ultimoJSON = ""; clearTimeout(poll); vistaLote(l.id, navId); };
  const filtros = {
    todos: () => true,
    elegir: (e) => e.estado === "listo" && !e.elegida,
    errores: (e) => e.estado === "error" || e.propuestas.some((p) => p.estado === "error"),
    listos: (e) => e.elegida && e.tiene_paquete,
  };
  const cuenta = Object.fromEntries(Object.entries(filtros).map(([k, f]) => [k, l.episodios.filter(f).length]));
  const visibles = l.episodios.filter(filtros[filtroLote]);

  const fila = (e) => {
    const estado = e.estado === "error" ? h("span", { class: "tag bad" }, "Error")
      : ["en_cola", "pensando"].includes(e.estado) ? h("span", { class: "tag warn" }, e.estado === "en_cola" ? "En cola" : "Pensando")
      : e.eligiendo ? h("span", { class: "tag warn" }, "Escribiendo descripción")
      : e.elegida && e.tiene_paquete ? h("span", { class: "tag ok" }, "Listo") : h("span", { class: "tag" }, "Por elegir");
    const ops = [0, 1, 2].map((slot) => {
      const p = e.propuestas.find((x) => x.slot === slot);
      if (!p) return h("div", { class: "mini-op shimmer" }, h("span", { class: "ph" }, e.estado === "error" ? "—" : "Pensando…"));
      const nota = p.final ?? p.estimada;
      const lista = p.estado === "lista";
      return h("button", { class: `mini-op${e.elegida === p.id ? " elegida" : ""}${lista ? "" : " shimmer"}`, type: "button", disabled: !lista || e.eligiendo,
        title: lista ? `Elegir: ${p.titulo}` : "", onclick: async () => {
          try { await api(`/api/propuestas/${p.id}/elegir`, { method: "POST" }); toast("Elegida. Escribiendo descripción…"); recargar(); } catch (er) { toast(er.message, true); }
        } },
        lista ? h("img", { src: media(p.mini || p.key), alt: "", loading: "lazy" }) : h("span", { class: "ph" }, p.estado === "error" ? "Falló la imagen" : "Pintando…"),
        lista ? h("span", { class: "nota", style: { color: colorScore(nota) } }, nota) : null,
        e.elegida === p.id ? h("span", { class: "check" }, "✓") : null,
        h("span", { class: "tit" }, p.titulo));
    });
    return h("div", { class: `fila${e.elegida && e.tiene_paquete ? " lista" : ""}` },
      h("div", { class: "info" }, h("span", { class: "muted", style: { fontSize: ".75rem" } }, `#${e.orden + 1}`), h("b", {}, e.titulo),
        h("div", { class: "row", style: { gap: "6px" } }, estado), e.error ? h("span", { style: { color: "var(--bad)", fontSize: ".8rem" } }, e.error) : null,
        h("a", { class: "btn small", href: `#/ep/${e.id}` }, "Abrir · rehacer")),
      h("div", { class: "minis" }, ops));
  };

  mostrar(
    h("div", { class: "head" },
      h("div", { class: "stack", style: { gap: "6px" } }, h("div", { class: "eyebrow" }, `Lote · ${canalNombre(l.canal)}`), h("h1", {}, l.nombre),
        h("div", { class: "cifras" }, h("span", {}, h("b", {}, l.elegidos), ` de ${l.total} listos`), l.pensando ? h("span", {}, h("b", {}, l.pensando), " generando") : null,
          l.errores ? h("span", { style: { color: "var(--bad)" } }, h("b", {}, l.errores), " con error") : null, l.auto_elegir ? h("span", {}, "Elige solo la mejor") : null)),
      h("div", { class: "row" },
        h("button", { class: "btn", type: "button", disabled: !cuenta.elegir, onclick: () => confirmar("¿Elegir la mejor en todos?", `Gancho elige la de mayor calificación en ${cuenta.elegir} episodios y escribe su descripción.`,
          async () => { const r = await api(`/api/lotes/${l.id}/elegir-mejores`, { method: "POST" }); toast(`Eligiendo ${r.elegidos}`); recargar(); }, "Elegir") }, `Elegir la mejor (${cuenta.elegir})`),
        h("button", { class: "btn", type: "button", disabled: !cuenta.errores, onclick: async () => {
          try { const r = await api(`/api/lotes/${l.id}/reintentar`, { method: "POST" }); toast(`Reintentando ${r.episodios} episodios y ${r.imagenes} portadas`); recargar(); } catch (er) { toast(er.message, true); }
        } }, `Reintentar errores (${cuenta.errores})`),
        h("button", { class: "btn primary", type: "button", disabled: !cuenta.listos, onclick: () => { toast("Preparando el ZIP…"); descargar(`/api/lotes/${l.id}/exportar.zip`); } }, `Descargar ZIP (${cuenta.listos})`),
        h("button", { class: "btn ghost danger", type: "button", onclick: () => confirmar("¿Borrar este lote?", "Se borran todos sus episodios y portadas. No se puede deshacer.",
          async () => { await api(`/api/lotes/${l.id}`, { method: "DELETE" }); location.hash = "#/"; }, "Sí, borrar") }, "Borrar"))),
    h("div", { style: { marginBottom: "18px" } }, barra(l.total, l.elegidos, l.pensando, l.errores)),
    h("div", { class: "row", style: { marginBottom: "16px", justifyContent: "space-between" } },
      seg({ todos: `Todos (${cuenta.todos})`, elegir: `Por elegir (${cuenta.elegir})`, listos: `Listos (${cuenta.listos})`, errores: `Con error (${cuenta.errores})` }, filtroLote, (v) => { filtroLote = v; ultimoJSON = ""; pintarLote(l); }),
      h("span", { class: "muted", style: { fontSize: ".85rem" } }, "Clic en una portada para elegirla.")),
    visibles.length ? h("div", { class: "filas" }, visibles.map(fila)) : h("div", { class: "vacio" }, h("p", { class: "muted", style: { margin: 0 } }, "Nada en este filtro.")));
}

// ================= EDITOR (un episodio) =================
async function vistaEditor(id) {
  const t0 = navId;
  const actores = await api("/api/actores");
  const existente = id ? await api(`/api/episodios/${id}`) : null;
  if (!vigente(t0)) return;
  const borradorKey = "gancho-borrador";
  const base = existente ? { ...existente.brief, titulo: existente.titulo, canal: existente.canal, modelo: existente.modelo, cast: existente.cast }
    : local.get(borradorKey) || { canal: me.canales[0]?.id, modelo: "pro", cast: [{ personaje: "", rol: "transgresor" }, { personaje: "", rol: "testigo" }] };
  const st = structuredClone(base);
  st.cast = (st.cast || []).map((c) => ({ ...c }));
  const guardarBorrador = () => { if (!existente) local.set(borradorKey, st); };

  const campo = (k, etiqueta, hint, area = false, ph = "") => {
    const input = area ? h("textarea", { id: `f-${k}`, placeholder: ph }) : h("input", { type: "text", id: `f-${k}`, placeholder: ph });
    input.value = st[k] || "";
    input.addEventListener("input", () => { st[k] = input.value; guardarBorrador(); });
    return h("label", {}, h("span", {}, etiqueta), hint && h("span", { class: "hint" }, hint), input);
  };

  const castBox = h("div", { class: "cast" });
  function pintarCast() {
    castBox.replaceChildren(...st.cast.map((c, i) => {
      const actor = actores.find((a) => a.id === c.actorId);
      const inp = (k, ph, label) => { const el = h("input", { type: "text", placeholder: ph, "aria-label": label }); el.value = c[k] || ""; el.addEventListener("input", () => { c[k] = el.value; guardarBorrador(); }); return el; };
      return h("div", { class: "castrow" },
        h("div", { class: "r1" },
          actor?.fotos?.length ? h("img", { class: "avatar", src: media(actor.fotos[0]), alt: actor.nombre })
            : c.fotos?.length ? h("img", { class: "avatar", src: media(c.fotos[0]), alt: c.personaje, title: "Cuadro del video" }) : h("div", { class: "avatar" }, "Sin foto"),
          h("div", { class: "stack", style: { gap: "4px" } }, h("b", {}, actor ? `${actor.nombre}${c.reconocido ? " · reconocido por Gancho" : ""}` : c.fotos?.length ? "Cara tomada del video" : "Elige quién lo interpreta"),
            h("button", { class: "btn small", type: "button", onclick: () => elegirActor(c) }, actor ? "Cambiar actor" : "Elegir actor o subir fotos")),
          h("button", { class: "btn small ghost danger", type: "button", "aria-label": "Quitar personaje", onclick: () => { st.cast.splice(i, 1); guardarBorrador(); pintarCast(); } }, "Quitar")),
        h("div", { class: "r2" }, inp("personaje", "Personaje (ej. Elena)", "Nombre del personaje"), inp("edad", "Edad", "Edad")),
        seg(ROLES, c.rol, (v) => { c.rol = v; guardarBorrador(); }),
        inp("vestuario", "Vestuario (ej. vestido de novia, uniforme de sirvienta)", "Vestuario"));
    }), h("button", { class: "btn", type: "button", onclick: () => { st.cast.push({ personaje: "", rol: "otro" }); pintarCast(); } }, "+ Agregar personaje"));
  }
  function elegirActor(c) {
    abrirModal(
      h("h2", {}, "¿Quién lo interpreta?"),
      actores.length ? h("div", { class: "biblio" }, actores.map((a) => h("button", { class: "actor", type: "button", "aria-pressed": String(c.actorId === a.id),
        onclick: () => { c.actorId = a.id; c.fotos = []; guardarBorrador(); cerrarModal(); pintarCast(); } },
        a.fotos[0] ? h("img", { src: media(a.fotos[0]), alt: "" }) : h("div", { class: "avatar" }, "Sin foto"), h("span", {}, a.nombre)))) : h("p", { class: "muted" }, "Todavía no hay actores. Sube el primero abajo."),
      h("hr", { style: { border: 0, borderTop: "1px solid var(--line)", width: "100%" } }),
      formNuevoActor((a) => { actores.unshift(a); c.actorId = a.id; guardarBorrador(); cerrarModal(); pintarCast(); }),
      h("div", { class: "foot" }, h("button", { class: "btn ghost", type: "button", onclick: cerrarModal }, "Cerrar")));
  }

  const btnGenerar = h("button", { class: "btn primary big", type: "submit" }, existente?.propuestas?.length ? "Guardar y generar 3 nuevas" : "Generar 3 propuestas");
  async function enviar(generarYa) {
    st.cast = st.cast.filter((c) => c.personaje?.trim());
    btnGenerar.disabled = true;
    try {
      const ep = existente ? await api(`/api/episodios/${existente.id}`, { method: "PUT", body: st }) : await api("/api/episodios", { method: "POST", body: st });
      local.del(borradorKey);
      if (generarYa) await api(`/api/episodios/${ep.id}/generar`, { method: "POST" });
      location.hash = `#/ep/${ep.id}`;
    } catch (e) { toast(e.message, true); btnGenerar.disabled = false; }
  }

  pintarCast();
  mostrar(h("form", { class: "stack", style: { gap: "22px" }, onsubmit: (e) => { e.preventDefault(); enviar(true); } },
    h("div", { class: "head", style: { marginBottom: 0 } },
      h("div", {}, h("div", { class: "eyebrow" }, existente ? "Editar episodio" : "Nuevo episodio"), h("h1", {}, existente ? existente.titulo : "Cuéntame la historia")),
      h("a", { class: "btn ghost", href: existente ? `#/ep/${existente.id}` : "#/" }, "Cancelar")),
    h("div", { class: "grid2" },
      h("section", { class: "panel stack" },
        h("h2", {}, "1. La historia"),
        h("div", { class: "campo-seg" }, h("span", { class: "etq" }, "Canal"), seg(opcionesCanal(), st.canal, (v) => { st.canal = v; guardarBorrador(); })),
        campo("titulo", "Nombre interno", "Solo para encontrarlo aquí. No es el título de YouTube.", false, "Ej. La boda de Lucía"),
        (() => {
          const el = h("input", { type: "number", id: "f-duracion", min: "1", max: "600", step: "1", placeholder: "Ej. 45", style: { maxWidth: "160px" } });
          el.value = st.duracion_min || "";
          el.addEventListener("input", () => { st.duracion_min = el.value; guardarBorrador(); });
          return h("label", {}, h("span", {}, "¿Cuánto dura el episodio? (minutos)"),
            h("span", { class: "hint" }, "Ayuda a Gancho a ajustar título y descripción. Si pasa de 120 min, YouTube no lo dobla solo a otros idiomas."), el);
        })(),
        campo("sinopsis", "Sinopsis", "De qué trata, en 5 a 10 líneas. Es lo único obligatorio.", true),
        campo("giro", "El giro principal", "Opcional: si lo dejas vacío, Claude lo deduce.", true, "Ej. Su hermana se fuga con el novio el día de la boda"),
        campo("momento", "El momento más fuerte", "La escena que iría en la portada.", true, "Ej. La novia llorando sola en el piso de la iglesia"),
        campo("desenlace", "Cómo termina", "Gancho lo usa para entender la historia, pero nunca lo revela.", true),
        campo("escenario", "Escenario principal", null, false, "Iglesia, camión, escuela, mansión…"),
        campo("notas", "Notas para Gancho", "Ej. evitar armas, la protagonista siempre de rojo.", true),
        h("div", { class: "campo-seg" }, h("span", { class: "etq" }, "Modelo de imagen"), seg(me.modelos, st.modelo, (v) => { st.modelo = v; guardarBorrador(); }), h("span", { class: "hint" }, "Nano Banana 2 es más rápido. Pro respeta mejor varias caras a la vez."))),
      h("section", { class: "panel stack" },
        h("h2", {}, "2. El cast"),
        h("p", { class: "muted", style: { margin: 0 } }, "Si lo dejas vacío, Claude arma los personajes desde la sinopsis (sin caras reales)."),
        me.refsPublicas ? null : h("div", { class: "aviso" }, "Modo local: Nano Banana no ve las fotos de los actores hasta publicar la app."),
        castBox)),
    h("div", { class: "row", style: { justifyContent: "flex-end" } },
      h("button", { class: "btn big", type: "button", onclick: () => enviar(false) }, existente ? "Solo guardar" : "Guardar sin generar"), btnGenerar)));
}

function formNuevoActor(alGuardar) {
  let archivos = [];
  const nombre = h("input", { type: "text", placeholder: "Nombre del actor o actriz", "aria-label": "Nombre del actor" });
  const input = h("input", { type: "file", accept: "image/jpeg,image/png,image/webp", multiple: true, hidden: true });
  const previews = h("div", { class: "previews" });
  const drop = h("div", { class: "drop", tabindex: "0", role: "button", onclick: () => input.click(),
    onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } } },
    "Arrastra las fotos aquí o haz clic", h("br"), h("small", {}, "Frente, 3/4 y cuerpo completo · JPG, PNG o WEBP · máx. 8"));
  const agregar = (files) => {
    const nuevas = [...files].filter((f) => /image\/(jpeg|png|webp)/.test(f.type));
    const grandes = nuevas.filter((f) => f.size > 8 * 1024 * 1024);
    if (grandes.length) toast(`${grandes.length} foto(s) pesan más de 8 MB.`, true);
    archivos = [...archivos, ...nuevas.filter((f) => f.size <= 8 * 1024 * 1024)].slice(0, 8);
    previews.replaceChildren(...archivos.map((f) => h("img", { src: URL.createObjectURL(f), alt: "" })));
  };
  input.addEventListener("change", () => agregar(input.files));
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("on"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("on"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("on"); agregar(e.dataTransfer.files); });
  const btn = h("button", { class: "btn primary", type: "button", onclick: async () => {
    if (!nombre.value.trim()) return toast("Escribe el nombre del actor.", true);
    if (!archivos.length) return toast("Agrega al menos una foto.", true);
    const fd = new FormData();
    fd.append("nombre", nombre.value.trim());
    archivos.forEach((f) => fd.append("fotos", f));
    btn.disabled = true; btn.textContent = "Subiendo…";
    try { alGuardar(await api("/api/actores", { method: "POST", form: fd })); toast("Actor guardado"); }
    catch (e) { toast(e.message, true); btn.disabled = false; btn.textContent = "Guardar actor"; }
  } }, "Guardar actor");
  return h("div", { class: "stack" }, h("h3", {}, "Nuevo actor"), nombre, drop, input, previews, h("div", { class: "row", style: { justifyContent: "flex-end" } }, btn));
}

// ================= EPISODIO =================
async function vistaEpisodio(id, t = navId) {
  const p = await api(`/api/episodios/${id}`);
  if (!vigente(t)) return;
  clearTimeout(poll);
  const json = JSON.stringify(p);
  if (json !== ultimoJSON && !editando) { ultimoJSON = json; pintarEpisodio(p); }
  const ocupado = ["en_cola", "pensando", "procesando"].includes(p.estado) || p.eligiendo || p.propuestas.some(OCUPADA);
  if (ocupado) poll = setTimeout(() => vistaEpisodio(id, t).catch(() => { if (vigente(t)) poll = setTimeout(() => vistaEpisodio(id, t).catch(() => {}), 15000); }), document.hidden ? 15000 : 3000);
  else cargarMe().catch(() => {});
}

// Modo manual: subir una portada hecha por el diseñador; Gancho la califica y escribe el paquete.
function subirPortadaPropia(p, recargar) {
  const input = h("input", { type: "file", accept: "image/jpeg,image/png,image/webp", hidden: true });
  const titulo = h("input", { type: "text", id: "propia-titulo", placeholder: "Título para esta portada (opcional)" });
  const vista = h("div", { class: "previews" });
  input.addEventListener("change", () => { const f = input.files[0]; vista.replaceChildren(...(f ? [h("img", { src: URL.createObjectURL(f), alt: "", style: { width: "240px", height: "auto" } })] : [])); });
  const btn = h("button", { class: "btn primary", type: "button", onclick: async () => {
    const f = input.files[0];
    if (!f) return toast("Elige la imagen de la portada.", true);
    if (f.size > 8 * 1024 * 1024) return toast("La imagen debe pesar menos de 8 MB.", true);
    const fd = new FormData(); fd.append("imagen", f); fd.append("titulo", titulo.value);
    btn.disabled = true; btn.textContent = "Subiendo…";
    try { await api(`/api/episodios/${p.id}/portada-propia`, { method: "POST", form: fd }); cerrarModal(); toast("Portada subida. Gancho la está calificando."); recargar(); }
    catch (e) { toast(e.message, true); btn.disabled = false; btn.textContent = "Subir"; }
  } }, "Subir");
  abrirModal(h("h2", {}, "Subir mi propia portada"),
    h("p", { class: "muted", style: { margin: 0 } }, "Para portadas hechas por el diseñador. Gancho la califica igual que las suyas y te escribe descripción y tags cuando la elijas."),
    h("div", { class: "row" }, h("button", { class: "btn", type: "button", onclick: () => input.click() }, "Elegir imagen"), input), vista,
    h("label", {}, "Título", titulo),
    h("div", { class: "foot" }, h("button", { class: "btn ghost", type: "button", onclick: cerrarModal }, "Cancelar"), btn));
}

function pintarEpisodio(p) {
  const recargar = () => { ultimoJSON = ""; clearTimeout(poll); vistaEpisodio(p.id, navId); };
  const generar = async () => { try { await api(`/api/episodios/${p.id}/generar`, { method: "POST" }); recargar(); } catch (e) { toast(e.message, true); } };
  const pensando = ["en_cola", "pensando", "procesando"].includes(p.estado);
  const partes = [h("div", { class: "head" },
    h("div", {}, h("div", { class: "eyebrow row", style: { gap: "8px" } },
      p.lote_id ? h("a", { href: `#/lote/${p.lote_id}`, style: { color: "inherit" } }, `← Lote · ${canalNombre(p.canal)}`)
        : p.origen === "auto" ? h("a", { href: "#/auto", style: { color: "inherit" } }, `← Automático · ${canalNombre(p.canal)}`) : canalNombre(p.canal),
      chipIdioma(canalIdioma(p.canal)),
      p.brief?.duracion_min ? h("span", { class: `tag${p.brief.duracion_min > 120 ? " warn" : ""}`, title: p.brief.duracion_min > 120 ? "Más de 2 h: YouTube no hace el doblaje automático" : "" },
        `${p.brief.duracion_min} min${p.brief.duracion_min > 120 ? " · sin doblaje automático" : ""}`) : null,
      // Hack: dónde se cortó el 1er episodio (si fue estimado, conviene revisarlo).
      p.video?.hack && p.video?.corte ? h("span", { class: `tag${p.video.corte.metodo === "estimado" ? " warn" : ""}`,
        title: p.video.corte.metodo === "estimado" ? "No se encontró el corte: se calculó dividiendo el video. Si está mal, súbelo con el minuto exacto." : "Corte detectado en el video" },
        `Hack · el 1º termina en ${Math.floor(p.video.corte.seg / 60)}:${String(Math.round(p.video.corte.seg % 60)).padStart(2, "0")}${p.video.corte.metodo === "estimado" ? " (calculado, revísalo)" : ""}`) : null,
      p.aprobacion === "auto" ? h("span", { class: "tag ok" }, "Aprobada sola") : p.aprobacion === "por_aprobar" && !p.elegida ? h("span", { class: "tag warn" }, "Por aprobar") : null),
      h("h1", {}, p.titulo)),
    h("div", { class: "row" },
      h("a", { class: "btn", href: `#/ep/${p.id}/editar` }, "Editar historia y cast"),
      h("button", { class: "btn", type: "button", disabled: pensando, onclick: () => subirPortadaPropia(p, recargar) }, "Subir mi portada"),
      p.propuestas.length ? h("button", { class: "btn", type: "button", disabled: pensando || p.propuestas.some(OCUPADA) || p.eligiendo,
        title: p.propuestas.some(OCUPADA) ? "Espera a que terminen las portadas actuales" : "",
        onclick: () => confirmar("¿Hacer 3 propuestas nuevas?", `Las actuales se guardan en el historial y se borra la descripción. Cuesta ≈${3 * (me.creditosPorImagen || 18)} créditos.`, generar, "Sí, hacer 3 nuevas") }, "3 propuestas nuevas") : null,
      h("button", { class: "btn ghost danger", type: "button", onclick: () => confirmar("¿Borrar este episodio?", "Se borran las portadas y versiones. No se puede deshacer.",
        async () => { await api(`/api/episodios/${p.id}`, { method: "DELETE" }); location.hash = p.lote_id ? `#/lote/${p.lote_id}` : "#/"; }, "Sí, borrar") }, "Borrar")))];

  // Personajes sin actor con foto: Nano Banana los inventa y no se van a parecer.
  const sinFoto = (p.cast || []).filter((c) => !c.tieneFotos).map((c) => c.personaje);
  if (sinFoto.length && !pensando && p.estado !== "procesando") partes.push(h("div", { class: "probs", style: { marginBottom: "16px" } },
    h("b", {}, `Sin foto de actor: ${sinFoto.join(", ")}. `), "Gancho los inventa, así que no se van a parecer. ",
    h("a", { href: `#/ep/${p.id}/editar`, style: { color: "inherit", fontWeight: 600 } }, "Asignar actores")));
  if (p.estado === "procesando") {
    partes.push(h("div", { class: "vacio" }, h("div", { class: "spin" }), h("h2", {}, "Gancho está viendo el episodio"), pasosVideo(p.video?.etapa),
      h("p", { class: "muted", style: { margin: 0 } }, "Saca cuadros, escucha el audio y escribe la historia. Un episodio de 40 min tarda unos minutos.")));
  } else if (pensando) {
    partes.push(h("div", { class: "vacio" }, h("div", { class: "spin" }), h("h2", {}, p.estado === "en_cola" ? "En la fila" : "Claude está leyendo la historia"),
      h("p", { class: "muted", style: { margin: 0 } }, p.estado === "en_cola" ? "Empieza en cuanto se libere un lugar." : "Arma 3 propuestas en alrededor de un minuto; después las portadas se pintan solas. Puedes salir de esta página: Gancho sigue trabajando.")));
  } else if (p.estado === "error" && p.origen === "auto" && p.video?.etapa === "error") {
    partes.push(h("div", { class: "vacio" }, h("h2", {}, "No se pudo leer el video"), h("p", { class: "muted" }, p.error || ""),
      p.video?.key ? h("button", { class: "btn primary", type: "button", onclick: async (e) => {
        const b = e.currentTarget; b.disabled = true;
        try { await api(`/api/auto/${p.id}/reintentar`, { method: "POST" }); recargar(); } catch (er) { toast(er.message, true); b.disabled = false; }
      } }, "Reintentar el video") : h("a", { class: "btn primary", href: "#/auto" }, "Subir el video de nuevo")));
  } else if (p.estado === "error") {
    partes.push(h("div", { class: "vacio" }, h("h2", {}, "No se pudieron crear las propuestas"), h("p", { class: "muted" }, p.error || ""), h("button", { class: "btn primary", type: "button", onclick: generar }, "Intentar de nuevo")));
  } else if (!p.propuestas.length) {
    partes.push(h("div", { class: "vacio" }, h("h2", {}, "¿Cómo quieres hacer la portada?"),
      h("div", { class: "row", style: { justifyContent: "center" } },
        h("button", { class: "btn primary big", type: "button", onclick: generar }, "Que Gancho haga 3 propuestas"),
        h("button", { class: "btn big", type: "button", onclick: () => subirPortadaPropia(p, recargar) }, "Subir la mía"))));
  }
  if (p.gancho && !pensando) {
    const g = p.gancho;
    partes.push(h("details", { style: { marginBottom: "20px" } }, h("summary", { class: "eyebrow", style: { cursor: "pointer", marginBottom: "10px" } }, "El gancho de la historia"),
      h("div", { class: "gancho" }, [["Transgresión", g.transgresion], ["Testigo / víctima", g.testigo], ["Objeto clave", g.objeto], ["Escenario", g.escenario], ["Final que se oculta", g.final_oculto]]
        .map(([k, v]) => h("div", {}, h("div", { class: "eyebrow" }, k), h("p", {}, v))))));
  }
  if (p.propuestas.length && !pensando) partes.push(h("div", { class: "props" }, p.propuestas.map((x, i) => tarjeta(p, x, i, recargar))));
  if (p.eligiendo) partes.push(h("div", { class: "vacio", style: { marginTop: "24px" } }, h("div", { class: "spin" }), h("p", { class: "muted", style: { margin: 0 } }, "Escribiendo descripción, tags y títulos A/B…")));
  else if (p.paquete && p.elegida) partes.push(paqueteFinal(p));
  else if (p.elegida && p.error && !pensando) partes.push(h("div", { class: "probs", style: { marginTop: "24px" } }, `No se pudo escribir la descripción (${p.error}). Dale «Aprobar / regenerar textos» otra vez.`));
  mostrar(...partes);
}

function tarjeta(p, x, i, recargar) {
  const img = x.imagen || {};
  const ev = x.evaluacion;
  const total = ev ? ev.calificacion_final : x.calificacion.total;
  const elegida = p.elegida === x.id;

  let lienzo;
  if (x.rehaciendo && x.rehaciendo !== "titulo") {
    lienzo = h("div", { class: "lienzo shimmer" }, h("div", { class: "estado" }, h("div", { class: "spin" }), "Rehaciendo con tus comentarios…"));
  } else if (img.estado === "lista") {
    lienzo = h("div", { class: "lienzo" }, h("img", { src: media(img.key), alt: x.concepto, onclick: () => verGrande(media(img.key)) }));
  } else if (img.estado === "error") {
    lienzo = h("div", { class: "lienzo" }, h("div", { class: "estado" }, h("b", { style: { color: "var(--bad)" } }, img.error || "La imagen falló."),
      h("button", { class: "btn small", type: "button", onclick: async (e) => { const b = e.currentTarget; b.disabled = true; try { await api(`/api/propuestas/${x.id}/reintentar`, { method: "POST" }); recargar(); } catch (er) { toast(er.message, true); b.disabled = false; } } }, "Reintentar imagen")));
  } else {
    const s = img.inicio ? Math.round((Date.now() - img.inicio) / 1000) : 0;
    lienzo = h("div", { class: "lienzo shimmer" }, h("div", { class: "estado" }, h("div", { class: "spin" }),
      x.autoReintento ? "La primera versión tenía defectos. Pintando otra…" : img.estado === "en_cola" ? "En la fila…" : "Pintando la portada…",
      s ? h("small", {}, `${s} s · suele tardar 30 a 90 s`) : null));
  }

  const titulo = h("div", { class: "titulo", tabindex: "0", title: "Clic para editar" }, x.titulo);
  const cuenta = h("span", { class: `count${x.titulo.length > 70 ? " warn" : ""}` }, `${x.titulo.length}/100${x.titulo.length > 70 ? " · en celular se corta después de ~70" : ""}`);
  titulo.addEventListener("click", () => { if (titulo.isContentEditable) return; editando = true; titulo.contentEditable = "true"; titulo.focus(); document.getSelection().selectAllChildren(titulo); });
  titulo.addEventListener("input", () => { const n = titulo.textContent.length; cuenta.textContent = `${n}/100`; cuenta.className = `count${n > 70 ? " warn" : ""}`; });
  titulo.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); titulo.blur(); } if (e.key === "Escape") { titulo.textContent = x.titulo; titulo.blur(); } });
  titulo.addEventListener("blur", async () => {
    titulo.contentEditable = "false"; editando = false;
    const nuevo = titulo.textContent.trim().slice(0, 100);
    if (!nuevo || nuevo === x.titulo) { titulo.textContent = x.titulo; return; }
    try { await api(`/api/propuestas/${x.id}`, { method: "PATCH", body: { titulo: nuevo } }); toast("Título guardado"); recargar(); }
    catch (e) { toast(e.message, true); titulo.textContent = x.titulo; }
  });

  const c = x.calificacion;
  const caras = ev && !ev.parecido?.length ? { si: ["Caras: coinciden", "ok"], parcial: ["Caras: se parecen poco", "warn"], no: ["Caras: no coinciden", "bad"] }[ev.caras_coinciden] || null : null;
  // Parecido medido con el comparador de rostros contra el actor real.
  const nivel = (sim) => (sim >= 0.55 ? ["Alto", "ok"] : sim >= 0.4 ? ["Medio", "warn"] : ["Bajo", "bad"]);
  const parecido = (ev?.parecido || []).map((x) => { const [t, c] = nivel(x.sim); return h("span", { class: `tag ${c}`, title: `Similitud ${x.sim}` }, `${x.personaje}: parecido ${t}`); });
  if (ev?.sinMedicion) parecido.push(h("span", { class: "tag warn", title: "No se detectaron caras claras en la portada" }, "Parecido sin medir"));
  const razones = ev?.porque_funciona?.length ? ev.porque_funciona : x.porque_funciona;
  const movil = h("div", { class: "movil", "aria-label": "Así se ve en el celular" },
    h("div", { class: "mini" }, img.estado === "lista" ? h("img", { src: media(img.mini || img.key), alt: "" }) : null),
    h("div", {}, h("div", { class: "t" }, x.titulo), h("div", { class: "c" }, `${canalNombre(p.canal)} · 1.2 M de vistas`)));

  return h("article", { class: `card${elegida ? " elegida" : ""}` },
    lienzo,
    h("div", { class: "body" },
      h("div", { class: "row", style: { gap: "6px" } }, h("span", { class: "tag" }, `Opción ${i + 1}`), x.version > 1 ? h("span", { class: "tag" }, `v${x.version}`) : null,
        caras ? h("span", { class: `tag ${caras[1]}` }, caras[0]) : null, ...parecido, x.editadoAMano ? h("span", { class: "tag" }, "Título editado") : null,
        x.propia ? h("span", { class: "tag", title: "Subida por el equipo" }, "Hecha por el equipo") : null,
        // Qué actores se pintaron con su foto real y cuáles se inventaron (sin foto en Actores).
        img.conFoto && !img.conFoto.length && !x.propia ? h("span", { class: "tag bad", title: "Asigna actores con foto en Editar historia y cast" }, "Sin fotos de actores") : null,
        ...(img.sinFoto || []).map((n) => h("span", { class: "tag warn", title: "Este personaje no tiene actor con foto: Nano Banana lo inventa" }, `${n}: sin foto`)),
        img.proveedor && !["nanobanana", "manual"].includes(img.proveedor) ? h("span", { class: "tag warn", title: "Nano Banana falló y se usó el respaldo" }, `Hecha con ${{ google: "Google", fal: "Seedream" }[img.proveedor] || img.proveedor}`) : null),
      h("div", { class: "stack", style: { gap: "4px" } }, x.rehaciendo === "titulo" ? h("div", { class: "row muted" }, h("div", { class: "spin" }), "Rehaciendo el título…") : titulo,
        x.traduccion ? h("span", { class: "trad" }, `En español: ${x.traduccion}`) : null, cuenta),
      h("div", { class: "score" },
        h("div", { class: "ring", style: { "--v": total, "--c": colorScore(total) }, role: "img", "aria-label": `Calificación ${total} de 100` }, h("b", {}, total)),
        h("div", { class: "stack", style: { gap: "6px" } },
          h("div", { class: "row", style: { gap: "6px" } }, h("b", { style: { color: colorScore(total) } }, etiquetaScore(total)),
            x.evaluando ? h("span", { class: "tag" }, "Revisando imagen…") : ev ? h("span", { class: "tag ok" }, "Revisada con la imagen") : h("span", { class: "tag" }, "Estimada")),
          x.propia ? h("span", { class: "muted", style: { fontSize: ".8rem" } }, "Calificada por Claude viendo la imagen") : h("div", { class: "bars" }, [["Tabú", c.tabu], ["Especificidad", c.especificidad], ["Misterio", c.misterio], ["Claridad visual", c.claridad_visual]]
            .map(([k, v]) => h("div", { class: "bar" }, h("span", {}, k), h("i", { style: { "--v": v } }), h("span", {}, v)))))),
      h("div", {}, h("div", { class: "eyebrow", style: { marginBottom: "6px" } }, "Por qué va a funcionar"), h("ul", { class: "why" }, razones.slice(0, 3).map((r) => h("li", {}, r)))),
      x.errorRehacer ? h("div", { class: "probs" }, x.errorRehacer) : null,
      img.estado === "lista" ? h("div", { class: "row", style: { gap: "8px" } },
        h("button", { class: "btn ghost", type: "button", style: { flex: 1 }, onclick: () => vistaYouTube(p, x).catch((e) => toast(e.message, true)) }, "▶ Ver en YouTube"),
        h("button", { class: "btn ghost", type: "button", style: { flex: 1 }, title: "JPG 1280×720 listo para subir a YouTube", onclick: () => descargar(`/api/episodios/${p.id}/portada.jpg?propuesta=${x.id}`) }, "⬇ Descargar")) : null,
      img.estado === "lista" ? h("button", { class: "btn ghost full", type: "button", onclick: () => vistaFormatos(p, x).catch((e) => toast(e.message, true)) }, "✦ Redes y Prisma Plus") : null,
      h("div", { class: "acciones" },
        h("button", { class: `btn ${elegida ? "" : "primary"} full`, type: "button", disabled: img.estado !== "lista" || OCUPADA(x) || p.eligiendo,
          onclick: (e) => {
            const b = e.currentTarget;
            const elegir = async () => { b.disabled = true; try { await api(`/api/propuestas/${x.id}/elegir`, { method: "POST" }); recargar(); } catch (er) { toast(er.message, true); b.disabled = false; } };
            if (elegida && p.paquete?.editadoAMano) return confirmar("¿Regenerar los textos?", "Se reemplaza la descripción y los tags que editaste a mano.", elegir, "Sí, regenerar");
            elegir();
          } },
          elegida ? "✓ Elegida · regenerar textos" : p.origen === "auto" ? "Aprobar esta" : "Elegir esta"),
        h("button", { class: "btn", type: "button", disabled: OCUPADA(x) || p.eligiendo, onclick: () => rehacer(x, recargar) }, x.rehaciendo ? "Rehaciendo…" : "Rehacer"),
        h("button", { class: "btn", type: "button", disabled: !x.nVersiones || OCUPADA(x) || p.eligiendo, onclick: () => versiones(x, recargar) }, `Anteriores${x.nVersiones ? ` (${x.nVersiones})` : ""}`)),
      h("details", {}, h("summary", { class: "eyebrow", style: { cursor: "pointer" } }, "Más detalles"),
        h("div", { class: "stack", style: { marginTop: "10px", gap: "10px" } }, movil,
          ev?.problemas?.length ? h("div", { class: "risk" }, h("b", {}, "Para mejorar: "), ev.problemas.slice(0, 2).join(" · ")) : null,
          h("div", { class: "risk" }, h("b", {}, "Riesgo: "), x.riesgo),
          h("div", { class: "row", style: { gap: "6px" } }, h("span", { class: "tag" }, x.composicion), h("span", { class: "tag" }, `Fórmula ${x.formula}`))))));
}

// ================= Vista previa: así se ve en YouTube =================
const fmtVistas = (n) => (n == null ? "" : n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(".0", "")} M de vistas` : n >= 1e3 ? `${Math.round(n / 1e3)} k vistas` : `${n} vistas`);
function haceCuanto(iso) {
  if (!iso) return "";
  const d = (Date.now() - new Date(iso)) / 864e5;
  return d < 1 ? `hace ${Math.max(1, Math.round(d * 24))} horas` : d < 30 ? `hace ${Math.round(d)} días` : d < 365 ? `hace ${Math.round(d / 30)} meses` : `hace ${Math.round(d / 365)} años`;
}
const duracionTxt = (min) => (!min ? "" : min >= 60 ? `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}:00` : `${min}:00`);
const ytImg = (id, grande) => `https://i.ytimg.com/vi/${id}/${grande ? "hqdefault" : "mqdefault"}.jpg`;
let compCache = null;

async function vistaYouTube(p, x) {
  const cargar = async () => (compCache = await api("/api/competencia").catch(() => ({ videos: [], propias: [] })));
  if (!compCache) await cargar();
  const mia = { mia: true, src: media(x.imagen.key), titulo: x.titulo, autor: canalNombre(p.canal), meta: "Sin publicar", dur: duracionTxt(p.brief?.duracion_min) };
  const aTarjeta = (v) => ({ src: ytImg(v.video_id), grande: ytImg(v.video_id, true), titulo: v.titulo, autor: v.autor, dur: v.duracion || "", meta: [fmtVistas(v.vistas), haceCuanto(v.publicado)].filter(Boolean).join(" • ") });
  let fuente = "guardada", externos = null, busqueda = x.titulo.split(/\s+/).slice(0, 5).join(" ");
  const otros = () => fuente !== "guardada" && externos?.length ? externos.map(aTarjeta) : [
    ...compCache.videos.map(aTarjeta),
    ...compCache.propias.filter((o) => ![x.imagen.key, x.imagen.mini].includes(o.key)).map((o) => ({ src: media(o.key), titulo: o.titulo, autor: canalNombre(o.canal), meta: "Portada de Gancho" })),
  ];
  let modo = local.get("yt-modo") || "pc", oscuro = local.get("yt-oscuro") ?? true, resaltar = false, semilla = 0;

  // n tarjetas: la portada propia en una posición realista y el resto de la competencia.
  const lista = (n, desfase = 0) => {
    const o = otros(), out = [];
    for (let i = 0; out.length < n - 1; i++) out.push(o.length ? o[(i + desfase + semilla * 3) % o.length] : { vacio: true });
    out.splice(Math.min([1, 4, 2, 6][semilla % 4], n - 1), 0, mia);
    return out;
  };
  const soloOtros = (n, desfase) => { const o = otros(); return Array.from({ length: n }, (_, i) => (o.length ? o[(i + desfase + semilla * 3) % o.length] : { vacio: true })); };
  const avatar = (nombre) => h("div", { class: "yt-av", style: { "--h": [...String(nombre)].reduce((a, c) => a + c.charCodeAt(0), 0) % 360 } }, String(nombre || "?").trim().charAt(0).toUpperCase());
  const miniatura = (it, grande) => h("div", { class: "yt-th" },
    it.vacio ? null : h("img", { src: grande && it.grande ? it.grande : it.src, alt: "", loading: "lazy", onerror: (e) => { if (it.grande && e.target.src !== it.src) e.target.src = it.src; } }),
    it.dur ? h("span", { class: "yt-dur" }, it.dur) : null);
  const clase = (it, base) => `${base}${it.mia ? " yt-mia" : ""}${it.mia && resaltar ? " resalta" : ""}`;
  const tarjetaGrande = (it) => h("div", { class: clase(it, "yt-card") }, miniatura(it),
    h("div", { class: "yt-info" }, avatar(it.autor), h("div", {}, h("div", { class: "yt-t" }, it.titulo || ""), h("div", { class: "yt-m" }, it.autor || ""), h("div", { class: "yt-m" }, it.meta || ""))));
  const tarjetaCompacta = (it) => h("div", { class: clase(it, "yt-comp") }, miniatura(it),
    h("div", {}, h("div", { class: "yt-t" }, it.titulo || ""), h("div", { class: "yt-m" }, it.autor || ""), h("div", { class: "yt-m" }, it.meta || "")));
  const tarjetaTV = (it) => h("div", { class: clase(it, "yt-tvc") + (it.mia ? " foco" : "") }, miniatura(it, true),
    h("div", { class: "yt-t" }, it.titulo || ""), h("div", { class: "yt-m" }, [it.autor, it.meta].filter(Boolean).join(" • ")));

  const pantallas = {
    pc: () => h("div", { class: "yt-pc" },
      h("div", { class: "yt-top" }, h("b", { class: "yt-logo" }, "▶ YouTube"), h("div", { class: "yt-search" }, "Buscar")),
      h("div", { class: "yt-chips" }, ["Todos", "Telenovelas", "Drama", "Mixes", "Videos nuevos para ti"].map((c, i) => h("span", { class: i ? "" : "on" }, c))),
      h("div", { class: "yt-grid" }, lista(8).map(tarjetaGrande)),
      h("div", { class: "yt-sub" }, "Al lado de otro video · aquí la portada se ve de 168 × 94 px"),
      h("div", { class: "yt-watch" }, h("div", { class: "yt-player" }, "▶"), h("div", { class: "yt-side" }, lista(5, 7).map(tarjetaCompacta)))),
    cel: () => h("div", { class: "yt-cels" },
      h("div", { class: "yt-tel" }, h("div", { class: "yt-tel-top" }, h("b", { class: "yt-logo" }, "▶ YouTube")), h("div", { class: "yt-tel-feed" }, lista(4).map(tarjetaGrande)), h("div", { class: "yt-pie" }, "Inicio")),
      h("div", { class: "yt-tel" }, h("div", { class: "yt-tel-top" }, h("div", { class: "yt-search" }, fuente === "busqueda" ? busqueda : "telenovelas")), h("div", { class: "yt-tel-feed lista" }, lista(7, 5).map(tarjetaCompacta)), h("div", { class: "yt-pie" }, "Búsqueda y sugeridos"))),
    tv: () => h("div", { class: "yt-tv" }, h("div", { class: "yt-tv-pant" },
      h("div", { class: "yt-tv-menu" }, ["⌂", "⌕", "▤", "☺"].map((s) => h("span", {}, s))),
      h("div", { class: "yt-tv-cont" },
        h("div", { class: "yt-tv-row" }, h("div", { class: "yt-sub" }, "Recomendados"), h("div", { class: "yt-tv-fila" }, lista(4).map(tarjetaTV))),
        h("div", { class: "yt-tv-row" }, h("div", { class: "yt-sub" }, "Telenovelas y drama"), h("div", { class: "yt-tv-fila" }, soloOtros(4, 9).map(tarjetaTV)))))),
  };

  const escenario = h("div", {});
  const pintar = () => {
    escenario.replaceChildren(h("div", { class: `yt ${oscuro ? "yt-dark" : "yt-light"}` }, pantallas[modo]()));
  };
  const controles = h("div", { class: "row", style: { justifyContent: "space-between" } },
    seg({ pc: "Computadora", cel: "Celular", tv: "Televisión" }, modo, (v) => { modo = v; local.set("yt-modo", v); pintar(); }),
    h("div", { class: "row", style: { gap: "6px" } },
      seg({ oscuro: "Oscuro", claro: "Claro" }, oscuro ? "oscuro" : "claro", (v) => { oscuro = v === "oscuro"; local.set("yt-oscuro", oscuro); pintar(); }),
      h("button", { class: "btn small", type: "button", onclick: (e) => { resaltar = !resaltar; e.currentTarget.classList.toggle("primary", resaltar); pintar(); } }, "Resaltar la mía"),
      h("button", { class: "btn small", type: "button", onclick: () => { semilla++; pintar(); } }, "Mover de lugar")));
  // Tu portada junto a lo que es tendencia en México o lo que sale al buscar el tema (YouTube API).
  // Sin la llave, usa las portadas de otros canales guardadas.
  const caja = h("input", { value: busqueda, placeholder: "¿Qué buscaría la gente?", style: { maxWidth: "320px" }, hidden: true });
  const traer = async () => {
    try {
      busqueda = caja.value.trim() || busqueda;
      externos = (await api(`/api/competencia/youtube${fuente === "busqueda" ? `?q=${encodeURIComponent(busqueda)}` : ""}`)).videos;
      pintar();
    } catch (er) { toast(er.message, true); }
  };
  const buscarBtn = h("button", { class: "btn small", type: "button", hidden: true, onclick: traer }, "Buscar");
  caja.addEventListener("keydown", (e) => { if (e.key === "Enter") traer(); });
  const fuentes = compCache.youtubeApi
    ? h("div", { class: "row", style: { gap: "6px" } },
        seg({ tendencias: "Tendencias MX", busqueda: "Búsqueda" }, "tendencias", (v) => { fuente = v; caja.hidden = buscarBtn.hidden = v !== "busqueda"; traer(); }),
        caja, buscarBtn)
    : null;
  if (compCache.youtubeApi) { fuente = "tendencias"; await traer(); }
  const problemas = x.evaluacion?.problemas?.length ? h("div", { class: "risk" }, h("b", {}, "Lo que vio Gancho a tamaño chico: "), x.evaluacion.problemas.slice(0, 2).join(" · ")) : null;

  pintar();
  abrirModal(h("h2", {}, "Así se ve en YouTube"), controles, fuentes, escenario, problemas,
    h("div", { class: "foot" }, h("button", { class: "btn", type: "button", onclick: cerrarModal }, "Cerrar")));
  modal.classList.add("yt-ancho");
}

// ================= Formatos: redes sociales y Prisma Plus =================
let tiposFormato = null;
const mediaFormato = (f) => (f.mini || f.key ? media(f.mini || f.key) : null);
function tarjetaFormato(f, recargar) {
  const [aw, ah] = String(f.aspecto || "1:1").split(":").map(Number);
  const ocupado = ["en_cola", "generando"].includes(f.estado);
  return h("div", { class: "fmt" },
    h("div", { class: `fmt-img${ocupado ? " shimmer" : ""}`, style: { aspectRatio: `${aw} / ${ah}` } },
      f.estado === "lista" ? h("img", { src: mediaFormato(f), alt: f.nombre, loading: "lazy", onclick: () => verGrande(media(f.key)) })
        : ocupado ? h("div", { class: "estado" }, h("div", { class: "spin" }), "Pintando…", h("small", {}, " tarda 1 a 3 min"))
        : h("div", { class: "estado" }, h("b", { style: { color: "var(--bad)" } }, f.error || "Falló"))),
    h("div", { class: "stack", style: { gap: "4px" } },
      h("b", { style: { fontSize: ".85rem" } }, f.nombre),
      f.textos?.principal ? h("span", { class: "muted", style: { fontSize: ".8rem" } }, `“${f.textos.principal}”`) : null,
      f.titulo ? h("a", { href: `#/ep/${f.episodio_id}`, class: "muted", style: { fontSize: ".75rem" } }, f.titulo) : null),
    h("div", { class: "row", style: { gap: "6px" } },
      f.estado === "lista" ? h("button", { class: "btn small", type: "button", onclick: () => descargar(`/api/formatos/${f.id}/descargar`) }, "⬇ Descargar") : null,
      f.estado === "error" ? h("button", { class: "btn small", type: "button", onclick: async () => {
        try { await api(`/api/propuestas/${f.propuesta_id}/formatos`, { method: "POST", body: { tipos: [f.tipo] } }); toast("Pintando otra vez…"); recargar(); } catch (e) { toast(e.message, true); }
      } }, "Otra vez") : null,
      !ocupado ? h("button", { class: "btn small ghost danger", type: "button", onclick: async () => {
        try { await api(`/api/formatos/${f.id}`, { method: "DELETE" }); recargar(); } catch (e) { toast(e.message, true); }
      } }, "Borrar") : null));
}

async function vistaFormatos(p, x) {
  tiposFormato ||= await api("/api/formatos/tipos");
  const elegidos = new Set(local.get("fmt-elegidos") || ["tiktok"]);
  const galeria = h("div", { class: "fmt-grid" });
  let t;
  const recargar = async () => {
    clearTimeout(t);
    if (!modal.open) return;
    const lista = await api(`/api/propuestas/${x.id}/formatos`).catch(() => []);
    galeria.replaceChildren(...(lista.length ? lista.map((f) => tarjetaFormato(f, recargar)) : [h("p", { class: "muted", style: { margin: 0 } }, "Todavía no hay imágenes de esta portada.")]));
    if (lista.some((f) => ["en_cola", "generando"].includes(f.estado))) t = setTimeout(recargar, 4000);
  };
  const casilla = (tf) => h("label", { class: "fmt-op" },
    h("input", { type: "checkbox", checked: elegidos.has(tf.tipo), onchange: (e) => { e.target.checked ? elegidos.add(tf.tipo) : elegidos.delete(tf.tipo); local.set("fmt-elegidos", [...elegidos]); costo(); } }),
    h("span", {}, h("b", {}, tf.nombre), h("small", { class: "muted" }, ` ${tf.ancho}×${tf.alto}`)));
  const costoEl = h("span", { class: "muted", style: { fontSize: ".85rem" } }, "Puedes cerrar esta ventana: Gancho sigue pintando.");
  const crear = h("button", { class: "btn primary", type: "button" });
  const costo = () => {
    crear.disabled = !elegidos.size;
    crear.textContent = elegidos.size ? `Crear ${elegidos.size} ${elegidos.size > 1 ? "imágenes" : "imagen"} · ${elegidos.size * (me.creditosPorImagen || 18)} créditos` : "Elige al menos una";
  };
  costo();
  const grupo = (g, titulo, nota) => h("div", { class: "stack", style: { gap: "6px" } }, h("div", { class: "eyebrow" }, titulo),
    nota ? h("span", { class: "muted", style: { fontSize: ".8rem" } }, nota) : null, tiposFormato.filter((tf) => tf.grupo === g).map(casilla));
  crear.addEventListener("click", async () => {
    crear.disabled = true;
    try { await api(`/api/propuestas/${x.id}/formatos`, { method: "POST", body: { tipos: [...elegidos] } }); toast("Pintando… tardan 1 a 3 minutos"); await recargar(); }
    catch (er) { toast(er.message, true); }
    costo();
  });
  abrirModal(h("h2", {}, "Redes y Prisma Plus"),
    h("p", { class: "muted", style: { margin: 0 } }, `Misma historia y mismos actores que “${x.titulo}”, rediseñada para cada plataforma.`),
    h("div", { class: "grid2" },
      grupo("redes", "Redes", "TikTok con título grande (estilo apps de series), Instagram y Facebook."),
      grupo("prisma", "Prisma Plus", "Póster de cine y banner para la app: fotorrealista, nivel película.")),
    h("div", { class: "row", style: { justifyContent: "space-between" } }, costoEl,
      crear),
    h("div", { class: "eyebrow" }, "Imágenes de esta portada"), galeria,
    h("div", { class: "foot" }, h("button", { class: "btn", type: "button", onclick: cerrarModal }, "Cerrar")));
  modal.classList.add("yt-ancho");
  await recargar();
}

// ================= PRISMA PLUS =================
async function vistaPrisma() {
  const t = navId;
  const caja = h("div", { class: "fmt-grid grande" }, h("div", { class: "vacio" }, h("div", { class: "spin" })));
  const recargar = async () => {
    if (!vigente(t)) return;
    const lista = await api(`/api/prisma${qTodo()}`);
    if (!vigente(t)) return;
    caja.replaceChildren(...(lista.length ? lista.map((f) => tarjetaFormato(f, recargar))
      : [h("div", { class: "vacio" }, h("h2", {}, "Todavía no hay pósters"), h("p", { class: "muted", style: { margin: 0 } },
          "Abre un episodio, en la portada elige “✦ Redes y Prisma Plus” y marca Póster o Banner."))]));
    if (lista.some((f) => ["en_cola", "generando"].includes(f.estado))) poll = setTimeout(recargar, 5000);
  };
  mostrar(
    h("div", { class: "head" }, h("div", {}, h("div", { class: "eyebrow" }, "Prisma Plus"), h("h1", {}, "Pósters y banners de cine para la app")), interruptorEquipo(() => vistaPrisma())),
    caja);
  await recargar();
}

function rehacer(x, recargar) {
  const st = { objetivo: x.propia ? "titulo" : "portada", razones: new Set() };
  const chips = h("div", { class: "chips" });
  const pintarChips = () => {
    const lista = st.objetivo === "titulo" ? RAZONES.titulo : st.objetivo === "portada" ? RAZONES.portada : [...RAZONES.portada, ...RAZONES.titulo];
    for (const r of [...st.razones]) if (!lista.includes(r)) st.razones.delete(r);
    chips.replaceChildren(...lista.map((r) => h("button", { class: "chip", type: "button", "aria-pressed": String(st.razones.has(r)),
      onclick: (e) => { st.razones.has(r) ? st.razones.delete(r) : st.razones.add(r); e.currentTarget.setAttribute("aria-pressed", String(st.razones.has(r))); } }, r)));
  };
  const comentario = h("textarea", { id: "rehacer-comentario", placeholder: "Ej. Que la esposa se vea más destrozada y que el amante sea más joven" });
  const btn = h("button", { class: "btn primary", type: "button", onclick: async () => {
    if (!st.razones.size && !comentario.value.trim()) return toast("Elige una razón o escribe qué cambiarías.", true);
    btn.disabled = true;
    try {
      await api(`/api/propuestas/${x.id}/rehacer`, { method: "POST", body: { objetivo: st.objetivo, razones: [...st.razones], comentario: comentario.value } });
      cerrarModal(); toast("Rehaciendo. Gancho recordará lo que no te gustó."); recargar();
    } catch (e) { toast(e.message, true); btn.disabled = false; }
  } }, "Rehacer con esto");
  pintarChips();
  abrirModal(h("h2", {}, "¿Qué no te gustó?"), h("p", { class: "muted", style: { margin: 0 } }, `"${x.titulo}"`),
    x.propia ? h("p", { class: "muted", style: { margin: 0 } }, "Esta portada la subió el equipo: Gancho solo rehace el título.")
      : h("div", { class: "campo-seg" }, h("span", { class: "etq" }, "¿Qué rehago?"), seg({ portada: "La portada", titulo: "El título", ambos: "Las dos" }, st.objetivo, (v) => { st.objetivo = v; pintarChips(); })),
    h("div", { class: "stack", style: { gap: "8px" } }, h("b", { style: { fontSize: ".88rem" } }, "¿Por qué?"), chips),
    h("label", {}, "¿Qué cambiarías?", h("span", { class: "hint" }, "Entre más concreto, mejor sale la siguiente."), comentario),
    h("div", { class: "foot" }, h("button", { class: "btn ghost", type: "button", onclick: cerrarModal }, "Cancelar"), btn));
}

async function versiones(x, recargar) {
  const vs = await api(`/api/propuestas/${x.id}/versiones`);
  abrirModal(h("h2", {}, "Versiones anteriores"),
    h("div", { class: "versiones" }, vs.map((v) => h("div", { class: "version" },
      v.imagen?.key ? h("img", { src: media(v.imagen.mini || v.imagen.key), alt: "", onclick: () => verGrande(media(v.imagen.key)) }) : h("div", { class: "ph" }),
      h("div", { class: "stack", style: { gap: "6px" } }, h("b", {}, v.data.titulo),
        v.feedback ? h("span", { class: "muted", style: { fontSize: ".82rem" } }, `No gustó (${v.feedback.objetivo}): ${[...(v.feedback.razones || []), v.feedback.comentario].filter(Boolean).join(" · ")}`) : null,
        h("div", {}, h("button", { class: "btn small", type: "button", onclick: async () => {
          try { await api(`/api/propuestas/${x.id}/restaurar`, { method: "POST", body: { versionId: v.id } }); cerrarModal(); toast("Versión restaurada"); recargar(); } catch (e) { toast(e.message, true); }
        } }, "Volver a esta")))))),
    h("div", { class: "foot" }, h("button", { class: "btn ghost", type: "button", onclick: cerrarModal }, "Cerrar")));
}

function paqueteFinal(p) {
  const x = p.propuestas.find((y) => y.id === p.elegida);
  const k = p.paquete;
  if (!x) return null;
  const tags = k.tags.join(", ");
  // Descripción, tags y hashtags se pueden editar a mano y guardar.
  const campos = {};
  const caja = (titulo, valor, extra, editable) => {
    let el;
    if (editable) {
      el = h("textarea", { id: `paq-${editable}`, style: { minHeight: editable === "descripcion" ? "160px" : "70px" } });
      el.value = valor;
      el.addEventListener("input", () => { guardarBtn.disabled = false; editando = true; });
      campos[editable] = el;
    }
    return h("div", { class: "copybox" },
      h("div", { class: "row" }, h("b", {}, titulo), h("div", { class: "row", style: { gap: "8px" } }, extra,
        h("button", { class: "btn small", type: "button", onclick: () => copiar(el ? el.value : valor) }, "Copiar"))),
      el || h("div", { class: "val" }, valor));
  };
  const guardarBtn = h("button", { class: "btn primary", type: "button", disabled: true, onclick: async () => {
    guardarBtn.disabled = true;
    try {
      await api(`/api/episodios/${p.id}/paquete`, { method: "PUT", body: { descripcion: campos.descripcion.value, tags: campos.tags.value, hashtags: campos.hashtags.value } });
      toast("Cambios guardados"); editando = false;
    } catch (e) { toast(e.message, true); guardarBtn.disabled = false; }
  } }, "Guardar cambios");
  const tieneLogo = me.canales.find((c) => c.id === p.canal)?.logo;
  return h("section", { id: "paquete", class: "panel stack", style: { marginTop: "28px", gap: "18px" } },
    h("div", { class: "head", style: { marginBottom: 0 } }, h("div", {}, h("div", { class: "eyebrow" }, "Paquete final"), h("h2", {}, "Listo para subir a YouTube")),
      k.desactualizado ? h("span", { class: "tag warn" }, "Editaste el título: dale \"regenerar textos\"") : null),
    h("div", { class: "final" },
      h("div", { class: "stack" }, h("img", { src: media(x.imagen.key), alt: "Portada elegida", style: { borderRadius: "12px", width: "100%" } }),
        h("div", { class: "row" }, h("button", { class: "btn primary", type: "button", onclick: () => descargar(`/api/episodios/${p.id}/portada.jpg`) }, "Descargar portada 1280×720")),
        h("p", { class: "muted", style: { margin: 0, fontSize: ".82rem" } }, tieneLogo ? "Incluye el logo del canal abajo a la izquierda." : "Este canal no tiene logo. Un administrador lo puede subir en Administración.")),
      h("div", { class: "stack" },
        caja("Título", x.titulo, h("span", { class: "count" }, `${x.titulo.length}/100`)),
        h("div", { class: "copybox" }, h("b", {}, "Títulos para la prueba A/B de YouTube"),
          ...(k.titulos_alternos || []).map((t) => h("div", { class: "row", style: { justifyContent: "space-between", flexWrap: "nowrap" } }, h("div", { class: "val", style: { flex: 1 } }, t), h("button", { class: "btn small", type: "button", onclick: () => copiar(t) }, "Copiar")))),
        caja("Descripción", k.descripcion, null, "descripcion"),
        caja("Tags", tags, h("span", { class: `count${tags.length > 500 ? " warn" : ""}` }, `${tags.length}/500`), "tags"),
        caja("Hashtags", k.hashtags.join(" "), null, "hashtags"),
        h("div", { class: "row", style: { justifyContent: "flex-end" } }, k.editadoAMano ? h("span", { class: "tag" }, "Editado a mano") : null, guardarBtn))));
}

// ================= ACTORES =================
function renombrar(a) {
  const n = h("input", { type: "text", id: "renombrar", placeholder: "Nombre real del actor o actriz" });
  abrirModal(h("h2", {}, "¿Quién es?"), h("p", { class: "muted", style: { margin: 0 } }, `Gancho lo encontró como "${a.nombre}".`), n,
    h("div", { class: "foot" }, h("button", { class: "btn ghost", type: "button", onclick: cerrarModal }, "Cancelar"),
      h("button", { class: "btn primary", type: "button", onclick: async () => {
        if (!n.value.trim()) return toast("Escribe el nombre.", true);
        try { await api(`/api/actores/${a.id}`, { method: "PATCH", body: { nombre: n.value.trim() } }); cerrarModal(); toast("Guardado"); vistaActores(); } catch (e) { toast(e.message, true); }
      } }, "Guardar")));
}
async function vistaActores() {
  const t0 = navId;
  const actores = await api("/api/actores");
  if (!vigente(t0)) return;
  const recargar = () => vistaActores();
  const card = (a) => {
    const input = h("input", { type: "file", accept: "image/jpeg,image/png,image/webp", multiple: true, hidden: true, onchange: async () => {
      const fd = new FormData(); [...input.files].forEach((f) => fd.append("fotos", f));
      try { await api(`/api/actores/${a.id}/fotos`, { method: "POST", form: fd }); toast("Fotos agregadas"); recargar(); } catch (e) { toast(e.message, true); }
    } });
    return h("div", { class: "actor-card" },
      h("div", { class: "row", style: { justifyContent: "space-between" } }, h("b", {}, a.nombre),
        a.auto ? h("span", { class: "tag warn", title: "Gancho lo encontró en un video. Ponle el nombre real." }, "Sin nombre") : null,
        h("span", { class: `tag ${a.n_caras >= 3 ? "ok" : "warn"}`, title: "Caras guardadas en su biblioteca (de fotos y episodios)" }, `${a.n_caras} caras`)),
      a.mejor_cara && !a.fotos.length ? h("img", { src: media(a.mejor_cara), alt: "", style: { width: "96px", borderRadius: "10px" } }) : null,
      a.auto ? h("button", { class: "btn small", type: "button", onclick: () => renombrar(a) }, "Ponerle nombre") : null,
      h("div", { class: "fotos" }, a.fotos.map((k) => h("div", {}, h("img", { src: media(k), alt: "", onclick: () => verGrande(media(k)) }),
        h("button", { type: "button", "aria-label": "Quitar foto", onclick: async () => { try { await api(`/api/actores/${a.id}`, { method: "PATCH", body: { quitarFotos: [k] } }); recargar(); } catch (e) { toast(e.message, true); } } }, "×")))),
      h("div", { class: "row" }, h("button", { class: "btn small", type: "button", onclick: () => input.click() }, "+ Fotos"), input,
        h("button", { class: "btn small ghost danger", type: "button", onclick: () => confirmar(`¿Borrar a ${a.nombre}?`, "Se borran sus fotos. Los episodios ya hechos no cambian.",
          async () => { await api(`/api/actores/${a.id}`, { method: "DELETE" }); recargar(); }, "Sí, borrar") }, "Borrar")));
  };
  mostrar(
    h("div", { class: "head" }, h("div", {}, h("div", { class: "eyebrow" }, "Biblioteca"), h("h1", {}, "Actores")),
      h("button", { class: "btn primary big", type: "button", onclick: () => abrirModal(formNuevoActor(() => { cerrarModal(); recargar(); }),
        h("div", { class: "foot" }, h("button", { class: "btn ghost", type: "button", onclick: cerrarModal }, "Cerrar"))) }, "+ Actor")),
    h("p", { class: "muted", style: { marginTop: 0 } }, "Cada actor junta sus mejores caras de sus fotos y de cada episodio; así Gancho lo reconoce solo y sus portadas se parecen más. Si Gancho encuentra a alguien nuevo, aparece como \"Sin nombre\": ponle su nombre real una vez y listo."),
    actores.length ? h("div", { class: "actores" }, actores.map(card)) : h("div", { class: "vacio" }, h("p", { class: "muted", style: { margin: 0 } }, "Todavía no hay actores.")));
}

// ================= ADMINISTRACIÓN =================
async function vistaAdmin() {
  if (me.rol !== "admin") { location.hash = "#/"; return; }
  const t0 = navId;
  const [uso, usuarios] = await Promise.all([api("/api/admin/uso"), api("/api/admin/usuarios")]);
  if (!vigente(t0)) return;
  const recargar = () => vistaAdmin();
  const hoy = uso.dias.filter((d) => d.dia === new Date().toISOString().slice(0, 10)).reduce((s, d) => s + d.imagenes, 0);
  const porEstado = Object.fromEntries(uso.estados.map((e) => [e.estado, e.n]));
  const portadasQueAlcanzan = uso.creditos != null ? Math.floor(uso.creditos / uso.creditosPorImagen) : null;

  const nuevoUsuario = () => {
    const u = h("input", { type: "text", placeholder: "usuario", id: "nu-usuario" });
    const c = h("input", { type: "password", placeholder: "mínimo 10 caracteres", id: "nu-clave", autocomplete: "new-password" });
    let rol = "editor";
    abrirModal(h("h2", {}, "Nuevo usuario"), h("label", {}, "Usuario", u), h("label", {}, "Contraseña", c),
      h("div", { class: "campo-seg" }, h("span", { class: "etq" }, "Rol"), seg({ editor: "Editor", admin: "Administrador" }, rol, (v) => (rol = v))),
      h("div", { class: "foot" }, h("button", { class: "btn ghost", type: "button", onclick: cerrarModal }, "Cancelar"),
        h("button", { class: "btn primary", type: "button", onclick: async () => {
          try { await api("/api/admin/usuarios", { method: "POST", body: { usuario: u.value, clave: c.value, rol } }); cerrarModal(); toast("Usuario creado"); recargar(); } catch (e) { toast(e.message, true); }
        } }, "Crear")));
  };
  const cambiarClave = (usr) => {
    const c = h("input", { type: "password", placeholder: "mínimo 10 caracteres", autocomplete: "new-password" });
    abrirModal(h("h2", {}, `Nueva contraseña para ${usr.usuario}`), c, h("p", { class: "muted", style: { margin: 0 } }, "Cierra sus sesiones abiertas."),
      h("div", { class: "foot" }, h("button", { class: "btn ghost", type: "button", onclick: cerrarModal }, "Cancelar"),
        h("button", { class: "btn primary", type: "button", onclick: async () => {
          try { await api(`/api/admin/usuarios/${usr.id}`, { method: "PATCH", body: { clave: c.value } }); cerrarModal(); toast("Contraseña cambiada"); } catch (e) { toast(e.message, true); }
        } }, "Guardar")));
  };
  mostrar(
    h("div", { class: "head" }, h("div", {}, h("div", { class: "eyebrow" }, "Administración"), h("h1", {}, "Equipo y gasto"))),
    h("div", { class: "kpis", style: { marginBottom: "28px" } },
      h("div", { class: `kpi${portadasQueAlcanzan != null && portadasQueAlcanzan < 30 ? " alerta" : ""}` }, h("span", { class: "muted" }, "Créditos Nano Banana"), h("b", {}, uso.creditos ?? "?"),
        portadasQueAlcanzan != null ? h("span", { class: "muted", style: { fontSize: ".78rem" } }, `Alcanzan para ≈ ${portadasQueAlcanzan} portadas`) : null),
      h("div", { class: "kpi" }, h("span", { class: "muted" }, "Portadas hoy (equipo)"), h("b", {}, hoy), h("span", { class: "muted", style: { fontSize: ".78rem" } }, `Límite ${me.limites.orgDailyImages}`)),
      h("div", { class: "kpi" }, h("span", { class: "muted" }, "Pintándose ahora"), h("b", {}, (porEstado.generando || 0) + (porEstado.en_cola || 0))),
      h("div", { class: "kpi" }, h("span", { class: "muted" }, "Fallidas (48 h)"), h("b", {}, porEstado.error || 0))),
    h("section", { class: "stack", style: { marginBottom: "28px" } },
      h("div", { class: "row", style: { justifyContent: "space-between" } }, h("h2", {}, "Usuarios"), h("button", { class: "btn", type: "button", onclick: nuevoUsuario }, "+ Usuario")),
      h("div", { class: "tw" }, h("table", {}, h("thead", {}, h("tr", {}, ["Usuario", "Rol", "Estado", ""].map((t) => h("th", {}, t)))),
        h("tbody", {}, usuarios.map((u) => h("tr", {},
          h("td", {}, h("b", {}, u.usuario)),
          h("td", {}, u.rol === "admin" ? "Administrador" : "Editor"),
          h("td", {}, h("span", { class: `tag ${u.activo ? "ok" : "bad"}` }, u.activo ? "Activo" : "Sin acceso")),
          h("td", {}, h("div", { class: "row", style: { gap: "6px" } },
            h("button", { class: "btn small", type: "button", onclick: () => cambiarClave(u) }, "Contraseña"),
            h("button", { class: "btn small", type: "button", onclick: async () => { try { await api(`/api/admin/usuarios/${u.id}`, { method: "PATCH", body: { rol: u.rol === "admin" ? "editor" : "admin" } }); recargar(); } catch (e) { toast(e.message, true); } } }, u.rol === "admin" ? "Hacer editor" : "Hacer admin"),
            h("button", { class: "btn small ghost danger", type: "button", onclick: async () => { try { await api(`/api/admin/usuarios/${u.id}`, { method: "PATCH", body: { activo: !u.activo } }); recargar(); } catch (e) { toast(e.message, true); } } }, u.activo ? "Quitar acceso" : "Dar acceso"))))))))),
    h("section", { class: "stack", style: { marginBottom: "28px" } }, h("h2", {}, "Proveedores de imagen"),
      h("p", { class: "muted", style: { margin: 0 } }, uso.proveedores.length
        ? `Orden: ${uso.proveedores.map((p) => p.nombre).join(" → ")}. Si uno falla, Gancho usa el siguiente y avisa.`
        : "No hay ningún proveedor configurado."),
      uso.proveedores.length < 2 ? h("div", { class: "aviso" }, "Solo hay un proveedor. Agrega GOOGLE_API_KEY o FAL_KEY para tener respaldo si Nano Banana se cae.") : null,
      uso.porProveedor.length ? h("div", { class: "tw" }, h("table", {}, h("thead", {}, h("tr", {}, ["Proveedor (24 h)", "Estado", "Imágenes"].map((t) => h("th", {}, t)))),
        h("tbody", {}, uso.porProveedor.map((r) => h("tr", {}, h("td", {}, { nanobanana: "Nano Banana", google: "Google", fal: "Seedream" }[r.proveedor] || r.proveedor), h("td", {}, r.estado), h("td", { class: "num" }, r.n)))))) : null),
    h("section", { class: "stack" }, h("h2", {}, "Uso de los últimos 14 días"),
      uso.dias.length ? h("div", { class: "tw" }, h("table", {}, h("thead", {}, h("tr", {}, ["Día", "Usuario", "Portadas", "Textos de Claude", "Créditos aprox."].map((t) => h("th", {}, t)))),
        h("tbody", {}, uso.dias.map((d) => h("tr", {}, h("td", { class: "num" }, d.dia), h("td", {}, d.usuario), h("td", { class: "num" }, d.imagenes), h("td", { class: "num" }, d.textos), h("td", { class: "num" }, d.imagenes * uso.creditosPorImagen))))))
        : h("p", { class: "muted" }, "Sin uso todavía.")));
}

// ================= AUTOMÁTICO =================
const ETAPAS = [["en_cola", "En fila"], ["leyendo", "Sacando cuadros"], ["transcribiendo", "Escuchando (máx. 25 min)"], ["caras", "Buscando caras"], ["analizando", "Entendiendo la historia"], ["listo", "Haciendo portadas"]];
function pasosVideo(etapa) {
  const i = ETAPAS.findIndex(([k]) => k === etapa);
  return h("div", { class: "pasos" }, ETAPAS.map(([k, t], j) => h("span", { class: j < i ? "hecho" : j === i ? "ahora" : "" }, j < i ? `✓ ${t}` : t)));
}

let subiendo = null;
// Cerrar o recargar la pestaña mataría una subida de varios GB.
window.addEventListener("beforeunload", (e) => { if (subiendo) { e.preventDefault(); e.returnValue = ""; } });
// Los subtítulos elegidos viven fuera de la vista: el refresco de la lista no los borra.
let subAuto = { texto: null, nombre: "" };
async function vistaAuto() {
  const t = navId;
  const st = local.get("gancho-auto") || { canal: me.canales[0]?.id, notas: "" };
  const guardar = () => local.set("gancho-auto", st);

  const input = h("input", { type: "file", accept: "video/mp4,video/quicktime,video/webm,video/x-matroska,.mp4,.mov,.webm,.mkv,.m4v", multiple: true, hidden: true, onchange: () => subir([...input.files]) });
  const subTxt = h("span", { class: "muted", style: { fontSize: ".85rem" } },
    subAuto.nombre ? `Subtítulos: ${subAuto.nombre}` : me.transcripcion ? "Opcional: Gancho transcribe el audio solo." : "Sin transcripción automática: sube subtítulos o el guion para mejores resultados.");
  const sub = h("input", { type: "file", accept: ".srt,.vtt,.txt", hidden: true, onchange: async () => {
    const f = sub.files[0]; if (!f) return;
    subAuto = { texto: (await f.text()).slice(0, 400000), nombre: f.name }; subTxt.textContent = `Subtítulos: ${f.name}`;
  } });
  const notas = h("input", { type: "text", id: "auto-notas", placeholder: "Notas opcionales para todos estos videos (ej. evitar armas)" });
  notas.value = st.notas || "";
  notas.addEventListener("input", () => { st.notas = notas.value; guardar(); });
  // Hack: recopilación de varios episodios; portada y título solo del 1er episodio.
  const finPrimero = h("input", { type: "text", inputmode: "numeric", placeholder: "Opcional: el 1º termina en (ej. 38:20)", style: { maxWidth: "260px" } });
  const nEpisodios = h("input", { type: "number", min: 2, max: 6, value: st.episodios || 3, style: { width: "70px" }, oninput: () => { st.episodios = Number(nEpisodios.value) || 3; guardar(); } });
  const detallesHack = h("div", { class: "row", style: { gap: "8px" }, hidden: !st.hack }, h("label", { class: "row", style: { gap: "6px" } }, "Episodios en el video", nEpisodios), finPrimero);
  const hack = h("label", { class: "row", style: { gap: "8px", cursor: "pointer" } },
    h("input", { type: "checkbox", checked: Boolean(st.hack), onchange: (e) => { st.hack = e.target.checked; detallesHack.hidden = !st.hack; guardar(); } }),
    h("span", {}, h("b", {}, "Es un hack"), h("span", { class: "muted" }, " · varios episodios en un video: portada y título solo del primero")));
  const progreso = h("div", { class: "stack", style: { gap: "6px", justifyItems: "center" } });
  const listaBox = h("div", {}, h("div", { class: "vacio" }, h("div", { class: "spin" })));

  async function subir(files) {
    if (subiendo) return toast("Espera a que termine la subida actual.", true);
    if (!files.length) return;
    if (!st.canal) return toast("Elige el canal.", true);
    subiendo = true;
    let ok = 0;
    for (const [n, f] of files.entries()) {
      const barraEl = h("i");
      progreso.replaceChildren(h("span", {}, `Subiendo ${n + 1} de ${files.length}: ${f.name}`), h("div", { class: "barra-subida" }, barraEl));
      try {
        const r = await api("/api/auto/subida", { method: "POST", body: { nombre: f.name, tamano: f.size } });
        await new Promise((resolver, rechazar) => {
          const x = new XMLHttpRequest();
          if (r.url) { x.open("PUT", r.url); x.setRequestHeader("Content-Type", r.tipo); }
          else { x.open("PUT", `/api/auto/subida/${r.key}`); x.setRequestHeader("X-Gancho", "1"); x.setRequestHeader("X-Firma", r.firma); }
          x.upload.onprogress = (e) => { if (e.lengthComputable) barraEl.style.width = `${(e.loaded / e.total) * 100}%`; };
          x.onload = () => (x.status < 300 ? resolver() : rechazar(new Error(r.url ? "El almacenamiento rechazó el video. Revisa el CORS del bucket." : "No se pudo subir el video.")));
          x.onerror = () => rechazar(new Error("Se cortó la subida. Revisa tu conexión."));
          x.send(f);
        });
        await api("/api/auto/episodios", { method: "POST", body: { canal: st.canal, key: r.key, nombreArchivo: f.name, notas: st.notas, subtitulos: files.length === 1 ? subAuto.texto : null,
          hack: Boolean(st.hack), episodios: st.episodios || 3, finPrimero: files.length === 1 ? finPrimero.value.trim() : "" } });
        ok++;
      } catch (e) { toast(`${f.name}: ${e.message}`, true); }
    }
    subiendo = null;
    subAuto = { texto: null, nombre: "" };
    progreso.replaceChildren();
    if (ok) toast(`Listo. Gancho ya está viendo ${ok === 1 ? "el video" : `${ok} videos`}.`);
    if (vigente(t)) refrescar();
  }

  const zona = h("div", { class: "subir", tabindex: "0", role: "button", onclick: () => input.click(),
    onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } } },
    h("b", {}, "Suelta aquí el video final del episodio"),
    h("span", { class: "muted" }, "Puedes soltar varios. MP4, MOV, WEBM o MKV · hasta 5 GB cada uno"), progreso);
  zona.addEventListener("dragover", (e) => { e.preventDefault(); zona.classList.add("on"); });
  zona.addEventListener("dragleave", () => zona.classList.remove("on"));
  zona.addEventListener("drop", (e) => { e.preventDefault(); zona.classList.remove("on"); subir([...e.dataTransfer.files]); });

  const estadoItem = (e) => {
    if (e.estado === "error") return h("span", { class: "tag bad" }, "Error");
    if (e.estado === "procesando") return pasosVideo(e.etapa);
    if (["en_cola", "pensando"].includes(e.estado)) return h("span", { class: "tag warn" }, "Haciendo propuestas");
    if (e.eligiendo) return h("span", { class: "tag warn" }, "Escribiendo descripción");
    if (e.aprobacion === "auto" && e.elegida) return h("span", { class: "tag ok" }, "Aprobada sola");
    if (e.elegida) return h("span", { class: "tag ok" }, "Aprobada");
    if (e.aprobacion === "por_aprobar") return h("span", { class: "tag warn" }, "Por aprobar");
    return h("span", { class: "tag" }, "Pintando portadas");
  };
  const mins = (s) => (s ? `${Math.round(s / 60)} min` : "");

  // Solo la lista se refresca; el formulario (notas, subtítulos, foco) no se toca.
  async function refrescar() {
    clearTimeout(poll);
    let lista;
    try { lista = await api(`/api/auto${qTodo()}`); }
    catch { if (vigente(t)) poll = setTimeout(refrescar, 15000); return; }
    if (!vigente(t)) return;
    listaBox.replaceChildren(lista.length ? h("div", { class: "cola" }, lista.map((e) => h("a", { class: "item", href: `#/ep/${e.id}` },
      h("div", { class: "img" }, e.portada ? h("img", { src: media(e.portada), alt: "", loading: "lazy" }) : "Sin portada"),
      h("div", { class: "stack", style: { gap: "6px", minWidth: 0 } },
        h("b", {}, e.titulo),
        h("div", { class: "cifras" }, h("span", {}, canalNombre(e.canal)), chipIdioma(canalIdioma(e.canal)), e.duracion ? h("span", {}, mins(e.duracion)) : null,
          e.fuente === "ninguna" ? h("span", { style: { color: "var(--mid)" } }, "Sin audio transcrito") : null, h("span", {}, `${e.creado_por} · ${fecha(e.actualizado)}`)),
        estadoItem(e), e.error ? h("span", { style: { color: "var(--bad)", fontSize: ".82rem" } }, e.error) : null),
      e.mejor != null ? h("b", { style: { color: colorScore(e.mejor), fontSize: "1.3rem", fontFamily: "var(--display)" } }, e.mejor) : h("span"))))
      : h("div", { class: "vacio" }, h("p", { class: "muted", style: { margin: 0 } }, "Todavía no hay videos.")));
    const ocupado = lista.some((e) => ["procesando", "en_cola", "pensando"].includes(e.estado) || e.eligiendo || (e.estado === "listo" && !e.elegida && e.aprobacion !== "por_aprobar"));
    if (ocupado) poll = setTimeout(refrescar, 6000);
  }

  mostrar(
    h("div", { class: "head" }, h("div", {}, h("div", { class: "eyebrow" }, "Automático"), h("h1", {}, "Sube el video, Gancho hace el resto")),
      h("div", { class: "row" }, interruptorEquipo(() => vistaAuto()), h("a", { class: "btn", href: "#/canales" }, "Reglas por canal"))),
    h("div", { class: "grid2", style: { marginBottom: "28px" } },
      zona,
      h("section", { class: "panel stack" },
        h("div", { class: "campo-seg" }, h("span", { class: "etq" }, "Canal"), seg(opcionesCanal(), st.canal, (v) => { st.canal = v; guardar(); })),
        h("div", { class: "row" }, h("button", { class: "btn small", type: "button", onclick: () => sub.click() }, "Subtítulos o guion"), sub, subTxt),
        notas, hack, detallesHack,
        h("p", { class: "muted", style: { margin: 0, fontSize: ".85rem" } }, "Gancho saca cuadros del video, entiende la historia, toma las caras de los actores y hace 3 portadas. Si el canal tiene aprobación automática y la mejor pasa la calificación, queda lista sola; si no, te avisa para que la apruebes."))),
    h("h2", { style: { marginBottom: "12px" } }, "Videos"),
    listaBox);
  await refrescar();
}

// ================= CANALES =================
async function vistaCanales() {
  const t0 = navId;
  const canales = await api("/api/canales");
  if (!vigente(t0)) return;
  const admin = me.rol === "admin";
  const recargar = async () => { me = null; await cargarMe(); vistaCanales(); };
  mostrar(
    h("div", { class: "head" }, h("div", {}, h("div", { class: "eyebrow" }, "Canales"), h("h1", {}, `${canales.length} canales`)),
      admin ? h("button", { class: "btn primary big", type: "button", onclick: () => editarCanal(null, recargar) }, "+ Canal") : null),
    h("p", { class: "muted", style: { marginTop: 0 } }, "Cada canal tiene su idioma, su voz y sus reglas. Gancho escribe títulos, descripciones y tags en el idioma del canal y te muestra la traducción al español."),
    h("div", { class: "actores" }, canales.map((c) => h("div", { class: "canal-card" },
      h("div", { class: "row", style: { justifyContent: "space-between" } }, h("b", {}, c.nombre), chipIdioma(c.idioma)),
      c.logo_key ? h("img", { class: "logo", src: media(c.logo_key), alt: "Logo" }) : h("span", { class: "muted", style: { fontSize: ".8rem" } }, "Sin logo"),
      h("div", { class: "cifras" }, c.pais ? h("span", {}, c.pais) : null, h("span", {}, me.modelos[c.modelo] || c.modelo),
        h("span", {}, c.auto_aprobar ? `Aprueba sola desde ${c.auto_aprobar}` : "Siempre pide aprobación"), c.webhook_url ? h("span", {}, "Con avisos") : null,
        c.activo ? null : h("span", { style: { color: "var(--bad)" } }, "Desactivado")),
      admin ? h("div", {}, h("button", { class: "btn small", type: "button", onclick: () => editarCanal(c, recargar) }, "Editar")) : null))));
}

function editarCanal(cn, recargar) {
  const st = {
    id: cn?.id || "", nombre: cn?.nombre || "", idioma: cn?.idioma || "es", pais: cn?.pais || "", voz: cn?.voz || "", estilo_visual: cn?.estilo_visual || "",
    ejemplos: (cn?.ejemplos || []).join("\n"), descripcion_fija: cn?.descripcion_fija || "", disclaimer: cn?.disclaimer || "",
    hashtags: (cn?.hashtags_base || []).join(" "), tags_base: (cn?.tags_base || []).join(", "), modelo: cn?.modelo || "nb2",
    auto_aprobar: cn?.auto_aprobar ?? "", webhook_url: cn?.webhook_url || "", activo: cn?.activo ?? true,
  };
  const campos = {};
  const f = (k, label, { area, hint, ph } = {}) => {
    const el = area ? h("textarea", { placeholder: ph || "" }) : h("input", { type: "text", placeholder: ph || "" });
    el.value = st[k]; el.addEventListener("input", () => (st[k] = el.value)); campos[k] = el;
    return h("label", {}, label, hint ? h("span", { class: "hint" }, hint) : null, el);
  };
  const logo = h("input", { type: "file", accept: "image/png", hidden: true, onchange: async () => {
    const fd = new FormData(); fd.append("logo", logo.files[0]);
    try { await api(`/api/admin/canales/${cn.id}/logo`, { method: "POST", form: fd }); toast("Logo guardado"); } catch (e) { toast(e.message, true); }
  } });
  const sugerir = h("button", { class: "btn small", type: "button", onclick: async () => {
    sugerir.disabled = true; sugerir.textContent = "Pensando…";
    try {
      const r = await api("/api/admin/canales/sugerir", { method: "POST", body: { nombre: st.nombre, idioma: st.idioma, pais: st.pais, ejemplos: st.ejemplos } });
      for (const [k, v] of [["voz", r.voz], ["estilo_visual", r.estilo_visual], ["hashtags", r.hashtags.join(" ")], ["tags_base", r.tags_base.join(", ")]]) { st[k] = v; campos[k].value = v; }
      toast("Listo. Revisa y ajusta lo que quieras.");
    } catch (e) { toast(e.message, true); }
    sugerir.disabled = false; sugerir.textContent = "Llenar voz y estilo con Claude";
  } }, "Llenar voz y estilo con Claude");

  abrirModal(
    h("h2", {}, cn ? `Canal: ${cn.nombre}` : "Nuevo canal"),
    h("div", { class: "form-canal" },
      h("div", { class: "dos" }, f("nombre", "Nombre"), cn ? h("label", {}, "Código", h("input", { type: "text", value: cn.id, disabled: true })) : f("id", "Código", { hint: "Corto, sin espacios. Ej. CLAC_PT", ph: "CLAC_EN" })),
      h("div", { class: "dos" }, h("div", { class: "campo-seg" }, h("span", { class: "etq" }, "Idioma"), seg(me.idiomas, st.idioma, (v) => (st.idioma = v))), f("pais", "País del público", { ph: "México, Estados Unidos, Brasil…" })),
      f("ejemplos", "Títulos que le han funcionado", { area: true, hint: "Uno por línea, en el idioma del canal. Gancho los usa como ejemplo." }),
      h("div", {}, sugerir),
      f("voz", "Voz de los títulos", { area: true, hint: "Ej. Primera persona, confesión, traición doble." }),
      f("estilo_visual", "Estilo visual de las portadas", { area: true, hint: "Ej. Sin texto, triángulo, colores saturados, escenarios de Brasil." }),
      f("descripcion_fija", "Texto fijo de la descripción", { area: true }),
      f("disclaimer", "Disclaimer", { area: true }),
      h("div", { class: "dos" }, f("hashtags", "Hashtags fijos", { hint: "Separados por espacio" }), f("tags_base", "Tags base", { hint: "Separados por coma" })),
      h("div", { class: "campo-seg" }, h("span", { class: "etq" }, "Modelo de imagen"), seg(me.modelos, st.modelo, (v) => (st.modelo = v))),
      h("div", { class: "campo-seg" }, h("span", { class: "etq" }, "Aprobación automática"), seg({ "": "Siempre preguntar", 80: "Desde 80", 85: "Desde 85", 90: "Desde 90" }, String(st.auto_aprobar), (v) => (st.auto_aprobar = v)),
        h("span", { class: "hint" }, "Si la mejor portada de un video llega a esa calificación, se aprueba sola y te avisa.")),
      f("webhook_url", "Avisos (webhook)", { hint: "URL de Slack, Google Chat o Discord para avisar cuando haya portadas por aprobar.", ph: "https://hooks.slack.com/services/…" }),
      cn ? h("div", { class: "row" },
        h("button", { class: "btn small", type: "button", onclick: () => logo.click() }, cn.logo_key ? "Cambiar logo (PNG)" : "Subir logo (PNG)"), logo,
        h("button", { class: "btn small", type: "button", onclick: async () => { try { await api(`/api/admin/canales/${cn.id}/probar-aviso`, { method: "POST" }); toast("Aviso enviado"); } catch (e) { toast(e.message, true); } } }, "Probar aviso"),
        h("label", { class: "switch" }, (() => { const c = h("input", { type: "checkbox" }); c.checked = st.activo; c.addEventListener("change", () => (st.activo = c.checked)); return c; })(), "Activo")) : null),
    h("div", { class: "foot" }, h("button", { class: "btn ghost", type: "button", onclick: cerrarModal }, "Cancelar"),
      h("button", { class: "btn primary", type: "button", onclick: async (e) => {
        const b = e.currentTarget; b.disabled = true;
        try {
          await api(`/api/admin/canales/${encodeURIComponent(st.id || cn?.id || "X")}`, { method: "PUT", body: { ...st, nuevo: !cn, auto_aprobar: st.auto_aprobar === "" ? null : Number(st.auto_aprobar) } });
          cerrarModal(); toast("Canal guardado"); recargar();
        } catch (er) { toast(er.message, true); b.disabled = false; }
      } }, "Guardar")));
  modal.classList.add("ancho");
}

ruta();
