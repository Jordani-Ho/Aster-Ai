import {createHash} from 'node:crypto'
import { createServer } from 'node:http'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createGateway } from '../gateway/server.js'

// Fixed synthetic data, not a prompt. No request body or student text is reflected in the reply.
export const SYNTHETIC_DRAFT = Object.freeze({
  fourExams: { ask: { value: 'SYNTHETIC_EXAM' } },
  judgment: { symptomSummary: { value: 'SYNTHETIC_SUMMARY' }, pattern: { value: 'SYNTHETIC_PATTERN' } },
  plan: { prescription: { value: { items: [{ herb: 'SYNTHETIC_HERB', dose: 'SYNTHETIC_DOSE' }, {herb:'SYNTHETIC_KEEP',dose:'SYNTHETIC_DOSE'}] } }, advice: { value: 'SYNTHETIC_ADVICE' }, homework: [{ title: 'SYNTHETIC_HOMEWORK', detail: 'SYNTHETIC_ONLY', schedule: { kind: 'daily', time: '20:00' }, durationDays: 7 }] },
})
export async function listen(server, port = 0) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve() }) })
  return 'http://127.0.0.1:' + server.address().port
}
export async function closeServer(server) {
  if (!server?.listening) return
  await new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections?.() })
}
export async function startGatewayFixture({ directory, members }) {
  const stats = { upstream: 0, pushes: 0, lastPushText: '' }
  const seedTokenFile=path.join(directory,'seed.json')
  await writeFile(seedTokenFile,JSON.stringify({tokenHash:createHash('sha256').update('SYNTHETIC_DEPLOYMENT_TOKEN').digest('hex')}))
  const membersFile = path.join(directory, 'members.json')
  await writeFile(membersFile, JSON.stringify(members), { mode: 0o600 })
  const upstream = createServer(async (req, res) => {
    if (req.url !== '/v1/chat/completions' || req.method !== 'POST') { res.writeHead(404).end(); return }
    let body = '', size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > 1048576) { res.writeHead(413).end(); return }
      body += chunk
    }
    let stream = false
    try { stream = JSON.parse(body).stream === true } catch { res.writeHead(400).end(); return }
    stats.upstream++
    const parsed=JSON.parse(body)
    const isRevision=parsed.messages?.[0]?.content?.includes('# 老师草稿改稿')
    const instruction=isRevision?JSON.parse(parsed.messages[1].content).instruction:''
    const revision=instruction==='SYNTHETIC_REMOVE_HERB'?{plan:{prescription:{value:{items:[{herb:'SYNTHETIC_KEEP',dose:'SYNTHETIC_DOSE'}]}}}}:{judgment:{symptomSummary:{value:'SYNTHETIC_FINAL_SUMMARY'}}}
    const content = JSON.stringify(isRevision?revision:SYNTHETIC_DRAFT)
    if (stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\ndata: [DONE]\n\n')
    } else {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }))
    }
  })
  let gateway
  try {
    const upstreamUrl = await listen(upstream)
    gateway = createGateway({ membersFile, seedTokenFile, upstreamBaseUrl: upstreamUrl, upstreamModel: 'synthetic-fixture',
      upstreamApiKeyEnv: 'ASTER_E2E_UNUSED_KEY', maxBodyBytes: 1048576, upstreamTimeoutMs: 5000,
      rateLimit: { windowMs: 60000, maxPerWindow: 500 }, logFile: path.join(directory, 'gateway.log'),
      push: { subscriptionsFile: path.join(directory, 'push.json'), send: async (_subscription, text) => { stats.pushes++; stats.lastPushText = text } },
    })
    const url = await listen(gateway)
    return { url, upstreamUrl, stats, async resetMembers(){await writeFile(membersFile,'[]');await writeFile(seedTokenFile,JSON.stringify({tokenHash:createHash('sha256').update('SYNTHETIC_DEPLOYMENT_TOKEN').digest('hex')}))}, async close() { await closeServer(gateway); await closeServer(upstream) } }
  } catch (error) { await closeServer(gateway); await closeServer(upstream); throw error }
}
