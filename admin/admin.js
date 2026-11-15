import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../config.js";
const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const $ = id => document.getElementById(id);
let meetingId = null;
let existingUnits = new Map();
let codesByCode = new Map();
let meetingTitles = new Map();
let csvParsed = null;
let editingQuestionId = null;

function msg(id, text, error=false) {
  const el=$(id); el.textContent=text; el.className="status"+(error?" error":"");
  el.classList.remove("hidden");
}
function clear(id){$(id).classList.add("hidden");}
async function isAdmin(){
  const {data:{user}}=await db.auth.getUser();
  if(!user) return false;
  const {data,error}=await db.from("admin_users").select("user_id").eq("user_id",user.id).maybeSingle();
  return !error && !!data;
}
async function refreshSession(){
  const {data:{session}}=await db.auth.getSession();
  if(session && await isAdmin()){ $("login").classList.add("hidden"); $("app").classList.remove("hidden"); await loadMeetings(); }
  else { $("login").classList.remove("hidden"); $("app").classList.add("hidden"); }
}
$("loginBtn").onclick=async()=>{
  const {error}=await db.auth.signInWithPassword({email:$("email").value,password:$("password").value});
  if(error){msg("loginMsg",error.message,true);return;}
  if(!(await isAdmin())){await db.auth.signOut();msg("loginMsg","Este usuario no está autorizado como administrador.",true);return;}
  await refreshSession();
};
$("logoutBtn").onclick=async()=>{await db.auth.signOut();meetingId=null;refreshSession();};
async function loadMeetings(){
  const {data,error}=await db.from("voting_meetings").select("*").order("created_at",{ascending:false});
  if(error){msg("globalMsg",error.message,true);return;}
  meetingTitles=new Map(data.map(m=>[m.id,m.title]));
  $("meetingSelect").innerHTML='<option value="">Seleccionar...</option>'+data.map(m=>`<option value="${m.id}">${esc(m.title)} (${m.status})</option>`).join("");
}
function esc(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}

// ---------- Unidades y carga masiva desde CSV ----------
const CSV_ALIASES = {
  unit: ["unidad", "unidadcodigo", "codigounidad", "codunidad", "unidadfuncional", "departamento", "dpto", "unit"],
  label: ["descripcion", "detalle", "label", "descripcionunidad", "nombreunidad", "concepto"],
  weight: ["porcentaje", "participacion", "peso", "weight", "participaciontotal", "porcentajeparticipacion", "alicuota", "pct"],
  voteCode: ["codigovoto", "codigodevoto", "codvoto", "codvotacion", "codigovotacion", "votocode", "grupo", "codigogrupo", "codigocontacto", "contactocodigo"],
  contact: ["contacto", "nombrecontacto", "contactonombre", "propietario", "nombrepropietario"],
  maxVotes: ["maxvotos", "maxvotes", "votosmaximos", "maximodevotos", "max", "votos", "cantidadvotos", "limitevotos"],
  active: ["activo", "active", "habilitado", "habilitada", "vota", "puedevotar", "participa", "estado"],
  // Si el archivo usa solo "codigo", se interpreta como unidad; si además
  // existe "unidad", "codigo" se interpreta como código de voto.
  genericCode: ["codigo", "code", "cod"]
};

function normalizeHeader(value){
  return String(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function detectDelimiter(text){
  const line = text.split("\n").find(l => l.trim()) || "";
  let best = null, bestCount = 0;
  for (const candidate of [";", ",", "\t"]) {
    let count = 0, inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') i++;
        else inQuotes = !inQuotes;
      } else if (ch === candidate && !inQuotes) count++;
    }
    if (count > bestCount) { best = candidate; bestCount = count; }
  }
  return best;
}

function parseDelimited(text, delimiter){
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field); field = "";
    } else if (ch === "\n") {
      row.push(field); rows.push(row); row = []; field = "";
    } else {
      field += ch;
    }
  }
  row.push(field); rows.push(row);
  return rows.filter(r => r.some(v => v.trim() !== ""));
}

function parseCsvNumber(raw, delimiter){
  let s = String(raw ?? "").trim().replace(/[\s%"']/g, "");
  if (!s) return NaN;
  const lastComma = s.lastIndexOf(","), lastDot = s.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) {
    if (lastComma > lastDot) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if (lastComma >= 0) {
    s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, "") : s.replace(",", ".");
  } else if (lastDot >= 0) {
    if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
  }
  return Number(s);
}

function parseCsvBoolean(raw){
  const value = normalizeHeader(raw);
  if (!value) return true;
  if (["si", "s", "1", "true", "verdadero", "x", "activo", "activa", "vota"].includes(value)) return true;
  if (["no", "n", "0", "false", "falso", "inactivo", "inactiva", "novota"].includes(value)) return false;
  return null;
}

function parseUnitsCsv(text){
  const clean = String(text).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const delimiter = detectDelimiter(clean);
  if (!delimiter) return { rows: [], errors: ["No se detectó un separador. Usa punto y coma, coma o tabulador."] };

  const table = parseDelimited(clean, delimiter);
  if (table.length < 2) return { rows: [], errors: ["El CSV debe tener una fila de encabezados y al menos una fila de datos."] };

  const headers = table[0].map(normalizeHeader);
  const idx = {};
  headers.forEach((header, i) => {
    for (const [key, aliases] of Object.entries(CSV_ALIASES)) {
      if (idx[key] === undefined && aliases.includes(header)) idx[key] = i;
    }
  });

  if (idx.unit === undefined && idx.genericCode !== undefined) idx.unit = idx.genericCode;
  if (idx.unit !== undefined && idx.genericCode !== undefined && idx.genericCode !== idx.unit && idx.voteCode === undefined) {
    idx.voteCode = idx.genericCode;
  }

  const errors = [];
  if (idx.unit === undefined) errors.push("Falta la columna 'unidad' (o 'codigo').");
  if (idx.weight === undefined) errors.push("Falta la columna 'porcentaje' (o 'participacion').");
  if (errors.length) return { rows: [], errors };

  const hasVoteCodeColumn = idx.voteCode !== undefined;
  const rows = [], seen = new Map();
  table.slice(1).forEach((cells, n) => {
    const line = n + 2;
    if (cells.length > headers.length) {
      errors.push(`Línea ${line}: tiene ${cells.length} columnas y se esperaban ${headers.length}. Si usas decimales con coma, guarda el CSV separado por punto y coma.`);
      return;
    }
    const unitCode = String(cells[idx.unit] ?? "").trim().toUpperCase();
    const label = String(idx.label !== undefined ? cells[idx.label] ?? "" : "").trim() || unitCode;
    const weight = parseCsvNumber(cells[idx.weight], delimiter);
    let voteCode = String(idx.voteCode !== undefined ? cells[idx.voteCode] ?? "" : "").trim().toUpperCase() || null;
    if (!hasVoteCodeColumn) voteCode = unitCode || null;
    const contact = String(idx.contact !== undefined ? cells[idx.contact] ?? "" : "").trim() || null;
    const maxVotesRaw = idx.maxVotes !== undefined ? String(cells[idx.maxVotes] ?? "").trim() : "";
    const activeRaw = idx.active !== undefined ? String(cells[idx.active] ?? "").trim() : "";
    const maxVotes = maxVotesRaw === "" ? null : Number(maxVotesRaw);
    const active = parseCsvBoolean(activeRaw);

    if (!unitCode) { errors.push(`Línea ${line}: código de unidad vacío.`); return; }
    if (seen.has(unitCode)) { errors.push(`Línea ${line}: unidad ${unitCode} repetida (ya aparece en la línea ${seen.get(unitCode)}).`); return; }
    seen.set(unitCode, line);
    if (!Number.isFinite(weight) || weight < 0) { errors.push(`Línea ${line}: porcentaje inválido ("${cells[idx.weight] ?? ""}").`); return; }
    if (maxVotes !== null && (!Number.isInteger(maxVotes) || maxVotes < 1)) { errors.push(`Línea ${line}: máximo de votos inválido ("${maxVotesRaw}").`); return; }
    if (active === null) { errors.push(`Línea ${line}: valor de activo inválido ("${activeRaw}"). Usa SI o NO.`); return; }

    rows.push({ line, unit_code: unitCode, label, weight, vote_code: voteCode, contact, max_votes: maxVotes, active });
  });

  return { rows, errors };
}

function buildCodeSpecs(rows){
  const specs = new Map();
  for (const row of rows) {
    if (!row.vote_code) continue;
    const spec = specs.get(row.vote_code) || { maxVotes: null, contact: null, units: 0, activeUnits: 0, weight: 0 };
    spec.units++;
    if (row.active) { spec.activeUnits++; spec.weight += row.weight; }
    if (row.max_votes !== null) spec.maxVotes = Math.max(spec.maxVotes || 1, row.max_votes);
    if (!spec.contact && row.contact) spec.contact = row.contact;
    specs.set(row.vote_code, spec);
  }
  return specs;
}

async function readFileText(file){
  const buffer = await file.arrayBuffer();
  let text = new TextDecoder("utf-8").decode(buffer);
  if (text.includes("\uFFFD")) {
    try { text = new TextDecoder("windows-1252").decode(buffer); } catch (_) {}
  }
  return text;
}

function renderCsvPreview(){
  if (!csvParsed) return;
  const { rows, errors } = csvParsed;
  const updates = rows.filter(r => existingUnits.has(r.unit_code)).length;
  const specs = buildCodeSpecs(rows);
  const replacing = $("replaceUnits").checked;
  const parts = [];

  if (rows.length) {
    parts.push(`<div class="status success">${rows.length} unidad(es) válida(s): ${rows.length - updates} nueva(s) y ${updates} que se actualizará(n).</div>`);
  }
  if (specs.size) {
    const detail = [...specs.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([code, spec]) => `<b>${esc(code)}</b>: ${spec.activeUnits} unidad(es) activa(s), ${spec.weight.toFixed(6)}% · máx. ${spec.maxVotes || 1} voto(s)`)
      .join("<br>");
    parts.push(`<div class="status">Códigos de voto en el archivo:<br>${detail}</div>`);
  }
  if (errors.length) {
    const shown = errors.slice(0, 30).map(esc).join("\n");
    parts.push(`<div class="status error">${shown}${errors.length > 30 ? `\n… y ${errors.length - 30} error(es) más.` : ""}</div>`);
  }
  if (rows.length) {
    const shown = rows.slice(0, 100);
    parts.push("<table><tr><th>Línea</th><th>Unidad</th><th>Descripción</th><th>%</th><th>Código de voto</th><th>Activo</th><th>Acción</th></tr>"
      + shown.map(r => `<tr><td>${r.line}</td><td>${esc(r.unit_code)}</td><td>${esc(r.label)}</td><td>${r.weight}</td><td>${r.vote_code ? esc(r.vote_code) : "—"}</td><td>${r.active ? "Sí" : "No"}</td><td>${replacing ? "Reemplaza" : existingUnits.has(r.unit_code) ? "Actualiza" : "Nueva"}</td></tr>`).join("")
      + "</table>"
      + (rows.length > 100 ? `<p class="small">Mostrando las primeras 100 filas de ${rows.length}.</p>` : ""));
  }

  $("csvPreview").innerHTML = parts.join("");
  const importBtn = $("importBtn");
  importBtn.classList.toggle("hidden", rows.length === 0 || errors.length > 0);
  importBtn.textContent = `Importar ${rows.length} unidad(es)`;
}

function reviewCsv(){
  if (!meetingId) return msg("csvMsg", "Primero selecciona o crea una reunión.", true);
  const text = $("csvText").value.trim();
  if (!text) return msg("csvMsg", "Selecciona un archivo o pega el contenido del CSV.", true);
  csvParsed = parseUnitsCsv(text);
  if (!csvParsed.rows.length && csvParsed.errors.length) {
    $("csvPreview").innerHTML = "";
    $("importBtn").classList.add("hidden");
    return msg("csvMsg", "No se pudo importar: corrige los errores que se muestran abajo.", true);
  }
  $("csvMsg").classList.add("hidden");
  renderCsvPreview();
}

$("templateBtn").onclick = () => {
  const csv = "\uFEFFunidad;descripcion;porcentaje;codigo_voto;contacto;max_votos;activo\r\n"
    + "A704;Dpto. 704;0,59;C001;Juan Perez;1;SI\r\n"
    + "E05;Estacionamiento E05;0,20;C001;Juan Perez;1;SI\r\n"
    + "A705;Dpto. 705;0,40;;;1;NO\r\n";
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url; a.download = "plantilla-unidades.csv"; a.click();
  URL.revokeObjectURL(url);
};

$("previewBtn").onclick = reviewCsv;
$("replaceUnits").onchange = () => { if (csvParsed) renderCsvPreview(); };

$("csvFile").onchange = async () => {
  const file = $("csvFile").files?.[0];
  if (!file) return;
  $("csvText").value = await readFileText(file);
  reviewCsv();
};

async function syncVoteCodes(specs){
  const { data: current, error } = await db.from("voting_codes").select("*").eq("meeting_id", meetingId);
  if (error) throw error;
  const map = new Map((current || []).map(c => [c.code, c]));
  const inserts = [], updates = [];

  for (const [code, spec] of specs) {
    const existing = map.get(code);
    if (existing) {
      // Al tener unidades, el peso deja de ser el legado y pasa a calcularse sumando unidades.
      const patch = { weight: 0 };
      if (spec.maxVotes !== null && spec.maxVotes !== undefined) patch.max_votes = spec.maxVotes;
      if (spec.contact) patch.label = spec.contact;
      updates.push({ id: existing.id, patch });
    } else {
      inserts.push({
        meeting_id: meetingId,
        code,
        label: spec.contact || code,
        weight: 0,
        max_votes: spec.maxVotes || 1
      });
    }
  }

  if (inserts.length) {
    const { data, error: insertError } = await db.from("voting_codes").insert(inserts).select("*");
    if (insertError) throw insertError;
    for (const code of data || []) map.set(code.code, code);
  }
  for (const update of updates) {
    const { data, error: updateError } = await db.from("voting_codes").update(update.patch).eq("id", update.id).select("*").single();
    if (updateError) throw updateError;
    map.set(data.code, data);
  }
  return map;
}

async function replaceAllUnits(){
  const { data: questions, error: questionsError } = await db.from("voting_questions").select("id").eq("meeting_id", meetingId);
  if (questionsError) throw questionsError;
  const ids = (questions || []).map(q => q.id);
  if (ids.length) {
    const { count, error } = await db.from("voting_ballots").select("id", { count: "exact", head: true }).in("question_id", ids);
    if (error) throw error;
    if (count > 0) throw new Error("No se pueden reemplazar las unidades porque esta reunión ya tiene votos registrados.");
  }
  const { error: deleteError } = await db.from("voting_units").delete().eq("meeting_id", meetingId);
  if (deleteError) throw deleteError;
}

async function deleteUnusedCodes(){
  const { data: units, error: unitsError } = await db.from("voting_units").select("code_id").eq("meeting_id", meetingId);
  if (unitsError) throw unitsError;
  const used = new Set((units || []).map(u => u.code_id).filter(Boolean));
  const { data: codes, error: codesError } = await db.from("voting_codes").select("id").eq("meeting_id", meetingId);
  if (codesError) throw codesError;
  const unused = (codes || []).filter(c => !used.has(c.id)).map(c => c.id);
  if (!unused.length) return;
  const { error } = await db.from("voting_codes").delete().in("id", unused);
  if (error) throw error;
}

$("importBtn").onclick = async () => {
  if (!meetingId) return msg("csvMsg", "Primero selecciona o crea una reunión.", true);
  if (!csvParsed?.rows.length || csvParsed.errors.length) return;

  const button = $("importBtn");
  button.disabled = true;
  const rows = csvParsed.rows;
  const replace = $("replaceUnits").checked;
  let imported = 0;

  try {
    if (replace) await replaceAllUnits();
    const codes = await syncVoteCodes(buildCodeSpecs(rows));
    const units = rows.map(row => ({
      meeting_id: meetingId,
      unit_code: row.unit_code,
      label: row.label,
      weight: row.weight,
      code_id: row.vote_code ? codes.get(row.vote_code).id : null,
      active: row.active
    }));

    for (let i = 0; i < units.length; i += 500) {
      const batch = units.slice(i, i + 500);
      const { error } = await db.from("voting_units").upsert(batch, { onConflict: "meeting_id,unit_code" });
      if (error) throw error;
      imported += batch.length;
    }
    if (replace) await deleteUnusedCodes();

    msg("csvMsg", `${imported} unidad(es) importadas correctamente.`);
    $("csvMsg").className = "status success";
    csvParsed = null;
    $("csvText").value = "";
    $("csvFile").value = "";
    $("replaceUnits").checked = false;
    $("csvPreview").innerHTML = "";
    $("importBtn").classList.add("hidden");
    await loadUnits();
  } catch (error) {
    msg("csvMsg", error.message, true);
  } finally {
    button.disabled = false;
  }
};

$("createMeetingBtn").onclick=async()=>{
  const title=$("meetingTitle").value.trim(); if(!title)return msg("meetingMsg","Escribe el nombre de la reunión.",true);
  const {data,error}=await db.from("voting_meetings").insert({title}).select().single();
  if(error)return msg("meetingMsg",error.message,true);
  await loadMeetings(); $("meetingSelect").value=data.id; await selectMeeting(data.id);
};
$("meetingSelect").onchange=()=>selectMeeting($("meetingSelect").value);
async function selectMeeting(id){
  meetingId=id||null; $("codesList").innerHTML=""; $("unitsList").innerHTML=""; $("questionsList").innerHTML=""; $("results").innerHTML="";
  existingUnits=new Map(); codesByCode=new Map(); csvParsed=null; editingQuestionId=null;
  $("csvText").value=""; $("csvFile").value=""; $("replaceUnits").checked=false; $("csvPreview").innerHTML=""; $("csvMsg").classList.add("hidden"); $("importBtn").classList.add("hidden");
  if(!meetingId)return;
  await loadUnits(); await loadQuestions();
}
$("addUnitBtn").onclick=async()=>{
  if(!meetingId)return msg("globalMsg","Primero selecciona o crea una reunión.",true);
  const unit_code=$("unitCode").value.trim().toUpperCase();
  const label=$("unitLabel").value.trim()||unit_code;
  const weight=Number($("weight").value);
  const vote_code=$("voteCode").value.trim().toUpperCase();
  const max_votes=Number($("maxVotes").value||1);
  if(!unit_code)return msg("globalMsg","Escribe el código de la unidad.",true);
  if(!Number.isFinite(weight)||weight<0)return msg("globalMsg","Escribe un porcentaje válido.",true);
  if(!Number.isInteger(max_votes)||max_votes<1)return msg("globalMsg","El máximo de votos debe ser un entero mayor o igual a 1.",true);

  try{
    let codeId=null;
    if(vote_code){
      const spec={maxVotes:codesByCode.has(vote_code)?null:max_votes,contact:null};
      const codes=await syncVoteCodes(new Map([[vote_code,spec]]));
      codeId=codes.get(vote_code).id;
    }
    const {error}=await db.from("voting_units").upsert({
      meeting_id:meetingId, unit_code, label, weight, code_id:codeId, active:true
    },{onConflict:"meeting_id,unit_code"});
    if(error)throw error;
    ["unitCode","unitLabel","weight","voteCode"].forEach(id=>$(id).value=""); $("maxVotes").value="1";
    await loadUnits(); msg("globalMsg","Unidad agregada.");
  }catch(error){
    msg("globalMsg",error.message,true);
  }
};
async function loadUnits(){
  const [unitsResult,codesResult]=await Promise.all([
    db.from("voting_units").select("*").eq("meeting_id",meetingId).order("unit_code"),
    db.from("voting_codes").select("*").eq("meeting_id",meetingId).order("code")
  ]);
  const error=unitsResult.error||codesResult.error;
  if(error){
    if(String(error.message).includes("voting_units"))return msg("globalMsg","Falta actualizar la base de datos. Vuelve a ejecutar database.sql en Supabase.",true);
    return msg("globalMsg",error.message,true);
  }

  const units=unitsResult.data||[], codes=codesResult.data||[];
  existingUnits=new Map(units.map(u=>[u.unit_code,u]));
  codesByCode=new Map(codes.map(c=>[c.code,c]));
  const codesById=new Map(codes.map(c=>[c.id,c]));
  const stats=new Map();
  for(const unit of units){
    if(!unit.code_id)continue;
    const stat=stats.get(unit.code_id)||{total:0,active:0,weight:0};
    stat.total++;
    if(unit.active){stat.active++;stat.weight+=Number(unit.weight);}
    stats.set(unit.code_id,stat);
  }

  const codesHtml=codes.length
    ?"<table><tr><th>Código</th><th>Contacto / etiqueta</th><th>Unidades activas</th><th>Peso total (%)</th><th>Votos máx.</th><th>Estado</th></tr>"
      +codes.map(c=>{
        const stat=stats.get(c.id)||{total:0,active:0,weight:0};
        const effective=stat.total===0?Number(c.weight):stat.weight;
        let status="";
        if(stat.total===0)status=Number(c.weight)>0?"Legado (sin unidades)":"Sin unidades";
        else if(stat.active===0)status="Inactivo";
        return `<tr><td>${esc(c.code)}</td><td>${esc(c.label)}</td><td>${stat.active} / ${stat.total}</td><td>${effective.toFixed(6)}</td><td>${c.max_votes}</td><td>${status}</td></tr>`;
      }).join("")+"</table>"
    :'<p class="small">Todavía no hay códigos de voto. Se crean automáticamente al importar unidades con código de voto.</p>';
  $("codesList").innerHTML="<h3>Códigos de voto</h3>"+codesHtml;

  const unitsHtml=units.length
    ?"<table><tr><th>Unidad</th><th>Descripción</th><th>%</th><th>Código de voto</th><th>Estado</th></tr>"
      +units.map(u=>{
        const code=u.code_id?(codesById.get(u.code_id)?.code||"—"):"—";
        const status=!u.active?"Inactiva":u.code_id?"Vota":"No vota";
        return `<tr><td>${esc(u.unit_code)}</td><td>${esc(u.label)}</td><td>${Number(u.weight).toFixed(6)}</td><td>${esc(code)}</td><td>${status}</td></tr>`;
      }).join("")+"</table><p class=\"small\">Para corregir o quitar unidades, reimporta el CSV con la opción de reemplazo.</p>"
    :'<p class="small">Todavía no hay unidades cargadas.</p>';
  $("unitsList").innerHTML="<h3>Unidades registradas</h3>"+unitsHtml;
  if(csvParsed)renderCsvPreview();
}
$("addQuestionBtn").onclick=async()=>{
  if(!meetingId)return msg("globalMsg","Primero selecciona una reunión.",true);
  const question_text=$("question").value.trim();
  const options=$("options").value.split("\n").map(s=>s.trim()).filter(Boolean);
  if(!question_text||options.length<2)return msg("globalMsg","Escribe la pregunta y al menos dos opciones, una por línea.",true);
  const {data:existing}=await db.from("voting_questions").select("position").eq("meeting_id",meetingId).order("position",{ascending:false}).limit(1);
  const position=(existing?.[0]?.position||0)+1;
  const {error}=await db.from("voting_questions").insert({meeting_id:meetingId,question_text,options,status:"draft",position});
  if(error)return msg("globalMsg",error.message,true);
  $("question").value="";$("options").value="";editingQuestionId=null;await loadQuestions();msg("globalMsg","Pregunta guardada como borrador.");
};
function statusLabel(status){
  return status==="draft"?"Borrador":status==="active"?"En votación":"Cerrada";
}
async function ballotCount(questionId){
  const {count,error}=await db.from("voting_ballots").select("id",{count:"exact",head:true}).eq("question_id",questionId);
  if(error)throw error;
  return count||0;
}
async function renumberQuestions(){
  const {data,error}=await db.from("voting_questions").select("id,position").eq("meeting_id",meetingId).order("position").order("created_at");
  if(error)throw error;
  for(let i=0;i<data.length;i++){
    if(data[i].position!==i+1){
      const {error:updateError}=await db.from("voting_questions").update({position:i+1}).eq("id",data[i].id);
      if(updateError)throw updateError;
    }
  }
}
async function loadQuestions(){
  const {data,error}=await db.from("voting_questions").select("*").eq("meeting_id",meetingId).order("position").order("created_at");
  if(error)return msg("globalMsg",error.message,true);
  const html=data.length?data.map(q=>{
    if(q.id===editingQuestionId){
      return `<div class="status question-card"><label>Pregunta</label><textarea id="editQuestionText">${esc(q.question_text)}</textarea><label>Opciones (una por línea)</label><textarea id="editQuestionOptions">${esc(q.options.join("\n"))}</textarea><div class="actions"><button data-action="save" data-id="${q.id}">Guardar cambios</button><button class="secondary" data-action="cancel" data-id="${q.id}">Cancelar</button></div><div id="editQuestionMsg" class="status hidden"></div></div>`;
    }
    const canEdit=q.status==="draft"||q.status==="closed";
    const resetBtn=q.status!=="draft"?`<button class="secondary" data-action="reset" data-id="${q.id}">Reiniciar votación</button>`:"";
    return `<div class="status question-card"><b>${q.position}. ${esc(q.question_text)}</b><br><span class="small">${statusLabel(q.status)}</span><br>${q.options.map(esc).join(" · ")}<div class="actions">${q.status==="draft"?`<button data-action="activate" data-id="${q.id}">Activar</button>`:""}${q.status==="active"?`<button class="danger" data-action="close" data-id="${q.id}">Cerrar votación</button>`:""}${canEdit?`<button class="secondary" data-action="edit" data-id="${q.id}">Editar</button>`:""}${q.status!=="draft"?`<button class="secondary" data-action="results" data-id="${q.id}">Ver resultados</button>`:""}${resetBtn}<button class="danger" data-action="delete" data-id="${q.id}">Eliminar</button></div></div>`;
  }).join(""):'<p class="small">Todavía no hay preguntas.</p>';
  $("questionsList").innerHTML="<h3>Preguntas</h3>"+html;
  $("questionsList").querySelectorAll("button").forEach(b=>b.onclick=()=>questionAction(b.dataset.action,b.dataset.id));
}
async function saveQuestion(id){
  const question_text=$("editQuestionText").value.trim();
  const options=$("editQuestionOptions").value.split("\n").map(s=>s.trim()).filter(Boolean);
  if(!question_text||options.length<2)return msg("editQuestionMsg","Escribe la pregunta y al menos dos opciones, una por línea.",true);
  if(options.length>10)return msg("editQuestionMsg","El máximo es 10 opciones.",true);
  try{
    if(await ballotCount(id)>0)return msg("editQuestionMsg","Esta pregunta ya tiene votos registrados y no se puede editar. Crea una pregunta nueva.",true);
    const {error}=await db.from("voting_questions").update({question_text,options}).eq("id",id);
    if(error)throw error;
    editingQuestionId=null; await loadQuestions(); msg("globalMsg","Pregunta actualizada.");
  }catch(error){
    msg("editQuestionMsg",error.message,true);
  }
}
async function deleteQuestion(id){
  try{
    const {data:question,error}=await db.from("voting_questions").select("id,status").eq("id",id).maybeSingle();
    if(error)throw error;
    if(!question)return msg("globalMsg","La pregunta ya no existe.",true);
    if(await ballotCount(id)>0)return msg("globalMsg","No se puede eliminar: la pregunta ya tiene votos registrados.",true);
    if(!confirm("¿Eliminar esta pregunta? Esta acción no se puede deshacer."))return;
    const {error:deleteError}=await db.from("voting_questions").delete().eq("id",id);
    if(deleteError)throw deleteError;
    if(question.status==="active")await db.from("voting_meetings").update({status:"setup"}).eq("id",meetingId);
    editingQuestionId=null;
    await renumberQuestions();
    await loadQuestions();
    msg("globalMsg","Pregunta eliminada.");
  }catch(error){
    msg("globalMsg",error.message,true);
  }
}
async function resetQuestion(id){
  try{
    const count=await ballotCount(id);
    const detalle=count===0?"Esta pregunta no tiene votos registrados.":`Se eliminarán ${count} voto(s) registrado(s).`;
    const aviso=`${detalle} La pregunta volverá a quedar como borrador para poder editarla y activarla de nuevo. Esta acción no se puede deshacer.\n\n¿Reiniciar la votación?`;
    if(!confirm(aviso))return;
    const {data:deleted,error}=await db.rpc("reset_voting_question",{p_question_id:id});
    if(error)throw error;
    editingQuestionId=null;
    $("results").innerHTML="";
    await loadQuestions();
    msg("globalMsg",`Votación reiniciada: se eliminaron ${deleted||0} voto(s). La pregunta quedó como borrador.`);
  }catch(error){
    const text=String(error.message).includes("reset_voting_question")
      ?"Falta actualizar la base de datos. Vuelve a ejecutar database.sql en Supabase."
      :error.message;
    msg("globalMsg",text,true);
  }
}
async function questionAction(action,id){
  if(action==="edit"){
    try{
      if(await ballotCount(id)>0)return msg("globalMsg","Esta pregunta ya tiene votos registrados y no se puede editar. Crea una pregunta nueva.",true);
    }catch(error){
      return msg("globalMsg",error.message,true);
    }
    editingQuestionId=id;return loadQuestions();
  }
  if(action==="cancel"){editingQuestionId=null;return loadQuestions();}
  if(action==="save")return saveQuestion(id);
  if(action==="delete")return deleteQuestion(id);
  if(action==="reset")return resetQuestion(id);
  if(action==="activate"){
    const {error:closeErr}=await db.from("voting_questions").update({status:"closed"}).eq("meeting_id",meetingId).eq("status","active");
    if(closeErr)return msg("globalMsg",closeErr.message,true);
    const {error}=await db.from("voting_questions").update({status:"active"}).eq("id",id);
    if(error)return msg("globalMsg",error.message,true);
    await db.from("voting_meetings").update({status:"open"}).eq("id",meetingId);
  }
  if(action==="close"){
    const {error}=await db.from("voting_questions").update({status:"closed"}).eq("id",id);
    if(error)return msg("globalMsg",error.message,true);
  }
  await loadQuestions();
  if(action==="results"||action==="close")await showResults(id);
}
async function showResults(id){
  const [result,questionResult]=await Promise.all([
    db.rpc("get_voting_results",{p_question_id:id}),
    db.from("voting_questions").select("question_text,status").eq("id",id).maybeSingle()
  ]);
  if(result.error)return msg("globalMsg",result.error.message,true);
  if(questionResult.error)return msg("globalMsg",questionResult.error.message,true);
  const data=result.data||[];
  const question=questionResult.data;
  const total=data.reduce((s,r)=>s+Number(r.weighted_percentage),0);
  const title=meetingTitles.get(meetingId)||"";
  $("results").innerHTML=`<div class="result-block">`
    +`<p class="small">${esc(title)}</p>`
    +`<h3>${esc(question?.question_text||"Pregunta")}</h3>`
    +`<table><tr><th>Opción</th><th>Votos recibidos</th><th>Participación ponderada (%)</th></tr>`
    +data.map(r=>`<tr><td>${esc(r.option_label)}</td><td>${r.ballots}</td><td>${Number(r.weighted_percentage).toFixed(2)}</td></tr>`).join("")
    +`</table>`
    +`<p><b>Total de participación contabilizada: ${total.toFixed(2)}%</b></p>`
    +(question?`<p class="small">Estado: ${statusLabel(question.status)}</p>`:"")
    +`</div>`;
}
refreshSession();
