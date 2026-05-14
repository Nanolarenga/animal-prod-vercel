const ODOO_URL  = process.env.ODOO_URL;
const ODOO_DB   = process.env.ODOO_DB;
const ODOO_USER = process.env.ODOO_USER;
const ODOO_API_KEY = process.env.ODOO_API_KEY;

async function getUid() {
  const body = `<?xml version="1.0"?>
<methodCall>
  <methodName>authenticate</methodName>
  <params>
    <param><value><string>${ODOO_DB}</string></value></param>
    <param><value><string>${ODOO_USER}</string></value></param>
    <param><value><string>${ODOO_API_KEY}</string></value></param>
    <param><value><struct></struct></value></param>
  </params>
</methodCall>`;
  const res = await fetch(`${ODOO_URL}/xmlrpc/2/common`, {
    method: 'POST', headers: { 'Content-Type': 'text/xml' }, body
  });
  const text = await res.text();
  const match = text.match(/<int>(\d+)<\/int>/);
  if (!match) throw new Error('Auth failed: ' + text.substring(0, 200));
  return parseInt(match[1]);
}

function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function valueToXml(v) {
  if (v === null || v === false) return '<boolean>0</boolean>';
  if (v === true) return '<boolean>1</boolean>';
  if (typeof v === 'number' && Number.isInteger(v)) return `<int>${v}</int>`;
  if (typeof v === 'number') return `<double>${v}</double>`;
  if (typeof v === 'string') return `<string>${esc(v)}</string>`;
  if (Array.isArray(v)) return `<array><data>${v.map(i=>`<value>${valueToXml(i)}</value>`).join('')}</data></array>`;
  if (typeof v === 'object') return `<struct>${Object.entries(v).map(([k,val])=>`<member><name>${k}</name><value>${valueToXml(val)}</value></member>`).join('')}</struct>`;
  return `<string>${esc(String(v))}</string>`;
}

function kwargsToXml(obj) {
  return `<struct>${Object.entries(obj).map(([k,v])=>`<member><name>${k}</name><value>${valueToXml(v)}</value></member>`).join('')}</struct>`;
}

async function callOdoo(model, method, args, kwargs = {}) {
  const uid = await getUid();
  const argsXml = args.map(a=>`<value>${valueToXml(a)}</value>`).join('');
  const body = `<?xml version="1.0"?>
<methodCall>
  <methodName>execute_kw</methodName>
  <params>
    <param><value><string>${ODOO_DB}</string></value></param>
    <param><value><int>${uid}</int></value></param>
    <param><value><string>${ODOO_API_KEY}</string></value></param>
    <param><value><string>${model}</string></value></param>
    <param><value><string>${method}</string></value></param>
    <param><value><array><data>${argsXml}</data></array></value></param>
    <param><value>${kwargsToXml(kwargs)}</value></param>
  </params>
</methodCall>`;
  const res = await fetch(`${ODOO_URL}/xmlrpc/2/object`, {
    method: 'POST', headers: { 'Content-Type': 'text/xml' }, body
  });
  const text = await res.text();
  if (text.includes('<fault>')) {
    const msg = text.match(/<name>faultString<\/name>\s*<value><string>([\s\S]*?)<\/string>/)?.[1] || text.substring(0,300);
    throw new Error('Odoo fault: ' + msg);
  }
  return parseXmlRpc(text);
}

function parseXmlRpc(xml) {
  const pos = { i: 0 };
  const s = xml;
  function skipTo(tag) { const idx = s.indexOf(tag, pos.i); if (idx===-1) return false; pos.i=idx+tag.length; return true; }
  function readUntil(tag) { const idx=s.indexOf(tag,pos.i); if(idx===-1) return ''; const chunk=s.substring(pos.i,idx); pos.i=idx+tag.length; return chunk; }
  function parseValue() {
    const nextLt = s.indexOf('<', pos.i);
    if (nextLt===-1) return null;
    const tagEnd = s.indexOf('>', nextLt);
    const tagName = s.substring(nextLt+1, tagEnd).trim();
    pos.i = tagEnd+1;
    if (tagName==='int'||tagName==='i4'||tagName==='i8') { const v=readUntil(`</${tagName}>`); return parseInt(v.trim()); }
    if (tagName==='double') { const v=readUntil('</double>'); return parseFloat(v.trim()); }
    if (tagName==='boolean') { const v=readUntil('</boolean>'); return v.trim()==='1'; }
    if (tagName==='string') { const v=readUntil('</string>'); return v.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"'); }
    if (tagName==='nil') { pos.i=s.indexOf('</nil>',pos.i)+6; return null; }
    if (tagName==='array') {
      skipTo('<data>');
      const items=[];
      while(true) { const next=s.indexOf('<',pos.i); const peek=s.substring(next,next+8); if(peek.startsWith('</data>')||peek.startsWith('</array')) break; if(peek.startsWith('<value>')) { pos.i=next+7; items.push(parseValue()); skipTo('</value>'); } else break; }
      skipTo('</data>'); skipTo('</array>'); return items;
    }
    if (tagName==='struct') {
      const obj={};
      while(true) { const next=s.indexOf('<',pos.i); const peek=s.substring(next,next+9); if(peek.startsWith('</struct>')) break; if(!peek.startsWith('<member>')) break; pos.i=next+8; skipTo('<name>'); const key=readUntil('</name>'); skipTo('<value>'); obj[key]=parseValue(); skipTo('</value>'); skipTo('</member>'); }
      skipTo('</struct>'); return obj;
    }
    pos.i=nextLt; const val=readUntil('</'+tagName+'>'); return val;
  }
  if (!skipTo('<value>')) return null;
  return parseValue();
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { action, ...params } = req.body;
    let result;

    if (action === 'get_projects') {
      result = await callOdoo('project.project', 'search_read', [[]], {
        fields: ['id','name','task_count','last_update_status','partner_id','user_id'], limit: 100
      });
    }
    else if (action === 'get_tasks') {
      const domain = params.project_id ? [['project_id','=',params.project_id]] : [];
      result = await callOdoo('project.task', 'search_read', [domain], {
        fields: ['id','name','stage_id','user_ids','date_deadline','project_id',
                 'priority','child_ids','subtask_count','date_assign'], limit: 500
      });
    }
    else if (action === 'get_stages') {
      result = await callOdoo('project.task.type', 'search_read', [[]], {
        fields: ['id','name','sequence','fold'], limit: 100
      });
    }
    else {
      return res.status(400).json({ error: 'Acción desconocida' });
    }

    return res.status(200).json({ ok: true, data: result });

  } catch (err) {
    console.error('Odoo error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
