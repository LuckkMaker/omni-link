// 验证全局递增颜色序列：各种添加/删除序列下新通道不与现有通道同色
const PALETTE = ['#2563eb', '#16a34a', '#d97706', '#9333ea', '#0891b2', '#dc2626', '#db2777', '#65a30d']
let seq = 0
function makeChannel(varId) { return { varId, color: PALETTE[seq++ % PALETTE.length] } }
function syncChannels(variables, channels) {
  const existing = new Map(channels.map((c) => [c.varId, c]))
  return variables.map((v) => existing.get(v.id) ?? makeChannel(v.id))
}

function run(name, ops) {
  seq = 0
  let variables = [], channels = []
  for (const [op, id] of ops) {
    if (op === 'add') { variables = [...variables, { id }]; channels = syncChannels(variables, channels) }
    else { variables = variables.filter(v => v.id !== id); channels = channels.filter(c => c.varId !== id) }
  }
  const colors = channels.map(c => c.color)
  const dup = new Set(colors).size !== colors.length
  console.log((dup ? 'FAIL' : 'PASS') + ' ' + name + ': ' + channels.map(c => c.varId + ':' + c.color).join(' ') + (dup ? '  <- 重复色!' : ''))
  return !dup
}

let ok = true
ok &= run('添加 ms_cnt,var,s_cnt', [['add','ms_cnt'],['add','var'],['add','s_cnt']])
ok &= run('删 s_cnt 再加', [['add','ms_cnt'],['add','var'],['add','s_cnt'],['del','s_cnt'],['add','s_cnt']])
ok &= run('删 var 再加 (原Bug序列C)', [['add','ms_cnt'],['add','var'],['add','s_cnt'],['del','var'],['add','var']])
ok &= run('删 ms_cnt 再加', [['add','ms_cnt'],['add','var'],['add','s_cnt'],['del','ms_cnt'],['add','ms_cnt']])
ok &= run('反复删加 s_cnt 两次', [['add','ms_cnt'],['add','var'],['add','s_cnt'],['del','s_cnt'],['add','s_cnt'],['del','s_cnt'],['add','s_cnt']])
console.log(ok ? 'RESULT: 所有序列颜色不重复' : 'RESULT: 存在重复色')
